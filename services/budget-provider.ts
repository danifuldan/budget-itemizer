import { getConfig } from "./config";

export class BudgetConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BudgetConnectionError";
  }
}

/**
 * Thrown when the budget provider rate-limits us (HTTP 429). Carries
 * an advisory `retryAfterSeconds` so callers can build a Retry-After
 * header / FE cooldown message instead of collapsing into a generic
 * 500. YNAB's SDK doesn't expose response headers on errors so the
 * value is a fixed conservative estimate, but it's honest about the
 * shape of the failure.
 */
export class RateLimitError extends BudgetConnectionError {
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Thrown when subtransaction splits don't sum to the parent transaction
 * total. The previous behavior — silently inserting a "Discount" or
 * "Tax/fees" plug to absorb the gap — fabricated phantom money in
 * categories the user never agreed to. Strong-consistency principle:
 * refuse to import rather than silently misroute funds.
 */
export class ReconciliationError extends Error {
  readonly totalAmount: number;
  readonly splitSum: number;
  readonly remainder: number;
  constructor(totalAmount: number, splitSum: number) {
    const remainder = totalAmount - splitSum;
    // The math is in YNAB milliunits (1000 = $1.00) but the user-facing
    // message must be in dollars — pre-fix surfaced things like "splits
    // sum to -90000 but the transaction total is -100000 (off by -10000)"
    // which is meaningless to a non-developer. Use Math.abs() so the
    // sign isn't presented as confusing-negative for an outflow receipt
    // (the strong-consistency framing is about magnitudes, not direction).
    const fmt = (milliunits: number) => `$${(Math.abs(milliunits) / 1000).toFixed(2)}`;
    super(
      `Receipt totals don't reconcile: splits sum to ${fmt(splitSum)} but the receipt total is ${fmt(totalAmount)} (off by ${fmt(remainder)}). Review the line items and fix any missing or extra amounts before importing.`,
    );
    this.name = "ReconciliationError";
    this.totalAmount = totalAmount;
    this.splitSum = splitSum;
    this.remainder = remainder;
  }
}

/**
 * Compare a receipt's merchant name against a YNAB/Actual payee string.
 * Bank-pushed payees are notoriously noisy ("WAL-MART SUPERCENTER #1234
 * LITTLE ROCK AR", "ZELLE 2092398TY62008 FRED") — exact-string match
 * would miss most real attachments. The fuzzy rule:
 *
 *   1. Take the receipt merchant's principal token (lowercase, strip
 *      trailing TLDs/store-numbers, take the first word).
 *   2. Normalize the payee the same way (lowercase, strip non-alnum).
 *   3. The principal must appear as a substring in the normalized payee.
 *
 * Receipt "Walmart.com"  → principal "walmart"  → matches  "WAL-MART SUPERCENTER #1234"  ✓
 * Receipt "Target"       → principal "target"   → matches  "TARGET 00012345"             ✓
 * Receipt "Fred"         → principal "fred"     → matches  "ZELLE 2092398TY62008 FRED"   ✓
 * Receipt "Walmart"      → principal "walmart"  → no match "STARBUCKS"                   ✗
 *
 * Principal must be ≥3 chars to avoid silly false-positives. Returns
 * false on any null/empty input so the caller can default to "no match
 * → create new transaction."
 */
export const vendorMatches = (
  receiptMerchant: string | null | undefined,
  budgetPayee: string | null | undefined,
): boolean => {
  if (!receiptMerchant || !budgetPayee) return false;
  const principal = receiptMerchant
    .toLowerCase()
    .replace(/\.(com|net|org|io|co|app|store|shop)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)[0];
  if (!principal || principal.length < 3) return false;
  const normalizedPayee = budgetPayee.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalizedPayee.includes(principal);
};

/**
 * Multiset Jaccard similarity between two arrays of split amounts.
 * Used to detect when a budget transaction's existing splits look like
 * the receipt we're about to import (high similarity = same receipt
 * re-imported, safe to overwrite). Inputs should be in the same unit
 * (milliunits or cents, doesn't matter — just consistent).
 *
 *   similarity = |existing ∩ incoming| / |existing ∪ incoming|
 *
 * Multiset semantics: [25, 25] vs [25] has intersection 1, not 2.
 *
 * Empty arrays: both empty → 1.0 (vacuously identical); one empty → 0.
 */
export const splitsSimilarity = (
  existing: readonly number[],
  incoming: readonly number[],
): number => {
  if (existing.length === 0 && incoming.length === 0) return 1;
  if (existing.length === 0 || incoming.length === 0) return 0;
  const existingCounts = new Map<number, number>();
  for (const a of existing) existingCounts.set(a, (existingCounts.get(a) ?? 0) + 1);
  const incomingCounts = new Map<number, number>();
  for (const a of incoming) incomingCounts.set(a, (incomingCounts.get(a) ?? 0) + 1);
  let intersection = 0;
  for (const [val, n] of existingCounts) {
    intersection += Math.min(n, incomingCounts.get(val) ?? 0);
  }
  const union = existing.length + incoming.length - intersection;
  return union === 0 ? 1 : intersection / union;
};

// AccountRef is cross-tier (FE picker consumes the same shape). Single
// source in shared/types; re-exported here so existing service-side
// imports (budget-ynab, account-identity, …) keep their path.
export type { AccountRef } from "../shared/types";
import type { AccountRef } from "../shared/types";

export interface BudgetProvider {
  readonly id: "ynab" | "actual";
  getAllCategories(): Promise<string[]>;
  getAllAccounts(): Promise<AccountRef[]>;
  getAllBudgets(): Promise<{ id: string; name: string }[]>;
  findMatchingTransaction(
    accountId: string,
    amount: number,
    date: string,
    merchant: string,
    /** Optional: amounts (in dollars, positive numbers) of the receipt's
     *  computed splits. Used to compare against a candidate transaction's
     *  existing subtransactions — high similarity is a strong signal of
     *  "same receipt re-imported, safe to overwrite." */
    splitAmounts?: number[],
    /** Optional: per-receipt content fingerprint (SHA-256 of source file
     *  bytes). When present, a candidate whose import_id is one of our
     *  deterministic `BI:`-prefixed IDs but doesn't match THIS receipt's
     *  fingerprint is explicitly NOT a match — two distinct receipts that
     *  happen to share amount+date+merchant can't get conflated. */
    sourceHash?: string,
  ): Promise<{ id: string } | null>;
  updateTransactionWithSplits(
    transactionId: string,
    merchant: string,
    category: string,
    memo: string,
    totalAmount: number,
    splits?: { category: string; amount: number; memo?: string }[],
  ): Promise<void>;
  createTransaction(
    accountId: string,
    merchant: string,
    category: string,
    transactionDate: string,
    memo: string,
    totalAmount: number,
    splits?: { category: string; amount: number; memo?: string }[],
    /** Optional: per-receipt content fingerprint folded into the YNAB
     *  `import_id` so two distinct receipts with the same merchant+date+
     *  amount cannot collide on YNAB's native bank-import dedupe. Same
     *  physical file → same hash → same import_id (idempotent retry still
     *  works). Ignored by providers without an equivalent dedupe key. */
    sourceHash?: string,
  ): Promise<void>;
  testConnection(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ResolvedSplit {
  categoryId: string | undefined;
  amount: number;
  memo?: string;
}

export const buildSubtransactionSplits = (
  totalAmount: number,
  splits: { category: string; amount: number; memo?: string }[],
  resolveCategoryId: (name: string) => string | undefined,
  findTaxCategoryId: () => string | undefined,
): ResolvedSplit[] => {
  const taxCategoryId = findTaxCategoryId();
  const result: ResolvedSplit[] = [];

  for (const split of splits) {
    let categoryId: string | undefined;
    if (split.memo === "Tax/fees") {
      categoryId = taxCategoryId;
    } else if (split.category) {
      categoryId = resolveCategoryId(split.category);
    }
    result.push({ categoryId, amount: split.amount, memo: split.memo });
  }

  const splitSum = splits.reduce((acc, s) => acc + s.amount, 0);
  if (splitSum !== totalAmount) {
    throw new ReconciliationError(totalAmount, splitSum);
  }

  return result;
};

let _cached: BudgetProvider | null = null;
let _cachedType: string = "";

import { YnabBudgetProvider } from "./budget-ynab";
import { ActualBudgetProvider } from "./budget-actual";

export const getBudgetProvider = (): BudgetProvider => {
  const config = getConfig();
  const type = config.budgetProvider || "ynab";
  if (_cached && _cachedType === type) return _cached;
  _cached = type === "actual" ? new ActualBudgetProvider() : new YnabBudgetProvider();
  _cachedType = type;
  return _cached;
};

export const resetBudgetProvider = async () => {
  if (_cached) await _cached.shutdown();
  _cached = null;
  _cachedType = "";
};

// Config fields whose change must drop the cached provider/SDK so the next
// call re-inits against the new config. Editing e.g. actualServerUrl after a
// successful connect otherwise leaves the module-level SDK pinned to the old
// URL/creds until app restart (the connection state is module-level, shared
// across `new ActualBudgetProvider()` instances). Centralized so every route
// that persists config — `/config` AND `/setup/save` — resets on the same
// fields and can't drift (they did: /config reset, /setup/save didn't).
export const PROVIDER_AFFECTING_FIELDS = [
  "budgetProvider",
  "actualServerUrl",
  "actualPassword",
  "actualSyncId",
  "ynabApiKey",
  "ynabBudgetId",
] as const;

export const isProviderAffectingUpdate = (
  updates: Record<string, unknown>,
): boolean => PROVIDER_AFFECTING_FIELDS.some((k) => k in updates);

/** Drop the cached provider iff `updates` touches a provider-identity or
 *  credential field. Call from every route that persists config. */
export const resetBudgetProviderIfAffected = async (
  updates: Record<string, unknown>,
): Promise<void> => {
  if (isProviderAffectingUpdate(updates)) await resetBudgetProvider();
};

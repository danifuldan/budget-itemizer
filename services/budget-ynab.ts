import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as ynab from "ynab";
import env from "../utils/env-vars";
import { getConfig } from "./config";
import {
  BudgetConnectionError,
  RateLimitError,
  buildSubtransactionSplits,
  vendorMatches,
  splitsSimilarity,
  type BudgetProvider,
  type ResolvedSplit,
} from "./budget-provider";
import { writeRestrictedFile, ensureRestrictedDir } from "../utils/restricted-file";

// Lazily create/refresh the YNAB API client so it picks up config changes
// (e.g., after the setup wizard saves a new API key).
let _api: ynab.API | null = null;
let _budgets: ReturnType<ynab.API["budgets"]["withMiddleware"]> | null = null;
let _transactions: ReturnType<ynab.API["transactions"]["withMiddleware"]> | null = null;
let _lastApiKey = "";

const YNAB_TIMEOUT_MS = 30_000;

// Add a timeout to all YNAB SDK requests via pre-middleware that
// injects AbortSignal.timeout into each fetch call's init.
const addTimeout: ynab.Middleware = {
  pre: async (context) => {
    return {
      url: context.url,
      init: { ...context.init, signal: AbortSignal.timeout(YNAB_TIMEOUT_MS) },
    };
  },
};

const ensureClients = () => {
  const config = getConfig();
  const apiKey = config.ynabApiKey || env.YNAB_API_KEY;
  if (!_api || apiKey !== _lastApiKey) {
    _api = new ynab.API(apiKey);
    _budgets = _api.budgets.withMiddleware(addTimeout);
    _transactions = _api.transactions.withMiddleware(addTimeout);
    _lastApiKey = apiKey;
  }
  return { api: _api, budgets: _budgets!, transactions: _transactions! };
};

const getApi = (): ynab.API => ensureClients().api;
const getBudgets = () => ensureClients().budgets;
const getTransactions = () => ensureClients().transactions;

const getBudgetId = () => getConfig().ynabBudgetId || env.YNAB_BUDGET_ID;
const getAllowedCategories = () => {
  const config = getConfig();
  return config.ynabCategoryGroups?.length ? config.ynabCategoryGroups : env.YNAB_CATEGORY_GROUPS;
};

// The `ynab` SDK throws non-Error objects shaped like
// `{ error: { id, name, detail } }`. `String(err)` on those yields
// "[object Object]" — which used to leak straight to the user as
// "YNAB API error: [object Object]" and also defeated the `id`/`name`
// substring checks below. Normalize the shape before sniffing.
const extractYnabErrorParts = (err: unknown): { id?: string; name?: string; detail?: string; raw: string } => {
  if (err && typeof err === "object" && "error" in err) {
    const inner = (err as { error: unknown }).error;
    if (inner && typeof inner === "object") {
      const i = inner as { id?: unknown; name?: unknown; detail?: unknown };
      return {
        id: typeof i.id === "string" ? i.id : undefined,
        name: typeof i.name === "string" ? i.name : undefined,
        detail: typeof i.detail === "string" ? i.detail : undefined,
        raw: typeof i.detail === "string" ? i.detail
          : typeof i.name === "string" ? i.name
          : JSON.stringify(inner),
      };
    }
  }
  if (err instanceof Error) return { raw: err.message };
  return { raw: typeof err === "string" ? err : JSON.stringify(err) };
};

const wrapYnabError = (err: unknown): never => {
  const parts = extractYnabErrorParts(err);
  const msg = parts.raw;
  // Network-layer errors come through as Error.message strings.
  if (
    msg.includes("interceptors did not return") ||
    msg.includes("fetch failed") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("abort")
  ) {
    throw new BudgetConnectionError(
      "Could not connect to YNAB. Check your API key and internet connection in Settings.",
      { cause: err },
    );
  }
  // YNAB-API errors carry id/name fields. Match on those first; fall back
  // to substring matching for cases where the SDK wraps in an Error.
  const id = parts.id ?? "";
  const name = parts.name ?? "";
  if (id === "401" || name.includes("not_authorized") || msg.includes("401") || msg.includes("Unauthorized")) {
    throw new BudgetConnectionError(
      "YNAB API key is invalid or expired. Update it in Settings.",
      { cause: err },
    );
  }
  if (id === "404" || name.includes("not_found") || msg.includes("404")) {
    throw new BudgetConnectionError(
      "YNAB budget not found. Check your budget selection in Settings.",
      { cause: err },
    );
  }
  if (id === "429" || name.includes("too_many_requests")) {
    // YNAB doesn't expose response headers on SDK errors, so we use a
    // conservative 60s default. The minute-level cooldown matches what
    // the FE rate-limit toast was already designed around.
    throw new RateLimitError(
      "YNAB rate limit hit. Wait a few minutes and try again.",
      60,
      { cause: err },
    );
  }
  // Unrecognized YNAB error. Intent-only message — the raw `msg` can
  // include SDK fragments, bundled-binary paths, and stack-trace bits
  // that aren't useful in a UI banner. Preserved on `cause` for logs.
  throw new BudgetConnectionError(
    "YNAB returned an unexpected error. Check Settings, then try again.",
    { cause: err },
  );
};

/**
 * Build category resolver and tax finder from YNAB budget data,
 * then delegate to shared buildSubtransactionSplits.
 */
const buildYnabSubtransactions = (
  budget: ynab.BudgetDetailResponse,
  fixedTotalAmount: number,
  fixedSplits: { category: string; amount: number; memo?: string }[],
): ynab.SaveSubTransaction[] => {
  const categories = budget.data.budget.categories;

  const resolveCategoryId = (name: string): string | undefined => {
    const cat = categories?.find((c) => c.name === name);
    if (!cat) {
      console.warn(`Could not find category ID for ${name}.`);
    }
    return cat?.id;
  };

  const taxNames = ["tax", "taxes", "sales tax", "tax & fees", "fees & taxes"];
  const findTaxCategoryId = (): string | undefined =>
    categories?.find(
      (c) => c && !c.hidden && !c.deleted && taxNames.includes(c.name.toLowerCase()),
    )?.id;

  const resolved = buildSubtransactionSplits(
    fixedTotalAmount,
    fixedSplits,
    resolveCategoryId,
    findTaxCategoryId,
  );

  // Map ResolvedSplit[] to YNAB's SaveSubTransaction[]
  return resolved.map((r) => ({
    amount: r.amount,
    ...(r.categoryId ? { category_id: r.categoryId } : {}),
    memo: r.memo || undefined,
  }));
};

// Cache YNAB categories: per-token limit is 200/hr, and a burst of
// parses without coalescing locks the user out. The in-flight slot
// fans concurrent callers onto a single fetch to avoid the thundering herd.
const CATEGORIES_TTL_MS = 5 * 60 * 1000;
let _categoriesCache: { key: string; value: string[]; expiresAt: number } | null = null;
let _categoriesInFlight: { key: string; promise: Promise<string[]> } | null = null;

const cacheKeyForCategories = (): string =>
  `${getBudgetId()}::${(getAllowedCategories() ?? []).join(",")}`;

// Persistent fallback: the last successful category fetch is stashed to
// disk so that transient YNAB outages (no internet, rate-limit lockout,
// YNAB downtime) don't block parsing. Categories change rarely — a
// list from yesterday is far better than refusing to parse.
const CATEGORIES_DISK_FILE = path.join(
  os.homedir(),
  ".config",
  "budget-itemizer",
  "categories.cache.json",
);

interface DiskCacheEntry {
  key: string;
  value: string[];
  savedAt: string; // ISO timestamp
}

// Tests redirect the disk-cache path here so they don't pollute real config.
const CATEGORIES_DISK_PATH_OVERRIDE: { value: string | null } = { value: null };
const diskFile = (): string => CATEGORIES_DISK_PATH_OVERRIDE.value ?? CATEGORIES_DISK_FILE;

const readDiskCache = (): DiskCacheEntry | null => {
  try {
    const f = diskFile();
    if (!fs.existsSync(f)) return null;
    const parsed = JSON.parse(fs.readFileSync(f, "utf-8"));
    if (typeof parsed?.key !== "string" || !Array.isArray(parsed?.value)) return null;
    return parsed as DiskCacheEntry;
  } catch {
    return null;
  }
};

const writeDiskCache = (entry: DiskCacheEntry): void => {
  try {
    const f = diskFile();
    ensureRestrictedDir(path.dirname(f));
    writeRestrictedFile(f, JSON.stringify(entry, null, 2));
  } catch (err) {
    console.warn("Failed to stash categories to disk:", err);
  }
};

export const _resetCategoriesCacheForTests = () => {
  _categoriesCache = null;
  _categoriesInFlight = null;
  _lastFetchUsedStash = false;
  _onReconnect = null;
};

// Like the full reset but preserves the "previous fetch used stash"
// flag and the reconnect callback. Used in tests that need to force
// the in-memory cache to re-fetch (or expire it across simulated time)
// without clobbering the reconnect-state under test.
export const _expireInMemoryCacheForTests = () => {
  _categoriesCache = null;
  _categoriesInFlight = null;
};

export const _setCategoriesDiskFileForTests = (p: string | null) => {
  CATEGORIES_DISK_PATH_OVERRIDE.value = p;
};

// Reconnect callback: called once when a real YNAB fetch succeeds AFTER
// a previous fetch fell back to the disk stash. Consumers (the watcher)
// use this to revalidate any pending receipts whose category assignments
// were made against an older list — categories may have been renamed
// or deleted upstream while the user was offline.
let _lastFetchUsedStash = false;
let _onReconnect: ((freshCategories: string[]) => void) | null = null;

// Circuit breaker: when YNAB fails AND no disk stash exists for the
// requested key, repeated parses would hammer YNAB once per file. After
// a failure, refuse fresh fetches for an exponentially-growing cooldown
// (1s → 2s → 4s → … capped at 60s). Resets on the next successful fetch.
let _consecutiveFailures = 0;
let _nextAllowedFetchAt = 0;
const FAILURE_COOLDOWN_CAP_MS = 60_000;

export const _resetCircuitBreakerForTests = () => {
  _consecutiveFailures = 0;
  _nextAllowedFetchAt = 0;
};
export const setCategoriesReconnectCallback = (
  cb: ((freshCategories: string[]) => void) | null,
) => {
  _onReconnect = cb;
};

// Pure transform from a YNAB BudgetDetailResponse to a flat list of
// envelope (category) names, applying the configured group filter.
// Top-level so the cached-promise pipeline can `.then(extractEnvelopes)`
// without a `this` reference.
function extractEnvelopes(budget: import("ynab").BudgetDetailResponse): string[] {
  const allowedCategories = getAllowedCategories();
  const visibleCategories = budget.data.budget.categories?.filter(
    (c) => c && !c.hidden && !c.deleted,
  );
  const visibleGroups = budget.data.budget.category_groups?.filter(
    (g) => g && !g.hidden && !g.deleted,
  );

  const envelopes =
    !allowedCategories || allowedCategories.length === 0
      ? visibleCategories?.map((c) => c.name).filter((c) => c)
      : visibleGroups
          ?.filter((g) => allowedCategories.some((ac) => ac === g.name))
          .map((g) => g.id)
          .map((gid) =>
            visibleCategories?.filter((cat) => cat.category_group_id === gid),
          )
          .flat()
          .map((c) => c?.name || "")
          .filter((c) => c);

  if (!envelopes) throw new Error("No envelopes found");
  return envelopes;
}

export class YnabBudgetProvider implements BudgetProvider {
  readonly id = "ynab" as const;

  async getAllCategories(): Promise<string[]> {
    const key = cacheKeyForCategories();
    const now = Date.now();
    if (_categoriesCache && _categoriesCache.key === key && _categoriesCache.expiresAt > now) {
      return _categoriesCache.value;
    }
    // Coalesce concurrent calls onto a single in-flight fetch.
    if (_categoriesInFlight && _categoriesInFlight.key === key) {
      return _categoriesInFlight.promise;
    }
    // Circuit breaker: if we just failed without a stash to fall back
    // on, don't keep slamming YNAB. Try the disk stash one more time
    // (in case it was populated by a different code path) and otherwise
    // throw immediately until cooldown expires.
    if (now < _nextAllowedFetchAt) {
      const stash = readDiskCache();
      if (stash && stash.key === key) {
        _categoriesCache = { key, value: stash.value, expiresAt: now + CATEGORIES_TTL_MS };
        return stash.value;
      }
      throw new BudgetConnectionError(
        "YNAB is unreachable. Waiting before retrying — try again in a minute.",
      );
    }
    const fetchPromise = (async () => {
      const budget = await getBudgets().getBudgetById(getBudgetId());
      return extractEnvelopes(budget);
    })();
    _categoriesInFlight = {
      key,
      promise: fetchPromise.finally(() => {
        if (_categoriesInFlight && _categoriesInFlight.key === key) _categoriesInFlight = null;
      }),
    };
    try {
      const envelopes = await _categoriesInFlight.promise;
      _categoriesCache = { key, value: envelopes, expiresAt: Date.now() + CATEGORIES_TTL_MS };
      // Stash for offline fallback. Synchronous; cheap.
      writeDiskCache({ key, value: envelopes, savedAt: new Date().toISOString() });
      // Reset the circuit breaker on success so the next failure starts
      // its backoff fresh.
      _consecutiveFailures = 0;
      _nextAllowedFetchAt = 0;
      // If the previous fetch fell back to disk, this fresh result means
      // we just reconnected. Pending receipts may have been assigned
      // against the old list — give the watcher a chance to revalidate
      // them. Fire-and-forget so a slow callback doesn't block parsing.
      if (_lastFetchUsedStash) {
        _lastFetchUsedStash = false;
        try { _onReconnect?.(envelopes); } catch (e) {
          console.warn("Reconnect revalidation callback threw:", e);
        }
      }
      return envelopes;
    } catch (err) {
      // YNAB unreachable — try the disk fallback before giving up.
      const stash = readDiskCache();
      if (stash && stash.key === key) {
        console.warn(
          `YNAB fetch failed; using stashed categories from ${stash.savedAt}.`,
        );
        _lastFetchUsedStash = true;
        // Hydrate the in-memory cache so subsequent calls in this session
        // don't keep retrying YNAB (until TTL expires).
        _categoriesCache = { key, value: stash.value, expiresAt: Date.now() + CATEGORIES_TTL_MS };
        return stash.value;
      }
      // No disk fallback — start (or extend) the circuit-breaker cooldown
      // so a burst of receipts doesn't blast 50 YNAB calls in a row.
      _consecutiveFailures += 1;
      const cooldown = Math.min(FAILURE_COOLDOWN_CAP_MS, 1000 * 2 ** (_consecutiveFailures - 1));
      _nextAllowedFetchAt = Date.now() + cooldown;
      // Surface the original error through wrapYnabError.
      wrapYnabError(err);
      throw err; // unreachable; wrapYnabError throws
    }
  }

  async getAllAccounts(): Promise<string[]> {
    const budget = await getBudgets().getBudgetById(getBudgetId()).catch(wrapYnabError);

    const accounts = budget.data.budget.accounts
      ?.filter((a) => !a.deleted && !a.closed)
      .map((a) => a.name);

    if (!accounts) {
      throw new Error("No accounts found");
    }

    return accounts;
  }

  async getAllBudgets(): Promise<{ id: string; name: string }[]> {
    const budgets = await getBudgets().getBudgets().catch(wrapYnabError);
    const sorted = [...budgets.data.budgets].sort((a, b) =>
      (b.last_modified_on || "").localeCompare(a.last_modified_on || ""),
    );
    return sorted.map((b) => ({ id: b.id, name: b.name }));
  }

  async findMatchingTransaction(
    accountName: string,
    amount: number,
    date: string,
    merchant: string,
    splitAmounts?: number[],
  ): Promise<{ id: string } | null> {
    const budgetId = getBudgetId();
    const matchAcrossAccounts = getConfig().matchAcrossAccounts;

    // Convert to milliunits (negative for outflows)
    const targetAmount = Math.round(-amount * 1000);

    // Parse dates as UTC to avoid timezone-dependent shifts.
    const receiptDate = new Date(date + "T00:00:00Z");
    const sinceDate = new Date(receiptDate);
    sinceDate.setUTCDate(sinceDate.getUTCDate() - 3);
    const sinceDateStr = sinceDate.toISOString().split("T")[0];

    let transactions: ynab.TransactionDetail[];

    if (matchAcrossAccounts) {
      const response = await getApi()
        .transactions.getTransactions(budgetId, sinceDateStr)
        .catch(wrapYnabError);
      transactions = response.data.transactions;
    } else {
      const budget = await getBudgets().getBudgetById(budgetId).catch(wrapYnabError);
      const accountId = budget.data.budget.accounts?.find(
        (a) => a.name === accountName,
      )?.id;

      if (!accountId) {
        throw new Error("Account not found");
      }

      const response = await getApi()
        .transactions.getTransactionsByAccount(budgetId, accountId, sinceDateStr)
        .catch(wrapYnabError);
      transactions = response.data.transactions;
    }

    // Resolve the selected account ID for preferred matching
    let selectedAccountId: string | undefined;
    if (matchAcrossAccounts) {
      const budget = await getBudgets().getBudgetById(budgetId).catch(wrapYnabError);
      selectedAccountId = budget.data.budget.accounts?.find(
        (a) => a.name === accountName,
      )?.id;
    }

    // Filter: exact amount match, date within ±3 days, not deleted.
    // Vendor is intentionally NOT a hard filter — bank payees can be
    // abbreviated in ways our fuzzy matcher misses (Amazon→AMZN,
    // McDonald's→MCD). Excluding non-vendor-matching candidates here
    // would force the user to manually merge every receipt for those
    // merchants. Vendor still informs the tiebreaker below.
    const candidates = transactions.filter((t) => {
      if (t.deleted) return false;
      if (t.amount !== targetAmount) return false;

      const txDate = new Date(t.date + "T00:00:00Z");
      const diffDays = Math.abs(
        (txDate.getTime() - receiptDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (diffDays > 3) return false;

      return true;
    });

    if (candidates.length === 0) return null;

    // Convert incoming receipt splits to milliunits to match the
    // candidate transactions' subtransaction.amount units. Sign is
    // negated to match YNAB's outflow convention.
    const incomingSplitMilliunits = splitAmounts
      ? splitAmounts.map((a) => Math.round(-a * 1000))
      : [];

    // Pick the most-likely candidate using a tiered cascade. No refusal —
    // we always pick if any candidate is eligible. The tier system:
    //
    //   TIER 0: candidate's existing splits closely resemble the
    //           receipt we're importing (similarity ≥ 0.95). Almost
    //           certainly a re-import; overwrite is idempotent.
    //   TIER 1: candidate has no existing splits — safe to attach,
    //           no prior data to lose.
    //   TIER 2: candidate has existing splits with partial overlap
    //           (0.5 ≤ similarity < 0.95). Likely the same receipt
    //           that was edited, or close to it.
    //   INELIGIBLE: candidate has existing splits with < 0.5
    //           similarity — overwriting would destroy unrelated
    //           prior import data; skip.
    //
    // Within a tier, sub-rank by: vendor match (yes > no),
    // splits-similarity (higher better), closest date, freshness
    // (uncleared > cleared > reconciled), unapproved, no-memo.
    const resolveMostLikely = (pool: ynab.TransactionDetail[]): ynab.TransactionDetail | null => {
      const scored = pool.map((t) => {
        const txDate = new Date(t.date + "T00:00:00Z");
        const diffMs = Math.abs(txDate.getTime() - receiptDate.getTime());
        const vendorMatch = vendorMatches(merchant, t.payee_name) ? 1 : 0;
        const existingAmounts = (t.subtransactions ?? [])
          .filter((s) => !s.deleted)
          .map((s) => s.amount);
        const hasSplits = existingAmounts.length > 0;
        const similarity = hasSplits
          ? splitsSimilarity(existingAmounts, incomingSplitMilliunits)
          : 1;
        let tier: number;
        if (hasSplits && similarity >= 0.95) tier = 0;
        else if (!hasSplits) tier = 1;
        else if (similarity >= 0.5) tier = 2;
        else tier = 99; // ineligible
        const freshness = t.cleared === "uncleared" ? 2 : t.cleared === "cleared" ? 1 : 0;
        const unapproved = t.approved ? 0 : 1;
        const noMemo = (t.memo ?? "").trim().length === 0 ? 1 : 0;
        return { t, tier, vendorMatch, similarity, diffMs, freshness, unapproved, noMemo };
      });
      const eligible = scored.filter((s) => s.tier !== 99);
      if (eligible.length === 0) return null;
      eligible.sort(
        (a, b) =>
          a.tier - b.tier ||
          b.vendorMatch - a.vendorMatch ||
          b.similarity - a.similarity ||
          a.diffMs - b.diffMs ||
          b.freshness - a.freshness ||
          b.unapproved - a.unapproved ||
          b.noMemo - a.noMemo,
      );
      return eligible[0].t;
    };

    if (matchAcrossAccounts && selectedAccountId) {
      // Prefer the user's selected account; fall through to other
      // accounts if no candidate in the selected one. Tiebreak applies
      // within whichever pool we end up using.
      const inSelected = candidates.filter((t) => t.account_id === selectedAccountId);
      if (inSelected.length > 0) return resolveMostLikely(inSelected);
    }

    return resolveMostLikely(candidates);
  }

  async updateTransactionWithSplits(
    transactionId: string,
    merchant: string,
    category: string,
    memo: string,
    totalAmount: number,
    splits?: { category: string; amount: number; memo?: string }[],
  ): Promise<void> {
    const fixedTotalAmount = Math.round(-totalAmount * 1000);
    const fixedSplits = splits?.map((split) => ({
      category: split.category,
      amount: Math.round(-split.amount * 1000),
      memo: split.memo,
    }));

    const budget = await getBudgets().getBudgetById(getBudgetId());

    const subtransactions: ynab.SaveSubTransaction[] = fixedSplits
      ? buildYnabSubtransactions(budget, fixedTotalAmount, fixedSplits)
      : [];

    let categoryId: string | undefined;
    if (subtransactions.length <= 1) {
      categoryId = budget.data.budget.categories?.find(
        (c) => c.name === category,
      )?.id;

      if (!categoryId) {
        throw new Error("Category not found");
      }
    }

    await getTransactions().updateTransaction(getBudgetId(), transactionId, {
      transaction: {
        category_id: subtransactions.length > 1 ? null : categoryId,
        payee_name: merchant,
        memo: subtransactions.length > 1 ? undefined : memo,
        approved: false,
        subtransactions: subtransactions.length > 1 ? subtransactions : undefined,
      },
    });
  }

  async createTransaction(
    accountName: string,
    merchant: string,
    category: string,
    transactionDate: string,
    memo: string,
    totalAmount: number,
    splits?: { category: string; amount: number; memo?: string }[],
  ): Promise<void> {
    const fixedTotalAmount = Math.round(-totalAmount * 1000);
    const fixedSplits = splits?.map((split) => ({
      category: split.category,
      amount: Math.round(-split.amount * 1000),
      memo: split.memo,
    }));

    const budget = await getBudgets().getBudgetById(getBudgetId());

    const accountId = budget.data.budget.accounts?.find(
      (a) => a.name === accountName,
    )?.id;

    if (!accountId) {
      throw new Error("Account not found");
    }

    const subtransactions: ynab.SaveSubTransaction[] = fixedSplits
      ? buildYnabSubtransactions(budget, fixedTotalAmount, fixedSplits)
      : [];

    let categoryId: string | undefined;
    if (subtransactions.length <= 1) {
      categoryId = budget.data.budget.categories?.find(
        (c) => c.name === category,
      )?.id;

      if (!categoryId) {
        throw new Error("Category not found");
      }
    }

    await getTransactions().createTransaction(getBudgetId(), {
      transaction: {
        account_id: accountId,
        amount: fixedTotalAmount,
        category_id: categoryId,
        date: transactionDate,
        payee_name: merchant,
        approved: false,
        memo: subtransactions.length > 1 ? undefined : memo,
        subtransactions: subtransactions.length > 1 ? subtransactions : undefined,
      },
    });
  }

  async testConnection(): Promise<void> {
    await getBudgets().getBudgets().catch(wrapYnabError);
  }

  async shutdown(): Promise<void> {
    // Reset memoized state so the next provider instance starts fresh
    // — used when config switches budgets or providers.
    _categoriesCache = null;
  }
}

/**
 * Legacy export: standalone retrieveSubtransactions function for backward
 * compatibility with tests. Delegates to the shared utility.
 */
export const retrieveSubtransactions = (
  budget: ynab.BudgetDetailResponse,
  fixedTotalAmount: number,
  fixedSplits: { category: string; amount: number; memo?: string }[],
): ynab.SaveSubTransaction[] => {
  return buildYnabSubtransactions(budget, fixedTotalAmount, fixedSplits);
};

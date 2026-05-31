import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Agent, Dispatcher, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import type { TransactionEntity } from "@actual-app/api/@types/loot-core/src/types/models";
import { getConfig } from "./config";
import {
  BudgetConnectionError,
  buildSubtransactionSplits,
  vendorMatches,
  splitsSimilarity,
  type BudgetProvider,
} from "./budget-provider";

// Actual Budget stores some names with non-breaking spaces (U+00A0) — normalize to regular spaces
const normalizeSpaces = (s: string) => s.replace(/\u00A0/g, " ");

// @actual-app/api expects browser globals — polyfill before first import.
//
// @actual-app/api is NOT bundled into the pkg single-file binary: it pulls
// in better-sqlite3 (a native .node addon that can't live in the pkg
// snapshot — `bindings` searches the real fs) and loads migrations +
// default-db.sqlite from disk via __dirname. So it ships as REAL
// node_modules in the .app and is required from a real path at runtime.
// The eval() forms below keep the specifier opaque to BOTH esbuild and
// pkg so neither inlines it (which would drag better-sqlite3 back into
// the snapshot). In dev (tsx/ESM) it's a normal dynamic import from
// node_modules. REAL_MODULES overrides the location for build:server
// testing without the full .app.
type ActualApi = typeof import("@actual-app/api");
let _api: ActualApi | null = null;
const loadApi = async (): Promise<ActualApi> => {
  if (_api) return _api;
  if (typeof globalThis.navigator === "undefined") {
    (globalThis as unknown as { navigator: { platform: string; userAgent: string } }).navigator = { platform: "linux", userAgent: "" };
  }
  // PKG_BUNDLED is defined ("1") only by build-server.mjs's esbuild step.
  // In the pkg binary that branch is live; esbuild dead-code-eliminates
  // the dev `import("@actual-app/api")` below so it never lands in the
  // snapshot (which would drag better-sqlite3 back in). In dev/tests
  // PKG_BUNDLED is undefined → the static import runs and vitest can mock it.
  if (process.env.PKG_BUNDLED) {
    const realModules =
      process.env.REAL_MODULES ||
      path.join(path.dirname(process.execPath), "..", "Resources", "server-modules", "node_modules");
    const realRequire = eval("require") as NodeRequire;
    _api = realRequire(path.join(realModules, "@actual-app", "api")) as ActualApi;
  } else {
    _api = await import("@actual-app/api");
  }
  return _api;
};

const DATA_DIR = path.join(os.homedir(), ".config", "budget-itemizer", "actual-data");

/** Route Actual-server-prefixed requests to the `insecure` dispatcher
 *  (self-signed-cert tolerant); everything else uses the default. */
export function makeScopedDispatcher(
  trustedPrefix: string,
  insecure: Agent,
  fallback: Dispatcher,
): Dispatcher {
  return {
    dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
      const target = `${opts.origin ?? ""}${opts.path ?? ""}`;
      const dispatcher = target.startsWith(trustedPrefix) ? insecure : fallback;
      return dispatcher.dispatch(opts, handler);
    },
    async close() {
      await insecure.close();
    },
    async destroy() {
      await insecure.destroy();
    },
  } as unknown as Dispatcher;
}

let _serverConnected = false;
let _budgetLoaded = false;
// Singleton init promise. Without this, two concurrent callers (e.g.,
// /setup/test-actual racing the watcher's first import) can both enter
// the TLS save/restore block: caller A saves `originalTlsReject = undefined`,
// sets "0"; caller B reads "0" as the "original" and saves THAT; A
// restores undefined; B restores "0" — net: env var permanently "0",
// defeating the entire scoping fix this block exists to provide.
let _initPromise: Promise<void> | null = null;
// Dispatcher in place before we installed the scoped self-signed one,
// kept so shutdown() can restore strict TLS. The scoped dispatcher stays
// installed for the whole connection (see ensureServer); restoring it
// right after init — the original behavior — broke every post-login call
// (list-user-files, /sync, accounts) against a self-signed or
// hostname-mismatched cert, silently yielding an empty budget list.
let _previousDispatcher: Dispatcher | null = null;

const ensureServer = async () => {
  if (_serverConnected) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const config = getConfig();
    if (!config.actualServerUrl || !config.actualPassword) {
      throw new BudgetConnectionError(
        "Actual Budget server URL and password are required. Update them in Settings.",
      );
    }
    // Allow self-signed TLS scoped to the configured actualServerUrl
    // only; all other outbound TLS retains full verification.
    const isHttps = config.actualServerUrl.startsWith("https");
    const previousDispatcher = isHttps ? getGlobalDispatcher() : null;
    if (isHttps) {
      // Self-hosted Actual deployments commonly use self-signed certs.
      // The relaxed TLS is scoped to the user's own actualServerUrl
      // via the makeScopedDispatcher router below — other outbound
      // handshakes (YNAB, HuggingFace) keep full cert validation.
      // Audited 2026-05-12.
      // nosemgrep
      const insecure = new Agent({ connect: { rejectUnauthorized: false } });
      const scopedDispatcher = makeScopedDispatcher(
        config.actualServerUrl,
        insecure,
        previousDispatcher!,
      );
      setGlobalDispatcher(scopedDispatcher);
      _previousDispatcher = previousDispatcher;
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const api = await loadApi();
      await api.init({
        dataDir: DATA_DIR,
        serverURL: config.actualServerUrl,
        password: config.actualPassword,
      });
      _serverConnected = true;
    } catch (err) {
      // Init failed — restore strict TLS so an abandoned connection
      // doesn't leave the scoped relaxation installed.
      if (isHttps && previousDispatcher) {
        setGlobalDispatcher(previousDispatcher);
        _previousDispatcher = null;
      }
      if (err instanceof BudgetConnectionError) throw err;
      // Intent-only message — the SDK's err.message can leak internal
      // /snapshot/ paths from the pkg-bundled node_modules, stack
      // fragments, or other implementation detail that ends up in the
      // UI banner. The underlying error is preserved on `cause` for
      // log inspection.
      throw new BudgetConnectionError(
        "Could not connect to Actual Budget server. Check the server URL and password in Settings.",
        { cause: err },
      );
    }
    // On success the scoped dispatcher stays installed for the whole
    // session — the SDK opens new connections after init (list-user-files,
    // /sync, accounts) that must also reach the self-signed origin.
    // Restored in shutdown() (or on init failure above).
  })();

  try {
    await _initPromise;
  } finally {
    // Clear so a failed init doesn't trap subsequent callers in a cached rejection.
    _initPromise = null;
  }
};

const ensureBudget = async () => {
  await ensureServer();
  if (_budgetLoaded) return;
  const config = getConfig();
  if (!config.actualSyncId) {
    throw new BudgetConnectionError(
      "No Actual Budget selected. Choose a budget in Settings.",
    );
  }
  try {
    const api = await loadApi();
    await api.downloadBudget(config.actualSyncId);
    _budgetLoaded = true;
  } catch (err) {
    if (err instanceof BudgetConnectionError) throw err;
    throw new BudgetConnectionError(
      "Could not load the selected Actual budget. Confirm the sync ID is correct in Settings.",
      { cause: err },
    );
  }
};

const TAX_NAMES = ["tax", "taxes", "sales tax", "tax & fees", "fees & taxes"];

const findOrCreatePayee = async (name: string): Promise<string> => {
  const api = await loadApi();
  const payees = await api.getPayees();
  const existing = payees.find(
    (p) => normalizeSpaces(p.name).toLowerCase() === name.toLowerCase(),
  );
  if (existing) return existing.id;
  return await api.createPayee({ name });
};

export class ActualBudgetProvider implements BudgetProvider {
  readonly id = "actual" as const;

  async getAllCategories(): Promise<string[]> {
    await ensureBudget();
    const api = await loadApi();
    const categories = await api.getCategories();
    return categories
      .filter((c) => !c.is_income && !c.hidden)
      .map((c) => normalizeSpaces(c.name));
  }

  async getAllAccounts(): Promise<{ id: string; name: string }[]> {
    await ensureBudget();
    const api = await loadApi();
    const accounts = await api.getAccounts();
    return accounts
      .filter((a) => !a.closed && !a.offbudget)
      .map((a) => ({ id: a.id, name: normalizeSpaces(a.name) }));
  }

  async getAllBudgets(): Promise<{ id: string; name: string }[]> {
    await ensureServer();
    const api = await loadApi();
    const budgets = await api.getBudgets();
    // api.getBudgets() lists each budget once per *presence state*, not once
    // per budget: a local entry (downloaded into DATA_DIR — has an on-disk
    // `id` like "My-Finances-0007c45", no `state`) AND a `state: "remote"`
    // entry for the same budget on the server. Both carry the same `groupId`
    // — which is the sync id we persist in config.actualSyncId and pass to
    // downloadBudget(). Collapse on that identity so the Settings dropdown
    // shows one row per budget, not one per local/remote copy. The exposed
    // `id` MUST stay the groupId (never the on-disk `id`): selecting a row
    // writes it to actualSyncId, and downloadBudget only accepts the syncId.
    const byId = new Map<string, { id: string; name: string }>();
    for (const b of budgets) {
      const id =
        (b as { groupId?: string; syncId?: string; id?: string }).groupId ||
        (b as { syncId?: string }).syncId ||
        b.id ||
        "";
      if (!id || byId.has(id)) continue;
      byId.set(id, { id, name: b.name });
    }
    return [...byId.values()];
  }

  async findMatchingTransaction(
    accountId: string,
    amount: number,
    date: string,
    merchant: string,
    splitAmounts?: number[],
    // Actual has no native bank-import dedupe key, so the fingerprint is
    // accepted to satisfy the BudgetProvider contract but unused here.
    // The YNAB-specific overwrite/silent-drop pathology doesn't apply.
    _sourceHash?: string,
  ): Promise<{ id: string } | null> {
    await ensureBudget();
    const api = await loadApi();
    // Pull the server's latest BEFORE matching. ensureBudget short-circuits
    // once the budget is loaded (no re-sync), so without this the matcher
    // reads a STALE local copy and misses transactions added in Actual after
    // load (bank feed, the web app, another device) — returning "no match" and
    // creating a DUPLICATE. (Found 2026-05-30; Actual has no import_id
    // backstop like YNAB, so the heuristic match is the only guard.) Best-
    // effort: if the pull fails (offline), match against the local copy rather
    // than failing the whole import.
    try {
      await api.sync();
    } catch (err) {
      console.warn(
        "[actual] pre-match sync failed; matching against local copy may miss recent transactions:",
        err,
      );
    }
    const config = getConfig();
    const targetAmount = Math.round(-amount * 100);

    const receiptDate = new Date(date + "T00:00:00Z");
    const sinceDate = new Date(receiptDate);
    sinceDate.setUTCDate(sinceDate.getUTCDate() - 3);
    const sinceDateStr = sinceDate.toISOString().split("T")[0];
    const untilDate = new Date(receiptDate);
    untilDate.setUTCDate(untilDate.getUTCDate() + 3);
    const untilDateStr = untilDate.toISOString().split("T")[0];

    const accounts = await api.getAccounts();
    const onBudgetAccounts = accounts.filter(
      (a) => !a.closed && !a.offbudget,
    );

    let searchAccounts: typeof onBudgetAccounts;
    if (config.matchAcrossAccounts) {
      searchAccounts = onBudgetAccounts;
    } else {
      const account = onBudgetAccounts.find(
        (a) => a.id === accountId,
      );
      if (!account) throw new Error("Account not found");
      searchAccounts = [account];
    }

    const selectedAccount = onBudgetAccounts.find(
      (a) => a.id === accountId,
    );

    // Actual stores `payee` on transactions as an ID; resolve to name
    // up front so the vendor signal is available for the tiebreaker.
    // Vendor is intentionally NOT a hard filter — bank payees can be
    // abbreviated in ways our fuzzy matcher misses (Amazon→AMZN). Still
    // informs the tiebreak below so when both a vendor-matching and
    // non-matching candidate exist, the vendor-matching one wins.
    const payees = await api.getPayees();
    const payeeName = new Map<string, string>();
    for (const p of payees) payeeName.set(p.id, p.name);

    // Convert incoming receipt splits to Actual's cents to match the
    // candidate transactions' subtransaction.amount units.
    const incomingSplitCents = splitAmounts
      ? splitAmounts.map((a) => Math.round(-a * 100))
      : [];

    type Candidate = {
      tx: TransactionEntity;
      tier: number;
      vendorMatch: number;
      similarity: number;
      diffMs: number;
      freshness: number;
      unapproved: number;
      noMemo: number;
      isPreferred: boolean;
    };
    let allCandidates: Candidate[] = [];

    for (const account of searchAccounts) {
      const transactions = await api.getTransactions(
        account.id,
        sinceDateStr,
        untilDateStr,
      );
      for (const tx of transactions) {
        if (tx.amount !== targetAmount) continue;
        const txDate = new Date(tx.date + "T00:00:00Z");
        const diffMs = Math.abs(txDate.getTime() - receiptDate.getTime());
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        if (diffDays > 3) continue;
        const payeeStr = tx.payee ? payeeName.get(tx.payee) : null;
        const vendorMatch = vendorMatches(merchant, payeeStr) ? 1 : 0;
        // Actual's transactions may include sub-array as `subtransactions`
        // (split rows) — same shape as YNAB's. Filter deleted. The `deleted`
        // field isn't on the SDK's TransactionEntity but Actual's runtime
        // sometimes attaches it on dehydrated rows; cast at the access.
        const existingAmounts: number[] = (tx.subtransactions ?? [])
          .filter((s) => !s.tombstone && !(s as TransactionEntity & { deleted?: boolean }).deleted)
          .map((s) => s.amount);
        const hasSplits = existingAmounts.length > 0;
        const similarity = hasSplits
          ? splitsSimilarity(existingAmounts, incomingSplitCents)
          : 1;
        let tier: number;
        if (hasSplits && similarity >= 0.95) tier = 0;
        else if (!hasSplits) tier = 1;
        else if (similarity >= 0.5) tier = 2;
        else tier = 99;
        if (tier === 99) continue;
        // Actual transaction shape: `cleared` (boolean — true means
        // cleared, false uncleared), `notes` (memo-equivalent).
        const freshness = tx.cleared ? 0 : 2;
        const unapproved = 1; // Actual doesn't expose approved separately
        const noMemo = (tx.notes ?? "").trim().length === 0 ? 1 : 0;
        allCandidates.push({
          tx,
          tier,
          vendorMatch,
          similarity,
          diffMs,
          freshness,
          unapproved,
          noMemo,
          isPreferred:
            config.matchAcrossAccounts && selectedAccount
              ? account.id === selectedAccount.id
              : true,
        });
      }
    }

    if (allCandidates.length === 0) return null;

    const resolveMostLikely = (pool: Candidate[]): { id: string } | null => {
      if (pool.length === 0) return null;
      const sorted = [...pool].sort(
        (a, b) =>
          a.tier - b.tier ||
          b.vendorMatch - a.vendorMatch ||
          b.similarity - a.similarity ||
          a.diffMs - b.diffMs ||
          b.freshness - a.freshness ||
          b.unapproved - a.unapproved ||
          b.noMemo - a.noMemo,
      );
      return { id: sorted[0].tx.id };
    };

    const preferred = allCandidates.filter((c) => c.isPreferred);
    if (preferred.length > 0) return resolveMostLikely(preferred);
    return resolveMostLikely(allCandidates);
  }

  async updateTransactionWithSplits(
    transactionId: string,
    merchant: string,
    category: string,
    memo: string,
    totalAmount: number,
    splits?: { category: string; amount: number; memo?: string }[],
  ): Promise<void> {
    await ensureBudget();
    const api = await loadApi();

    const fixedTotal = Math.round(-totalAmount * 100);
    const fixedSplits = splits?.map((s) => ({
      category: s.category,
      amount: Math.round(-s.amount * 100),
      memo: s.memo,
    }));

    const categories = await api.getCategories();

    const resolveCategoryId = (name: string): string | undefined =>
      categories.find((c) => normalizeSpaces(c.name) === name)?.id;

    const findTaxCategoryId = (): string | undefined =>
      categories.find(
        (c) =>
          c && !c.hidden && TAX_NAMES.includes(c.name.toLowerCase()),
      )?.id;

    const payeeId = await findOrCreatePayee(merchant);

    if (fixedSplits && fixedSplits.length > 0) {
      const resolved = buildSubtransactionSplits(
        fixedTotal,
        fixedSplits,
        resolveCategoryId,
        findTaxCategoryId,
      );

      if (resolved.length > 1) {
        const subtransactions = resolved.map((r) => ({
          amount: r.amount,
          category: r.categoryId,
          notes: r.memo || undefined,
        }));

        await api.updateTransaction(transactionId, {
          payee: payeeId,
          cleared: false,
          notes: undefined,
          subtransactions,
        } as unknown as Partial<TransactionEntity>);
        await (await loadApi()).sync();
        return;
      }
    }

    const categoryId = resolveCategoryId(category);
    if (!categoryId) throw new Error("Category not found");

    await api.updateTransaction(transactionId, {
      payee: payeeId,
      cleared: false,
      category: categoryId,
      notes: memo,
    } as unknown as Partial<TransactionEntity>);
    await (await loadApi()).sync();
  }

  async createTransaction(
    accountId: string,
    merchant: string,
    category: string,
    transactionDate: string,
    memo: string,
    totalAmount: number,
    splits?: { category: string; amount: number; memo?: string }[],
    // Actual has no native bank-import dedupe key (no equivalent of YNAB's
    // import_id). Accepted to satisfy the BudgetProvider contract; unused.
    _sourceHash?: string,
  ): Promise<void> {
    await ensureBudget();
    const api = await loadApi();

    const fixedTotal = Math.round(-totalAmount * 100);
    const fixedSplits = splits?.map((s) => ({
      category: s.category,
      amount: Math.round(-s.amount * 100),
      memo: s.memo,
    }));

    const accounts = await api.getAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) throw new Error("Account not found");

    const categories = await api.getCategories();

    const resolveCategoryId = (name: string): string | undefined =>
      categories.find((c) => normalizeSpaces(c.name) === name)?.id;

    const findTaxCategoryId = (): string | undefined =>
      categories.find(
        (c) =>
          c && !c.hidden && TAX_NAMES.includes(c.name.toLowerCase()),
      )?.id;

    const payeeId = await findOrCreatePayee(merchant);

    type SubtransactionInput = { amount: number; category?: string; notes?: string };
    let subtransactions: SubtransactionInput[] | undefined;
    let categoryId: string | undefined;

    if (fixedSplits && fixedSplits.length > 0) {
      const resolved = buildSubtransactionSplits(
        fixedTotal,
        fixedSplits,
        resolveCategoryId,
        findTaxCategoryId,
      );

      if (resolved.length > 1) {
        subtransactions = resolved.map((r) => ({
          amount: r.amount,
          category: r.categoryId,
          notes: r.memo || undefined,
        }));
      }
    }

    if (!subtransactions || subtransactions.length <= 1) {
      categoryId = resolveCategoryId(category);
      if (!categoryId) throw new Error("Category not found");
    }

    const transaction: Partial<TransactionEntity> & { subtransactions?: SubtransactionInput[] } = {
      account: account.id,
      amount: fixedTotal,
      date: transactionDate,
      payee: payeeId,
      cleared: false,
      notes: subtransactions && subtransactions.length > 1 ? undefined : memo,
      category: subtransactions && subtransactions.length > 1 ? undefined : categoryId,
      subtransactions: subtransactions && subtransactions.length > 1 ? subtransactions : undefined,
    };

    await api.addTransactions(account.id, [transaction]);
    await api.sync();
  }

  async testConnection(): Promise<void> {
    await ensureBudget();
  }

  async shutdown(): Promise<void> {
    try {
      const api = await loadApi();
      await api.shutdown();
    } catch {
      // ignore shutdown errors
    }
    _serverConnected = false;
    _budgetLoaded = false;
    // Restore the strict TLS dispatcher swapped out for this connection.
    if (_previousDispatcher) {
      setGlobalDispatcher(_previousDispatcher);
      _previousDispatcher = null;
    }
  }
}

// F2 regression: /import releases the claim on ANY error. If YNAB's
// createTransaction succeeded server-side but the ack was lost (30s
// timeout fires as YNAB commits, socket drop post-write), the claim is
// released and the user retries. If findMatchingTransaction then misses
// (date/account drift), a SECOND transaction is created → duplicate.
// Fix: send a deterministic YNAB `import_id` derived from the receipt so
// YNAB itself dedupes a retry of the same receipt (its native bank-import
// dedupe). Same receipt → same import_id; different amount → different.
import { describe, it, expect, beforeEach, vi } from "vitest";

const createTransaction = vi.fn(async () => ({ data: {} }));
const getBudgetById = vi.fn();
const getTransactionsByAccount = vi.fn();
const getTransactions = vi.fn();
const fakeApi = {
  budgets: { getBudgetById, withMiddleware: () => fakeApi.budgets },
  transactions: { createTransaction, getTransactionsByAccount, getTransactions, withMiddleware: () => fakeApi.transactions },
};
vi.mock("ynab", () => ({ API: class { budgets = fakeApi.budgets; transactions = fakeApi.transactions; } }));
const { mockGetConfig } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(() => ({ ynabApiKey: "k", ynabBudgetId: "b", ynabCategoryGroups: [] })),
}));
vi.mock("./config", () => ({ getConfig: () => mockGetConfig() }));

import { YnabBudgetProvider } from "./budget-ynab";

const budget = {
  data: {
    budget: {
      accounts: [{ id: "acc1", name: "Checking" }, { id: "acc2", name: "Savings" }],
      categories: [{ id: "cat1", name: "Groceries", category_group_id: "g1" }],
      category_groups: [{ id: "g1", name: "Living" }],
    },
  },
};

describe("YNAB createTransaction sends a deterministic import_id (F2)", () => {
  beforeEach(() => {
    createTransaction.mockClear();
    getBudgetById.mockReset().mockResolvedValue(budget);
  });

  async function create(total: number, date = "2026-05-10", merchant = "Amazon", account = "acc1") {
    const p = new YnabBudgetProvider();
    await p.createTransaction(account, merchant, "Groceries", date, "memo", total);
    return createTransaction.mock.calls.at(-1)![1].transaction.import_id as string;
  }

  it("sets a non-empty import_id within YNAB's 36-char limit", async () => {
    const id = await create(12.34);
    expect(id).toBeTruthy();
    expect(id.length).toBeLessThanOrEqual(36);
  });

  it("is identical for the same receipt (a retry dedupes) and differs when the amount differs", async () => {
    const a1 = await create(12.34);
    const a2 = await create(12.34); // ack-lost retry of the SAME receipt
    const b = await create(99.99); // a genuinely different receipt
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
  });

  it("is account-scoped: the same receipt re-filed to a different account is NOT deduped away", async () => {
    const checking = await create(12.34, "2026-05-10", "Amazon", "acc1");
    const savings = await create(12.34, "2026-05-10", "Amazon", "acc2");
    expect(savings).not.toBe(checking);
  });
});

// The accepted-residual-that-wasn't-acceptable: two genuinely-distinct
// receipts with identical account+merchant+date+amount used to collide
// on YNAB's bank-import dedupe (createTransaction silent-drop) OR be
// matched against each other by findMatchingTransaction's
// splits-similarity tiers (silent overwrite). Threading the file's
// SHA-256 into the import_id makes the two pathologies impossible
// while keeping idempotent retry (same file → same hash → same id).
describe("YNAB createTransaction folds sourceHash into the import_id", () => {
  beforeEach(() => {
    createTransaction.mockClear();
    getBudgetById.mockReset().mockResolvedValue(budget);
  });

  async function create(sourceHash: string | undefined, total = 47.32, date = "2026-05-10", merchant = "WholeFoods", account = "acc1") {
    const p = new YnabBudgetProvider();
    await p.createTransaction(account, merchant, "Groceries", date, "memo", total, undefined, sourceHash);
    return createTransaction.mock.calls.at(-1)![1].transaction.import_id as string;
  }

  it("two distinct receipts with the SAME merchant+date+amount but DIFFERENT sourceHash get DIFFERENT import_ids", async () => {
    // The discriminating case: pre-fix, these would have been the same
    // string and YNAB would have silently dropped the second. Post-fix,
    // distinct bytes → distinct ids.
    const receiptA = await create("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const receiptB = await create("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(receiptA).not.toBe(receiptB);
    expect(receiptA.length).toBeLessThanOrEqual(36);
    expect(receiptB.length).toBeLessThanOrEqual(36);
  });

  it("the SAME file replayed (idempotent retry) still produces the SAME import_id", async () => {
    const hash = "c".repeat(64);
    const first = await create(hash);
    const second = await create(hash); // ack-lost retry
    expect(second).toBe(first);
  });

  it("absent sourceHash falls back to the pre-fix key (no behavioral break for callers without a file in hand)", async () => {
    const noHash = await create(undefined);
    expect(noHash).toBeTruthy();
    expect(noHash.startsWith("BI:")).toBe(true);
  });
});

describe("YNAB findMatchingTransaction rejects candidates with a different BI: fingerprint", () => {
  beforeEach(() => {
    getBudgetById.mockReset().mockResolvedValue(budget);
    getTransactionsByAccount.mockReset();
    getTransactions.mockReset();
  });

  // The candidate is what YNAB returns for "transactions in this account
  // within the date window matching the amount." If two distinct receipts
  // hit this filter pre-fix, the splits-similarity tiering could promote
  // the wrong one to a match (silent overwrite). Post-fix, the
  // BI:-fingerprint reject is decisive.
  function setCandidates(transactions: Array<{ id: string; amount: number; date: string; import_id?: string; payee_name?: string; subtransactions?: Array<{ amount: number; deleted?: boolean }>; cleared?: string; approved?: boolean; memo?: string; deleted?: boolean; account_id?: string }>) {
    getTransactionsByAccount.mockResolvedValue({ data: { transactions } });
    getTransactions.mockResolvedValue({ data: { transactions } });
  }

  it("a candidate carrying a DIFFERENT BI: import_id is explicitly NOT matched (the silent-overwrite half of the bug)", async () => {
    const hashIncoming = "incoming".padEnd(64, "x");
    const candidateImportId = "BI:differentdifferentdifferentdifferent".slice(0, 36);
    setCandidates([{
      id: "txn-other",
      amount: -47320, // -47.32 in milliunits
      date: "2026-05-10",
      import_id: candidateImportId, // ← different fingerprint = different receipt
      payee_name: "WholeFoods",
      // Same split AMOUNTS as the incoming would have — pre-fix this
      // would have been promoted by the tier-0 splits-similarity check.
      subtransactions: [{ amount: -20000 }, { amount: -27320 }],
      cleared: "uncleared",
      approved: false,
      memo: "",
      account_id: "acc1",
    }]);

    const p = new YnabBudgetProvider();
    const match = await p.findMatchingTransaction(
      "acc1",
      47.32,
      "2026-05-10",
      "WholeFoods",
      [20, 27.32], // same split amounts → high similarity → would have matched without the fingerprint reject
      hashIncoming,
    );

    expect(match).toBeNull();
  });

  it("a candidate carrying the SAME BI: import_id is still found (idempotent re-import paths keep working)", async () => {
    const hash = "same".padEnd(64, "y");
    // Compute what the incoming's would-be import_id will be by routing
    // through the public helper indirectly: call createTransaction once
    // with this exact account/merchant/date/amount/sourceHash, grab the
    // emitted import_id, then mount it on a candidate.
    const probe = new YnabBudgetProvider();
    await probe.createTransaction("acc1", "WholeFoods", "Groceries", "2026-05-10", "memo", 47.32, undefined, hash);
    const incomingId = createTransaction.mock.calls.at(-1)![1].transaction.import_id as string;

    setCandidates([{
      id: "txn-self",
      amount: -47320,
      date: "2026-05-10",
      import_id: incomingId,
      payee_name: "WholeFoods",
      subtransactions: [{ amount: -20000 }, { amount: -27320 }],
      cleared: "uncleared",
      approved: false,
      memo: "",
      account_id: "acc1",
    }]);

    const p = new YnabBudgetProvider();
    const match = await p.findMatchingTransaction(
      "acc1",
      47.32,
      "2026-05-10",
      "WholeFoods",
      [20, 27.32],
      hash,
    );

    expect(match).not.toBeNull();
    expect(match!.id).toBe("txn-self");
  });

  it("without an incoming sourceHash, the BI:-fingerprint reject does NOT fire (legacy callers retain the old behavior)", async () => {
    // Pre-fix legacy candidate + pre-fix legacy incoming = no fingerprint
    // available on either side, so we fall back to the existing tier
    // logic. Locks down "no behavioral regression for the old path."
    setCandidates([{
      id: "txn-legacy",
      amount: -47320,
      date: "2026-05-10",
      import_id: "BI:somethinglegacysomethinglegacy".slice(0, 36),
      payee_name: "WholeFoods",
      subtransactions: [], // no splits → Tier 1 (safe to attach)
      cleared: "uncleared",
      approved: false,
      memo: "",
      account_id: "acc1",
    }]);

    const p = new YnabBudgetProvider();
    const match = await p.findMatchingTransaction(
      "acc1",
      47.32,
      "2026-05-10",
      "WholeFoods",
      undefined,
      undefined, // ← no incoming hash
    );

    expect(match).not.toBeNull();
  });
});

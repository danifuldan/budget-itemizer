// Regression: when multiple transactions in YNAB match the same
// amount + date window (e.g., two $50 Walmart trips on the same day),
// the previous behavior silently picked `candidates[length-1]` and
// overwrote splits/memo on whichever happened to be last. That's a
// silent destroy-the-wrong-transaction bug. The current behavior:
// refuse to match when ambiguous so the caller falls through to
// createTransaction; the user manually reconciles inside YNAB.
import { describe, it, expect, beforeEach, vi } from "vitest";

const getBudgetById = vi.fn();
const getTransactions = vi.fn();
const getTransactionsByAccount = vi.fn();

const fakeApi = {
  budgets: { getBudgetById, withMiddleware: () => fakeApi.budgets },
  transactions: {
    getTransactions,
    getTransactionsByAccount,
    withMiddleware: () => fakeApi.transactions,
  },
};
vi.mock("ynab", () => ({
  API: class {
    budgets = fakeApi.budgets;
    transactions = fakeApi.transactions;
  },
}));

const { mockGetConfig } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(() => ({
    ynabApiKey: "test-token",
    ynabBudgetId: "test-budget",
    ynabCategoryGroups: [],
    matchAcrossAccounts: false,
  })),
}));
vi.mock("./config", () => ({
  getConfig: () => mockGetConfig(),
}));

import { YnabBudgetProvider } from "./budget-ynab";

const tx = (overrides: Partial<any>) => ({
  id: "tx-id",
  account_id: "acc-1",
  date: "2026-01-15",
  amount: -50000, // milliunits — $50.00 outflow
  memo: null,
  cleared: "uncleared",
  approved: false,
  flag_color: null,
  payee_id: null,
  // Default payee is a realistic-noisy bank string; tests that need a
  // clean / non-matching name pass an override.
  payee_name: "WAL-MART SUPERCENTER #1234",
  category_id: null,
  transfer_account_id: null,
  transfer_transaction_id: null,
  matched_transaction_id: null,
  import_id: null,
  deleted: false,
  subtransactions: [],
  ...overrides,
});

const fakeBudgetWithAccounts = (selectedAccountId = "acc-1") => ({
  data: {
    budget: {
      accounts: [
        { id: selectedAccountId, name: "Checking", deleted: false },
        { id: "acc-2", name: "Cash", deleted: false },
      ],
      categories: [],
      category_groups: [],
    },
  },
});

describe("YnabBudgetProvider.findMatchingTransaction", () => {
  beforeEach(() => {
    getBudgetById.mockReset();
    getTransactions.mockReset();
    getTransactionsByAccount.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetConfig.mockReturnValue({
      ynabApiKey: "test-token",
      ynabBudgetId: "test-budget",
      ynabCategoryGroups: [],
      matchAcrossAccounts: false,
    });
  });

  it("returns the unique candidate when exactly one transaction matches", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: { transactions: [tx({ id: "t1" })] },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Walmart");

    expect(match?.id).toBe("t1");
  });

  it("returns null when no transactions match", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({ data: { transactions: [] } });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Walmart");

    expect(match).toBeNull();
  });

  // Round 8 final design: matcher does not refuse on ambiguity — it
  // picks the most-likely candidate via the cascade (vendor match,
  // splits similarity, date proximity, freshness, etc.). With two
  // otherwise-identical candidates the sort is stable → first wins.
  it("when multiple same-vendor same-amount unsplit transactions tie completely, picks the first deterministically (no refuse)", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "t1", date: "2026-01-15" }),
          tx({ id: "t2", date: "2026-01-15" }),
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Walmart");
    expect(match?.id).toBe("t1");
  });

  it("ignores deleted transactions when counting candidates", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "t1" }),
          tx({ id: "t-deleted", deleted: true }),
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Walmart");

    // Only the non-deleted candidate counts — unique → return it.
    expect(match?.id).toBe("t1");
  });

  it("with matchAcrossAccounts on, prefers a unique match in the selected account over a unique match in another account", async () => {
    mockGetConfig.mockReturnValue({
      ynabApiKey: "test-token",
      ynabBudgetId: "test-budget",
      ynabCategoryGroups: [],
      matchAcrossAccounts: true,
    });
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactions.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "in-selected", account_id: "acc-1" }),
          tx({ id: "in-other", account_id: "acc-2" }),
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Walmart");

    expect(match?.id).toBe("in-selected");
  });

  it("with matchAcrossAccounts on, falls back to a unique cross-account match when the selected account has none", async () => {
    mockGetConfig.mockReturnValue({
      ynabApiKey: "test-token",
      ynabBudgetId: "test-budget",
      ynabCategoryGroups: [],
      matchAcrossAccounts: true,
    });
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactions.mockResolvedValue({
      data: {
        transactions: [tx({ id: "only-other", account_id: "acc-2" })],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Walmart");

    expect(match?.id).toBe("only-other");
  });

  it("with matchAcrossAccounts on, picks deterministically from the selected-account pool even when multiple candidates tie", async () => {
    mockGetConfig.mockReturnValue({
      ynabApiKey: "test-token",
      ynabBudgetId: "test-budget",
      ynabCategoryGroups: [],
      matchAcrossAccounts: true,
    });
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactions.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "sel-1", account_id: "acc-1" }),
          tx({ id: "sel-2", account_id: "acc-1" }),
          tx({ id: "other", account_id: "acc-2" }),
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Walmart");

    // Selected-account pool has 2 candidates that tie on every signal;
    // the first in the pool wins. We never fall back to the other-
    // account candidate while a selected-account candidate exists.
    expect(match?.id).toBe("sel-1");
  });

  // Vendor is a tiebreaker, NOT a filter. When the only same-amount,
  // same-date-window candidate has a payee that disagrees with the
  // receipt merchant (e.g. Amazon receipt → AMZN bank payee — our
  // fuzzy matcher misses that bank abbreviation), the matcher still
  // attaches: amount + date + account are strong-enough signals on
  // their own, and a stricter rule would force the user to manually
  // merge every Amazon-class import.
  it("still matches when payee disagrees with receipt merchant, if it's the only candidate (vendor is tiebreaker only)", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "amzn", payee_name: "AMZN MKTP US*ABC123" }),
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Amazon");
    expect(match?.id).toBe("amzn");
  });

  it("when two candidates tie on amount + date, the vendor-matching one wins (tiebreaker)", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "wrong-merchant", payee_name: "TARGET 00012345" }),
          tx({ id: "right-merchant", payee_name: "WAL-MART SUPERCENTER #1234" }),
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Walmart");
    expect(match?.id).toBe("right-merchant");
  });

  it("fuzzy-matches a clean receipt merchant against a noisy bank payee (real-world bank-string)", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "zelle-fred", payee_name: "ZELLE 2092398TY62008 FRED" }),
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Fred");
    expect(match?.id).toBe("zelle-fred");
  });

  // When two same-vendor same-amount transactions land at different
  // dates inside the window (pending vs posted on consecutive days),
  // pick the one closer to the receipt date.
  it("picks the closest-date candidate when multiple same-vendor same-amount transactions are in the window", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "two-days-off", date: "2026-01-13" }), // 2 days before
          tx({ id: "next-day", date: "2026-01-14" }),     // 1 day before — closest
          tx({ id: "three-days-off", date: "2026-01-18" }), // 3 days after
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Walmart");
    expect(match?.id).toBe("next-day");
  });

  // The "two real $50 Walmart trips on same day" footgun: both
  // candidates unsplit → tier 1 → tie on everything → first wins.
  // Receipt's splits will overwrite the first one's empty subtransactions
  // (no data loss). Second trip will create a duplicate that the user
  // resolves in YNAB. Acceptable cost — see splits-similarity branch
  // for the case where prior splits already exist.
  it("when two same-vendor same-amount unsplit transactions share the same date, picks the first (no refuse)", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "monday-a", date: "2026-01-15" }),
          tx({ id: "monday-b", date: "2026-01-15" }),
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Walmart");
    expect(match?.id).toBe("monday-a");
  });

  // High-similarity-with-existing-splits beats unsplit. A receipt being
  // re-imported should attach to the previously-imported transaction
  // (idempotent overwrite) rather than the empty bank-pushed row.
  it("prefers a high-splits-similarity candidate over an unsplit one (tier 0 beats tier 1)", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "blank-bank", date: "2026-01-15", subtransactions: [] }),
          tx({
            id: "previously-imported",
            date: "2026-01-15",
            subtransactions: [
              { amount: -30000, deleted: false, memo: "Bread" },
              { amount: -20000, deleted: false, memo: "Milk" },
            ],
          }),
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    // Incoming receipt splits match the previously-imported tx exactly.
    const match = await provider.findMatchingTransaction(
      "acc-1",
      50,
      "2026-01-15",
      "Walmart",
      [30, 20], // dollars; will be converted to milliunits internally
    );
    expect(match?.id).toBe("previously-imported");
  });

  // Low-similarity-with-existing-splits → ineligible. The matcher
  // should skip a candidate whose existing splits look NOTHING like
  // our receipt, preferring the unsplit (or absent-of-eligible) one.
  it("skips a candidate with low-similarity existing splits, picks the unsplit one instead", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({
            id: "different-trip",
            date: "2026-01-15",
            subtransactions: [
              { amount: -40000, deleted: false, memo: "Detergent" },
              { amount: -10000, deleted: false, memo: "Paper" },
            ],
          }),
          tx({ id: "blank-bank", date: "2026-01-15", subtransactions: [] }),
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction(
      "acc-1",
      50,
      "2026-01-15",
      "Walmart",
      [30, 20], // overlaps with `different-trip` at 0%
    );
    expect(match?.id).toBe("blank-bank");
  });

  // If the only candidate is a different-trip split, refuse to overwrite.
  it("returns null when every candidate has low-similarity existing splits (all ineligible)", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({
            id: "different-trip",
            date: "2026-01-15",
            subtransactions: [
              { amount: -40000, deleted: false, memo: "Detergent" },
              { amount: -10000, deleted: false, memo: "Paper" },
            ],
          }),
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction(
      "acc-1",
      50,
      "2026-01-15",
      "Walmart",
      [30, 20],
    );
    expect(match).toBeNull();
  });

  it("excludes transactions outside the ±3 day window even with matching vendor + amount", async () => {
    getBudgetById.mockResolvedValue(fakeBudgetWithAccounts());
    getTransactionsByAccount.mockResolvedValue({
      data: {
        transactions: [
          tx({ id: "too-old", date: "2026-01-10" }), // 5 days before
        ],
      },
    });

    const provider = new YnabBudgetProvider();
    const match = await provider.findMatchingTransaction("acc-1", 50, "2026-01-15", "Walmart");
    expect(match).toBeNull();
  });
});

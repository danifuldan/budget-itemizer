import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @actual-app/api before importing the provider
vi.mock("@actual-app/api", () => ({
  init: vi.fn(),
  downloadBudget: vi.fn(),
  shutdown: vi.fn(),
  sync: vi.fn(),
  getCategories: vi.fn(),
  getAccounts: vi.fn(),
  getBudgets: vi.fn(),
  getPayees: vi.fn(),
  createPayee: vi.fn(),
  getTransactions: vi.fn(),
  addTransactions: vi.fn(),
  updateTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
}));

// Mock config
vi.mock("./config", () => ({
  getConfig: vi.fn(() => ({
    actualServerUrl: "http://localhost:5006",
    actualPassword: "test-password",
    actualSyncId: "test-sync-id",
    matchAcrossAccounts: false,
  })),
}));

import * as api from "@actual-app/api";
import { ActualBudgetProvider } from "./budget-actual";

const mockApi = vi.mocked(api);

describe("ActualBudgetProvider", () => {
  let provider: ActualBudgetProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module-level state by creating fresh provider and forcing reconnect
    provider = new ActualBudgetProvider();
    // Reset the connection state by calling shutdown
    // We need to re-import to reset module state, but simpler to just test fresh
  });

  describe("getAllCategories", () => {
    it("excludes income and hidden categories", async () => {
      mockApi.getCategories.mockResolvedValue([
        { id: "1", name: "Groceries", is_income: false, hidden: false, group_id: "g1" },
        { id: "2", name: "Income", is_income: true, hidden: false, group_id: "g2" },
        { id: "3", name: "Old Category", is_income: false, hidden: true, group_id: "g1" },
        { id: "4", name: "Utilities", is_income: false, hidden: false, group_id: "g1" },
      ] as any);
      mockApi.getAccounts.mockResolvedValue([]);

      const categories = await provider.getAllCategories();
      expect(categories).toEqual(["Groceries", "Utilities"]);
      expect(categories).not.toContain("Income");
      expect(categories).not.toContain("Old Category");
    });
  });

  describe("getAllAccounts", () => {
    it("excludes closed and offbudget accounts", async () => {
      mockApi.getAccounts.mockResolvedValue([
        { id: "a1", name: "Checking", closed: false, offbudget: false },
        { id: "a2", name: "Savings", closed: false, offbudget: true },
        { id: "a3", name: "Old Account", closed: true, offbudget: false },
        { id: "a4", name: "Credit Card", closed: false, offbudget: false },
      ] as any);

      const accounts = await provider.getAllAccounts();
      expect(accounts).toEqual([
        { id: "a1", name: "Checking" },
        { id: "a4", name: "Credit Card" },
      ]);
      expect(accounts.some((a) => a.id === "a2")).toBe(false);
      expect(accounts).not.toContain("Old Account");
    });
  });

  describe("createTransaction", () => {
    it("converts dollars to cents (negative for expenses)", async () => {
      mockApi.getAccounts.mockResolvedValue([
        { id: "a1", name: "Checking", closed: false, offbudget: false },
      ] as any);
      mockApi.getCategories.mockResolvedValue([
        { id: "c1", name: "Groceries", is_income: false, hidden: false },
      ] as any);
      mockApi.getPayees.mockResolvedValue([]);
      mockApi.createPayee.mockResolvedValue("p1");
      mockApi.addTransactions.mockResolvedValue(undefined as any);

      await provider.createTransaction(
        "a1",
        "Walmart",
        "Groceries",
        "2026-03-15",
        "Weekly groceries",
        12.99,
      );

      expect(mockApi.addTransactions).toHaveBeenCalledWith("a1", [
        expect.objectContaining({
          amount: -1299,
          account: "a1",
          date: "2026-03-15",
          payee: "p1",
          notes: "Weekly groceries",
          category: "c1",
        }),
      ]);
    });

    it("imports uncategorized (no throw) when the item's category isn't in the budget (user: set it later)", async () => {
      mockApi.getAccounts.mockResolvedValue([
        { id: "a1", name: "Checking", closed: false, offbudget: false },
      ] as any);
      // Budget has only "General" — the receipt's category "Electronics" won't resolve.
      mockApi.getCategories.mockResolvedValue([
        { id: "c1", name: "General", is_income: false, hidden: false },
      ] as any);
      mockApi.getPayees.mockResolvedValue([]);
      mockApi.createPayee.mockResolvedValue("p1");
      mockApi.addTransactions.mockResolvedValue(undefined as any);

      await expect(
        provider.createTransaction("a1", "Amazon", "Electronics", "2026-01-21", "memo", 95.52),
      ).resolves.toBeUndefined(); // must NOT throw "Category not found"

      const [, txns] = mockApi.addTransactions.mock.calls[0] as [string, any[]];
      expect(txns[0].amount).toBe(-9552); // full amount preserved
      expect(txns[0].category).toBeUndefined(); // imported uncategorized
    });

    it("uses buildSubtransactionSplits with tax category resolution", async () => {
      mockApi.getAccounts.mockResolvedValue([
        { id: "a1", name: "Checking", closed: false, offbudget: false },
      ] as any);
      mockApi.getCategories.mockResolvedValue([
        { id: "c1", name: "Groceries", is_income: false, hidden: false },
        { id: "c2", name: "Sales Tax", is_income: false, hidden: false },
      ] as any);
      mockApi.getPayees.mockResolvedValue([{ id: "p1", name: "Amazon" }] as any);
      mockApi.addTransactions.mockResolvedValue(undefined as any);

      await provider.createTransaction(
        "a1",
        "Amazon",
        "Groceries",
        "2026-03-15",
        "Order",
        15.00,
        [
          { category: "Groceries", amount: 12.99, memo: "Items" },
          { category: "", amount: 2.01, memo: "Tax/fees" },
        ],
      );

      // The Actual API takes `category` (not `category_id`) on subtransactions.
      // The test previously asserted the wrong field name; updated to match.
      expect(mockApi.addTransactions).toHaveBeenCalledWith("a1", [
        expect.objectContaining({
          amount: -1500,
          subtransactions: expect.arrayContaining([
            expect.objectContaining({ amount: -1299, category: "c1", notes: "Items" }),
            expect.objectContaining({ amount: -201, category: "c2", notes: "Tax/fees" }),
          ]),
        }),
      ]);
    });
  });

  describe("updateTransactionWithSplits", () => {
    const setup = () => {
      mockApi.getCategories.mockResolvedValue([
        { id: "c1", name: "General", is_income: false, hidden: false },
      ] as any);
      mockApi.getPayees.mockResolvedValue([]);
      mockApi.createPayee.mockResolvedValue("p1");
      mockApi.updateTransaction.mockResolvedValue(undefined as any);
      mockApi.sync.mockResolvedValue(undefined as any);
    };

    it("OMITS category (preserves the matched txn's existing one) when the receipt category doesn't resolve — premortem 2026-06-01 Bug 1", async () => {
      setup();
      // "Electronics" isn't in the budget → must NOT clear the existing category.
      await provider.updateTransactionWithSplits("t1", "Amazon", "Electronics", "memo", 95.52);
      const [, payload] = mockApi.updateTransaction.mock.calls[0] as [string, any];
      expect(payload).not.toHaveProperty("category"); // key omitted → existing category left intact
      expect(payload.payee).toBe("p1");
    });

    it("sets category when it resolves", async () => {
      setup();
      await provider.updateTransactionWithSplits("t1", "Amazon", "General", "memo", 95.52);
      const [, payload] = mockApi.updateTransaction.mock.calls[0] as [string, any];
      expect(payload.category).toBe("c1");
    });

    // Regression (2026-06-05, real Actual import): @actual-app/api CANNOT turn
    // an existing transaction into a split in place — updateTransaction drops
    // `subtransactions`, inserting the children as loose top-level rows ("I got
    // individual transactions, not a split"). The only API that builds a real
    // split is addTransactions. So the match path now ADDs a new split that
    // inherits the original's identity, verifies it persisted, then DELETEs the
    // original. updateTransaction must never be used for the split.
    const splitArgs = [
      "t1",
      "Amazon",
      "General",
      "memo",
      95.52,
      [
        { category: "General", amount: 65.55 },
        { category: "Electronics", amount: 29.97 },
      ],
      "acct-7", // parentAccountId, threaded from findMatchingTransaction
      "2026-01-21", // parentDate, threaded from findMatchingTransaction
    ] as const;

    // addTransactions returns the string "ok" (NOT ids), so the provider
    // assigns the parent id itself and finds it on the verify re-read.
    // getTransactions is called twice (before=fetch original, after=verify);
    // this mock returns the original first, then original + the new split whose
    // id matches whatever the provider passed to addTransactions. `persisted`
    // controls whether that new split comes back with its children.
    const mockSplitFlow = ({ persisted }: { persisted: boolean }) => {
      mockApi.addTransactions.mockResolvedValue("ok" as any);
      mockApi.deleteTransaction.mockResolvedValue(undefined as any);
      const original = {
        id: "t1",
        account: "acct-7",
        date: "2026-01-21",
        amount: -9552,
        cleared: true,
        imported_id: "bank-xyz",
        subtransactions: [],
      };
      mockApi.getTransactions.mockImplementation(async () => {
        const addCall = mockApi.addTransactions.mock.calls[0];
        if (!addCall) return [original] as any; // before-read
        const parent = (addCall[1] as any[])[0];
        const children = persisted
          ? (parent.subtransactions as any[]).map((c) => ({ ...c, tombstone: 0 }))
          : [];
        return [
          original,
          {
            id: parent.id, // the self-assigned id the verify looks for
            account: "acct-7",
            date: "2026-01-21",
            amount: -9552,
            is_parent: true,
            subtransactions: children,
          },
        ] as any;
      });
    };

    it("adds a real split (addTransactions, NOT updateTransaction), inheriting the original's identity", async () => {
      setup();
      mockApi.getCategories.mockResolvedValue([
        { id: "c1", name: "General", is_income: false, hidden: false },
        { id: "c2", name: "Electronics", is_income: false, hidden: false },
      ] as any);
      mockSplitFlow({ persisted: true });

      await provider.updateTransactionWithSplits(...splitArgs);

      // updateTransaction CANNOT make a split — it must not be used here.
      expect(mockApi.updateTransaction).not.toHaveBeenCalled();

      // addTransactions builds the split: parent in the matched account/date,
      // with two children carrying amount/category (account/date are filled by
      // the SDK, so we deliberately do NOT stamp them ourselves).
      const [acctArg, txns] = mockApi.addTransactions.mock.calls[0] as [string, any[]];
      expect(acctArg).toBe("acct-7");
      const parent = txns[0];
      expect(parent.id).toBeTruthy(); // self-assigned so verify can find it
      expect(parent.account).toBe("acct-7");
      expect(parent.date).toBe("2026-01-21");
      expect(parent.amount).toBe(-9552);
      expect(parent.cleared).toBe(true); // inherited from original
      expect(parent.imported_id).toBe("bank-xyz"); // bank identity preserved → no re-import
      expect(parent.subtransactions).toHaveLength(2);
      const sum = parent.subtransactions.reduce((a: number, s: any) => a + s.amount, 0);
      expect(sum).toBe(-9552);

      // The original single-line transaction is removed AFTER the split lands.
      expect(mockApi.deleteTransaction).toHaveBeenCalledWith("t1");
    });

    it("fails loudly (no write) when the parent account/date is missing", async () => {
      setup();
      mockApi.getCategories.mockResolvedValue([
        { id: "c1", name: "General", is_income: false, hidden: false },
        { id: "c2", name: "Electronics", is_income: false, hidden: false },
      ] as any);

      await expect(
        provider.updateTransactionWithSplits(
          "t1",
          "Amazon",
          "General",
          "memo",
          95.52,
          [
            { category: "General", amount: 65.55 },
            { category: "Electronics", amount: 29.97 },
          ],
          undefined, // no account → must throw before touching the budget
        ),
      ).rejects.toThrow(/account/i);
      expect(mockApi.addTransactions).not.toHaveBeenCalled();
      expect(mockApi.deleteTransaction).not.toHaveBeenCalled();
    });

    // The bug that made all of this invisible: @actual-app/api LOGS a failed
    // split insert instead of throwing, so the route returned 200 "Imported"
    // while the budget was untouched. The post-write re-read must turn that
    // swallowed failure into a real throw — AND must NOT delete the original,
    // or we'd destroy the user's transaction for nothing.
    it("throws (no false success) and keeps the original when the split didn't persist", async () => {
      setup();
      mockApi.getCategories.mockResolvedValue([
        { id: "c1", name: "General", is_income: false, hidden: false },
        { id: "c2", name: "Electronics", is_income: false, hidden: false },
      ] as any);
      // addTransactions "succeeds" (returns "ok") but the re-read shows the new
      // parent has NO children — exactly the swallowed-insert case.
      mockSplitFlow({ persisted: false });

      await expect(
        provider.updateTransactionWithSplits(...splitArgs),
      ).rejects.toThrow(/did not persist/i);
      expect(mockApi.deleteTransaction).not.toHaveBeenCalled(); // original preserved
    });
  });

  describe("getAllBudgets", () => {
    // api.getBudgets() returns each budget once as a downloaded LOCAL file
    // (on-disk `id`, no `state`) and once as a `state:"remote"` server file;
    // both share the same groupId. The dropdown must show one row per budget.
    it("collapses the local + remote copies of one budget into a single row", async () => {
      mockApi.getBudgets.mockResolvedValue([
        // local (downloaded) — on-disk id, no `state`
        { id: "My-Finances-0007c45", cloudFileId: "dcf86b25", groupId: "697f180e", name: "My Finances" },
        { id: "Reboot-Budget-da54ded", cloudFileId: "7ac1775b", groupId: "34ec2039", name: "Budget" },
        // remote — same groupId, state:"remote", no on-disk id
        { cloudFileId: "7ac1775b", state: "remote", groupId: "34ec2039", name: "Budget" },
        { cloudFileId: "dcf86b25", state: "remote", groupId: "697f180e", name: "My Finances" },
      ] as any);

      const budgets = await provider.getAllBudgets();

      // One row per identity, local-first order preserved, and the exposed
      // id is the groupId (the syncId) — NOT the on-disk "My-Finances-0007c45",
      // which would be written to config.actualSyncId and break downloadBudget.
      expect(budgets).toEqual([
        { id: "697f180e", name: "My Finances" },
        { id: "34ec2039", name: "Budget" },
      ]);
    });
  });

  describe("findMatchingTransaction", () => {
    it("returns match by amount + vendor + date", async () => {
      mockApi.getAccounts.mockResolvedValue([
        { id: "a1", name: "Checking", closed: false, offbudget: false },
      ] as any);
      mockApi.getPayees.mockResolvedValue([
        { id: "p1", name: "Walmart Supercenter" },
      ] as any);
      mockApi.getTransactions.mockResolvedValue([
        { id: "t1", amount: -1299, date: "2026-03-15", payee: "p1", account: "a1" },
      ] as any);

      const match = await provider.findMatchingTransaction(
        "a1",
        12.99,
        "2026-03-15",
        "Walmart",
      );
      // accountId + date are carried so the split-update path can stamp each
      // child with the parent's account and date (Actual rejects children
      // without them).
      expect(match).toEqual({ id: "t1", accountId: "a1", date: "2026-03-15" });
    });

    it("pulls a fresh sync before matching, so a txn added on the server after load is still matched (regression: 2026-05-30 duplicate)", async () => {
      mockApi.getAccounts.mockResolvedValue([
        { id: "a1", name: "Checking", closed: false, offbudget: false },
      ] as any);
      mockApi.getPayees.mockResolvedValue([{ id: "p1", name: "Walmart" }] as any);

      // The candidate exists on the SERVER but is NOT in the local copy until a
      // sync pulls it — exactly the bank-feed / Actual-web entry case that
      // produced a duplicate (matcher read a stale local copy).
      let synced = false;
      mockApi.sync.mockImplementation(async () => {
        synced = true;
      });
      mockApi.getTransactions.mockImplementation(
        async () =>
          (synced
            ? [{ id: "t1", amount: -9552, date: "2026-01-21", payee: "p1", account: "a1" }]
            : []) as any,
      );

      const match = await provider.findMatchingTransaction(
        "a1",
        95.52,
        "2026-01-21",
        "Walmart",
      );

      expect(mockApi.sync).toHaveBeenCalled(); // must pull before reading
      expect(match).toEqual({ id: "t1", accountId: "a1", date: "2026-01-21" }); // → matches, so NO duplicate is created
    });

    it("returns null when amount doesn't match", async () => {
      mockApi.getAccounts.mockResolvedValue([
        { id: "a1", name: "Checking", closed: false, offbudget: false },
      ] as any);
      mockApi.getPayees.mockResolvedValue([{ id: "p1", name: "Walmart" }] as any);
      mockApi.getTransactions.mockResolvedValue([
        { id: "t1", amount: -5000, date: "2026-03-15", payee: "p1" },
      ] as any);

      const match = await provider.findMatchingTransaction(
        "a1",
        12.99,
        "2026-03-15",
        "Walmart",
      );
      expect(match).toBeNull();
    });

    // Vendor is a tiebreaker, not a hard filter. A lone same-amount,
    // same-date candidate still attaches even if the payee disagrees.
    it("still matches a lone same-amount candidate when payee disagrees (vendor is tiebreaker only)", async () => {
      mockApi.getAccounts.mockResolvedValue([
        { id: "a1", name: "Checking", closed: false, offbudget: false },
      ] as any);
      mockApi.getPayees.mockResolvedValue([{ id: "p1", name: "Target" }] as any);
      mockApi.getTransactions.mockResolvedValue([
        { id: "t1", amount: -1299, date: "2026-03-15", payee: "p1" },
      ] as any);

      const match = await provider.findMatchingTransaction(
        "a1",
        12.99,
        "2026-03-15",
        "Walmart",
      );
      expect(match?.id).toBe("t1");
    });
  });

  describe("shutdown", () => {
    it("resets connection state", async () => {
      // First connect
      await provider.getAllCategories().catch(() => {});

      await provider.shutdown();

      expect(mockApi.shutdown).toHaveBeenCalled();

      // After shutdown, next call should re-init
      mockApi.init.mockClear();
      mockApi.downloadBudget.mockClear();
      mockApi.getCategories.mockResolvedValue([]);

      await provider.getAllCategories();

      expect(mockApi.init).toHaveBeenCalled();
      expect(mockApi.downloadBudget).toHaveBeenCalled();
    });
  });
});

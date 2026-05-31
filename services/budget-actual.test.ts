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
        { id: "t1", amount: -1299, date: "2026-03-15", payee: "p1" },
      ] as any);

      const match = await provider.findMatchingTransaction(
        "a1",
        12.99,
        "2026-03-15",
        "Walmart",
      );
      expect(match).toEqual({ id: "t1" });
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
            ? [{ id: "t1", amount: -9552, date: "2026-01-21", payee: "p1" }]
            : []) as any,
      );

      const match = await provider.findMatchingTransaction(
        "a1",
        95.52,
        "2026-01-21",
        "Walmart",
      );

      expect(mockApi.sync).toHaveBeenCalled(); // must pull before reading
      expect(match).toEqual({ id: "t1" }); // → matches, so NO duplicate is created
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

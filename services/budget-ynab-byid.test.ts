// Phase 2a core guarantee: the provider resolves the account by its
// stable YNAB **id**, not its display name. The load-bearing case: the
// account was renamed in YNAB (id unchanged) — createTransaction and
// findMatchingTransaction must still resolve it (no "Account not found"),
// so an import never breaks because the user renamed their account.
import { describe, it, expect, beforeEach, vi } from "vitest";

const createTransaction = vi.fn(async () => ({ data: {} }));
const getTransactionsByAccount = vi.fn(async () => ({ data: { transactions: [] } }));
const getBudgetById = vi.fn();
const fakeApi = {
  budgets: { getBudgetById, withMiddleware: () => fakeApi.budgets },
  transactions: { createTransaction, getTransactionsByAccount, withMiddleware: () => fakeApi.transactions },
};
vi.mock("ynab", () => ({ API: class { budgets = fakeApi.budgets; transactions = fakeApi.transactions; } }));
const { mockGetConfig } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(() => ({ ynabApiKey: "k", ynabBudgetId: "b", ynabCategoryGroups: [], matchAcrossAccounts: false })),
}));
vi.mock("./config", () => ({ getConfig: () => mockGetConfig() }));

import { YnabBudgetProvider } from "./budget-ynab";

// The account was "Bank of America"; the user renamed it. Only the id
// (acc1) is stable. The stored selector is acc1.
const renamedBudget = {
  data: {
    budget: {
      accounts: [{ id: "acc1", name: "Wells Fargo Checking" }],
      categories: [{ id: "cat1", name: "Groceries", category_group_id: "g1" }],
      category_groups: [{ id: "g1", name: "Living" }],
    },
  },
};

describe("YnabBudgetProvider resolves accounts by id, surviving a rename", () => {
  beforeEach(() => {
    createTransaction.mockClear();
    getTransactionsByAccount.mockClear();
    getBudgetById.mockReset().mockResolvedValue(renamedBudget);
  });

  it("createTransaction resolves the account by id (renamed account still imports)", async () => {
    const p = new YnabBudgetProvider();
    await p.createTransaction("acc1", "Amazon", "Groceries", "2026-01-15", "memo", 12.34);
    expect(createTransaction).toHaveBeenCalledTimes(1);
    expect(createTransaction.mock.calls[0][1].transaction.account_id).toBe("acc1");
  });

  it("findMatchingTransaction resolves the account by id (renamed account still matches)", async () => {
    const p = new YnabBudgetProvider();
    await p.findMatchingTransaction("acc1", 12.34, "2026-01-15", "Amazon");
    expect(getTransactionsByAccount).toHaveBeenCalledWith("b", "acc1", expect.anything());
  });

  it("getAllAccounts returns {id,name} pairs (FE needs ids as option values)", async () => {
    const p = new YnabBudgetProvider();
    const accts = await p.getAllAccounts();
    expect(accts).toEqual([{ id: "acc1", name: "Wells Fargo Checking" }]);
  });
});

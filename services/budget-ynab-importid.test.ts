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
const fakeApi = {
  budgets: { getBudgetById, withMiddleware: () => fakeApi.budgets },
  transactions: { createTransaction, withMiddleware: () => fakeApi.transactions },
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

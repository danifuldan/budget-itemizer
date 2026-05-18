// Phase 4: the FE refetches /accounts on picker-open and on a throttled
// window-focus. Without a server cache that's a YNAB call per trigger,
// and the per-token quota is 200/hr. A 60s TTL + in-flight coalescing
// turns a burst into one call while still letting a rename surface
// within a minute. No disk stash / circuit breaker (unlike categories):
// the account list only matters while actively picking — if YNAB is
// down the picker should error, not silently serve a day-old list.
import { describe, it, expect, beforeEach, vi } from "vitest";

const getBudgetById = vi.fn();
const fakeApi = {
  budgets: { getBudgetById, withMiddleware: () => fakeApi.budgets },
  transactions: { withMiddleware: () => fakeApi.transactions },
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
  })),
}));
vi.mock("./config", () => ({ getConfig: () => mockGetConfig() }));

import {
  YnabBudgetProvider,
  _resetAccountsCacheForTests,
} from "./budget-ynab";

const budgetWith = (accounts: { id: string; name: string }[]) => ({
  data: { budget: { accounts: accounts.map((a) => ({ ...a, deleted: false, closed: false })) } },
});

describe("YnabBudgetProvider account cache", () => {
  beforeEach(() => {
    _resetAccountsCacheForTests();
    getBudgetById.mockReset();
    mockGetConfig.mockReturnValue({
      ynabApiKey: "test-token", ynabBudgetId: "test-budget", ynabCategoryGroups: [],
    });
    getBudgetById.mockResolvedValue(budgetWith([{ id: "acc-1", name: "Bank of America" }]));
  });

  it("a burst of getAllAccounts calls hits YNAB only once", async () => {
    const provider = new YnabBudgetProvider();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => provider.getAllAccounts()),
    );
    expect(getBudgetById).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual([{ id: "acc-1", name: "Bank of America" }]);
    for (const r of results) expect(r).toEqual(results[0]);
  });

  // The disagreement: a rename happens at YNAB. Within the 60s TTL the
  // cached (old) name is still served — that's the deliberate API-quota
  // bound. After the cache expires the fresh name wins.
  it("serves the cached list within TTL, the fresh list after expiry", async () => {
    const provider = new YnabBudgetProvider();
    const first = await provider.getAllAccounts();
    expect(first).toEqual([{ id: "acc-1", name: "Bank of America" }]);

    // Account renamed at YNAB.
    getBudgetById.mockResolvedValue(budgetWith([{ id: "acc-1", name: "Wells Fargo Checking" }]));

    // Still within TTL → cached old name, no new YNAB call.
    const cached = await provider.getAllAccounts();
    expect(cached).toEqual([{ id: "acc-1", name: "Bank of America" }]);
    expect(getBudgetById).toHaveBeenCalledTimes(1);

    // Cache expires → fresh name, one more YNAB call.
    _resetAccountsCacheForTests();
    const fresh = await provider.getAllAccounts();
    expect(fresh).toEqual([{ id: "acc-1", name: "Wells Fargo Checking" }]);
    expect(getBudgetById).toHaveBeenCalledTimes(2);
  });

  it("shutdown invalidates the cache so the next call refetches", async () => {
    const provider = new YnabBudgetProvider();
    await provider.getAllAccounts();
    expect(getBudgetById).toHaveBeenCalledTimes(1);

    await provider.shutdown();
    await provider.getAllAccounts();
    expect(getBudgetById).toHaveBeenCalledTimes(2);
  });

  it("does not serve another budget's cached accounts after a budget switch", async () => {
    const provider = new YnabBudgetProvider();
    await provider.getAllAccounts();
    expect(getBudgetById).toHaveBeenCalledTimes(1);

    // Switch budget WITHOUT shutdown — cache is keyed by budget id, so
    // this must refetch rather than serve test-budget's accounts.
    mockGetConfig.mockReturnValue({
      ynabApiKey: "test-token", ynabBudgetId: "other-budget", ynabCategoryGroups: [],
    });
    getBudgetById.mockResolvedValue(budgetWith([{ id: "acc-9", name: "Other Budget Acct" }]));

    const other = await provider.getAllAccounts();
    expect(other).toEqual([{ id: "acc-9", name: "Other Budget Acct" }]);
    expect(getBudgetById).toHaveBeenCalledTimes(2);
  });
});

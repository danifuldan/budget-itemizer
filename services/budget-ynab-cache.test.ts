// Regression test: a burst of receipt parses must not produce a burst of
// YNAB API calls. Each parse calls getAllCategories(); the cache turns
// N parses into 1 call (until TTL expires or budget changes).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const getBudgetById = vi.fn();
// The real ynab SDK has `withMiddleware` for adding timeouts. Stub it as a
// no-op identity function so the API initialization path completes.
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
// vi.mock is hoisted above any non-hoisted variables, so the factory
// can't reference module-scoped vi.fn() directly. Use vi.hoisted to
// move the mock target into the same hoisting tier.
const { mockGetConfig } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(() => ({
    ynabApiKey: "test-token",
    ynabBudgetId: "test-budget",
    ynabCategoryGroups: [],
  })),
}));
vi.mock("./config", () => ({
  getConfig: () => mockGetConfig(),
}));

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  YnabBudgetProvider,
  _resetCategoriesCacheForTests,
  _expireInMemoryCacheForTests,
  _resetCircuitBreakerForTests,
  _setCategoriesDiskFileForTests,
  setCategoriesReconnectCallback,
} from "./budget-ynab";

const fakeBudget = {
  data: {
    budget: {
      categories: [
        { name: "Groceries", id: "c1", category_group_id: "g1", hidden: false, deleted: false },
        { name: "Gas", id: "c2", category_group_id: "g1", hidden: false, deleted: false },
      ],
      category_groups: [{ id: "g1", name: "Living", hidden: false, deleted: false }],
    },
  },
};

// Each test gets its own scratch dir for the disk-stash so they don't leak.
let tmpDir: string;
let stashFile: string;

describe("YnabBudgetProvider category cache", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ynab-cache-test-"));
    stashFile = path.join(tmpDir, "categories.cache.json");
    _setCategoriesDiskFileForTests(stashFile);
    _resetCategoriesCacheForTests();
    _resetCircuitBreakerForTests();
    getBudgetById.mockReset();
    getBudgetById.mockResolvedValue(fakeBudget);
  });

  afterEach(() => {
    _setCategoriesDiskFileForTests(null);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("a burst of getAllCategories calls hits YNAB only once", async () => {
    const provider = new YnabBudgetProvider();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => provider.getAllCategories()),
    );

    expect(getBudgetById).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(50);
    expect(results[0]).toEqual(["Groceries", "Gas"]);
    // Every call returns the same value reference would be ideal but not required;
    // require structural equality.
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it("shutdown invalidates the cache so the next call refetches", async () => {
    const provider = new YnabBudgetProvider();
    await provider.getAllCategories();
    expect(getBudgetById).toHaveBeenCalledTimes(1);

    await provider.shutdown();
    await provider.getAllCategories();

    expect(getBudgetById).toHaveBeenCalledTimes(2);
  });

  // Persistent stash regression: the very first scenario this exists for
  // is "user drops a receipt while offline." YNAB is unreachable; we must
  // still return categories from the last successful fetch instead of
  // refusing to parse.
  it("persists fetched categories to disk for offline use", async () => {
    const provider = new YnabBudgetProvider();
    await provider.getAllCategories();

    expect(fs.existsSync(stashFile)).toBe(true);
    const stash = JSON.parse(fs.readFileSync(stashFile, "utf-8"));
    expect(stash.value).toEqual(["Groceries", "Gas"]);
    expect(stash.savedAt).toMatch(/^\d{4}-/);
  });

  it("falls back to disk stash when YNAB is unreachable", async () => {
    // First call: succeeds, populates disk stash.
    const provider = new YnabBudgetProvider();
    await provider.getAllCategories();
    expect(fs.existsSync(stashFile)).toBe(true);

    // Force in-memory cache to expire so the next call goes to YNAB.
    _resetCategoriesCacheForTests();

    // Now YNAB is "down."
    const networkErr: any = new Error("fetch failed");
    getBudgetById.mockRejectedValueOnce(networkErr);

    // Should NOT throw — should return the stashed list.
    const result = await provider.getAllCategories();
    expect(result).toEqual(["Groceries", "Gas"]);
  });

  it("throws when YNAB is unreachable AND no disk stash exists", async () => {
    const provider = new YnabBudgetProvider();
    const networkErr: any = new Error("fetch failed");
    getBudgetById.mockRejectedValueOnce(networkErr);

    await expect(provider.getAllCategories()).rejects.toThrow();
  });

  it("fires reconnect callback when a real fetch succeeds after a stash fallback", async () => {
    const provider = new YnabBudgetProvider();
    const reconnectSpy = vi.fn();
    setCategoriesReconnectCallback(reconnectSpy);

    // Initial fetch populates stash. Reconnect should NOT fire (this is
    // the first call; nothing to reconnect from).
    await provider.getAllCategories();
    expect(reconnectSpy).not.toHaveBeenCalled();

    // Simulate offline: in-memory cache expired, next fetch falls back to stash.
    _expireInMemoryCacheForTests();
    getBudgetById.mockRejectedValueOnce(new Error("offline"));
    await provider.getAllCategories();
    // Stash path should NOT fire reconnect.
    expect(reconnectSpy).not.toHaveBeenCalled();

    // Now the network comes back. Real fetch succeeds. Reconnect fires once.
    _expireInMemoryCacheForTests();
    getBudgetById.mockResolvedValueOnce(fakeBudget);
    await provider.getAllCategories();
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
    expect(reconnectSpy).toHaveBeenCalledWith(["Groceries", "Gas"]);

    // Subsequent successful fetches should NOT re-fire (no stash gap).
    _expireInMemoryCacheForTests();
    getBudgetById.mockResolvedValueOnce(fakeBudget);
    await provider.getAllCategories();
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
  });

  // Circuit breaker: after a failure with no stash, repeated calls
  // shouldn't all hammer YNAB. The breaker holds them off for a
  // cooldown that grows exponentially.
  it("circuit breaker stops hammering YNAB after a no-stash failure", async () => {
    const provider = new YnabBudgetProvider();
    // Use a fresh budget id with no stash to force the no-stash path.
    mockGetConfig.mockReturnValue({
      ynabApiKey: "t", ynabBudgetId: "no-stash-budget", ynabCategoryGroups: [],
    });
    getBudgetById.mockRejectedValue(new Error("offline"));

    // First call hits YNAB and fails.
    await expect(provider.getAllCategories()).rejects.toThrow();
    expect(getBudgetById).toHaveBeenCalledTimes(1);

    // 49 more calls in a tight burst.
    for (let i = 0; i < 49; i++) {
      _expireInMemoryCacheForTests();
      await expect(provider.getAllCategories()).rejects.toThrow();
    }

    // Without the breaker this would be 50. With it, only the first call
    // actually hit YNAB; the rest were short-circuited by the cooldown.
    expect(getBudgetById).toHaveBeenCalledTimes(1);
  });

  it("circuit breaker resets on next successful fetch", async () => {
    const provider = new YnabBudgetProvider();
    mockGetConfig.mockReturnValue({
      ynabApiKey: "t", ynabBudgetId: "no-stash-budget-2", ynabCategoryGroups: [],
    });

    // First call: YNAB down, no stash → breaker engages.
    getBudgetById.mockRejectedValueOnce(new Error("offline"));
    await expect(provider.getAllCategories()).rejects.toThrow();
    expect(getBudgetById).toHaveBeenCalledTimes(1);

    // Simulate cooldown expiry. A successful fetch should reset breaker.
    _resetCircuitBreakerForTests();
    _expireInMemoryCacheForTests();
    getBudgetById.mockResolvedValueOnce(fakeBudget);
    await provider.getAllCategories();
    expect(getBudgetById).toHaveBeenCalledTimes(2);

    // After success, the breaker is reset — a NEW failure should hit
    // YNAB once (breaker was clear, not still engaged from earlier).
    _expireInMemoryCacheForTests();
    getBudgetById.mockRejectedValueOnce(new Error("offline again"));
    // The success above wrote a disk stash, so this failure now falls
    // back to stash instead of throwing — that's expected, not a breaker
    // bypass. We're verifying the FETCH was attempted (count incremented),
    // which is what tells us the breaker had been cleared.
    await provider.getAllCategories();
    expect(getBudgetById).toHaveBeenCalledTimes(3);
  });

  it("does not use stale stash when the budget id has changed", async () => {
    // Populate stash under one budget id.
    const provider = new YnabBudgetProvider();
    await provider.getAllCategories();

    // Switch budget. Stash on disk has the old key — should be ignored
    // when the cache key differs (otherwise a budget swap could silently
    // route receipts into the wrong account's category list).
    mockGetConfig.mockReturnValue({
      ynabApiKey: "test-token",
      ynabBudgetId: "different-budget",
      ynabCategoryGroups: [],
    });

    _resetCategoriesCacheForTests();
    getBudgetById.mockRejectedValueOnce(new Error("offline"));

    // Different budget + offline + stash for old budget → should throw,
    // not silently use the wrong budget's categories.
    await expect(provider.getAllCategories()).rejects.toThrow();
  });
});

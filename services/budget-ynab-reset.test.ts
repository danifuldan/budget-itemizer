// F7/F9 shared root: YnabBudgetProvider.shutdown() (called by
// resetBudgetProvider on a budget/api-key/provider config change) nulled
// only _categoriesCache. The memoized ynab API client (_api/_budgets/
// _transactions/_lastApiKey) and _categoriesInFlight survived, so after
// the user changed budgets/creds the stale client kept being used
// (wrong-budget write) and an in-flight categories promise could serve
// the old budget's categories. shutdown() must clear ALL memoized state
// so the next access fully rebuilds from current config.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let apiConstructions = 0;
const getBudgetById = vi.fn();
const fakeApi = {
  budgets: { getBudgetById, withMiddleware: () => fakeApi.budgets },
  transactions: { withMiddleware: () => fakeApi.transactions },
};
vi.mock("ynab", () => ({
  API: class {
    budgets = fakeApi.budgets;
    transactions = fakeApi.transactions;
    constructor() {
      apiConstructions++;
    }
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

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  YnabBudgetProvider,
  _resetCategoriesCacheForTests,
  _resetCircuitBreakerForTests,
  _setCategoriesDiskFileForTests,
} from "./budget-ynab";

const fakeBudget = {
  data: {
    budget: {
      categories: [{ name: "Groceries", id: "c1", category_group_id: "g1", hidden: false, deleted: false }],
      category_groups: [{ id: "g1", name: "Living", hidden: false, deleted: false }],
    },
  },
};

let tmpDir: string;

describe("YnabBudgetProvider.shutdown clears the client cache (F7/F9)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ynab-reset-"));
    _setCategoriesDiskFileForTests(path.join(tmpDir, "c.json"));
    _resetCategoriesCacheForTests();
    _resetCircuitBreakerForTests();
    getBudgetById.mockReset().mockResolvedValue(fakeBudget);
    apiConstructions = 0;
  });
  afterEach(() => {
    _setCategoriesDiskFileForTests(null);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("rebuilds the ynab API client after shutdown (no stale client across a config change)", async () => {
    const provider = new YnabBudgetProvider();
    await provider.getAllCategories();
    expect(apiConstructions).toBe(1);

    // resetBudgetProvider() does exactly this on a PROVIDER_AFFECTING
    // config change (e.g. the user switched budgets).
    await provider.shutdown();
    await provider.getAllCategories();

    // The client must have been reconstructed from current config — a
    // stale _api would keep apiConstructions at 1 (the F7 wrong-budget
    // write bug).
    expect(apiConstructions).toBe(2);
  });
});

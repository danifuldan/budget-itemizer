// F8b regression: findMatchingTransaction must snapshot the credential-bound
// YNAB client ONCE and reuse it for every await in the call. The API key can
// change mid-import (the user saves a new YNAB key in Settings while a watcher
// import is in flight). The non-cross-account path does two awaits — an
// account-existence check (getBudgetById) and then a transaction fetch
// (getTransactionsByAccount). Pre-fix, each await independently re-resolved the
// client from the *current* config, so a key change between them validated the
// account under the old token and read transactions under the new one: an
// inconsistent read in the money path.
import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared, hoisted state the mock factories close over. `keyState` is the
// "currently configured" YNAB key; `served` records which key-bound client
// actually served each YNAB call so the test can assert intra-call
// consistency. `onBudgetCheck` lets a test flip the key precisely when the
// account-existence check resolves.
const h = vi.hoisted(() => ({
  state: {
    keyState: "X",
    served: [] as Array<{ call: string; key: string }>,
    onBudgetCheck: null as null | (() => void),
  },
}));

// Each `new ynab.API(key)` is a distinct instance that tags every call it
// serves with the key it was constructed from. withMiddleware() returns the
// same per-instance clients (the real code wraps these for a timeout; the tag
// must survive that wrap), so a snapshot taken before a key change keeps
// serving under the original key.
vi.mock("ynab", () => {
  class API {
    _key: string;
    budgets: { getBudgetById: (id: string) => Promise<unknown>; withMiddleware: () => unknown };
    transactions: {
      getTransactions: (...a: unknown[]) => Promise<unknown>;
      getTransactionsByAccount: (...a: unknown[]) => Promise<unknown>;
      createTransaction: (...a: unknown[]) => Promise<unknown>;
      updateTransaction: (...a: unknown[]) => Promise<unknown>;
      withMiddleware: () => unknown;
    };
    constructor(key: string) {
      this._key = key;
      const self = this;
      this.budgets = {
        getBudgetById: async () => {
          h.state.served.push({ call: "getBudgetById", key: self._key });
          h.state.onBudgetCheck?.();
          return {
            data: {
              budget: {
                accounts: [{ id: "acc1", name: "Checking" }],
                categories: [{ id: "cat1", name: "Groceries", category_group_id: "g1" }],
                category_groups: [{ id: "g1", name: "Living" }],
              },
            },
          };
        },
        withMiddleware: () => self.budgets,
      };
      this.transactions = {
        getTransactions: async () => {
          h.state.served.push({ call: "getTransactions", key: self._key });
          return { data: { transactions: [] } };
        },
        getTransactionsByAccount: async () => {
          h.state.served.push({ call: "getTransactionsByAccount", key: self._key });
          return { data: { transactions: [] } };
        },
        createTransaction: async () => {
          h.state.served.push({ call: "createTransaction", key: self._key });
          return { data: {} };
        },
        updateTransaction: async () => {
          h.state.served.push({ call: "updateTransaction", key: self._key });
          return { data: {} };
        },
        withMiddleware: () => self.transactions,
      };
    }
  }
  return { API };
});

vi.mock("./config", () => ({
  getConfig: () => ({
    ynabApiKey: h.state.keyState,
    ynabBudgetId: "budget-1",
    ynabCategoryGroups: [],
    matchAcrossAccounts: false,
  }),
}));

describe("F8b: findMatchingTransaction snapshots the credential across its awaits", () => {
  beforeEach(() => {
    vi.resetModules(); // fresh _lastApiKey / cached client per test
    h.state.keyState = "X";
    h.state.served = [];
    h.state.onBudgetCheck = null;
  });

  it("fetches transactions under the SAME key as the account check, even when the key changes mid-call", async () => {
    // Flip the configured key the instant the account-existence check
    // resolves — the user saving a new YNAB key while a watcher import runs.
    h.state.onBudgetCheck = () => {
      h.state.keyState = "Y";
    };

    const { YnabBudgetProvider } = await import("./budget-ynab");
    const p = new YnabBudgetProvider();
    await p.findMatchingTransaction("acc1", 47.32, "2026-05-10", "WholeFoods");

    const keys = h.state.served.map((s) => s.key);
    // Pre-fix: ["X", "Y"] — account validated under the old token, transactions
    // read under the new one. Post-fix: ["X", "X"] — one snapshot for the call.
    expect(keys).toEqual(["X", "X"]);
  });

  // The same race lives in the two methods that actually WRITE to YNAB. The
  // pre-mortem on the findMatchingTransaction fix flagged both: a key change
  // between the budget read and the write means the transaction is validated
  // against one budget/token and mutated against another.
  it("updateTransactionWithSplits writes under the same key it read the budget under", async () => {
    h.state.onBudgetCheck = () => {
      h.state.keyState = "Y";
    };

    const { YnabBudgetProvider } = await import("./budget-ynab");
    const p = new YnabBudgetProvider();
    await p.updateTransactionWithSplits("t1", "WholeFoods", "Groceries", "memo", 47.32);

    // getBudgetById then updateTransaction. Pre-fix: ["X","Y"]. Post-fix: ["X","X"].
    expect(h.state.served.map((s) => s.key)).toEqual(["X", "X"]);
  });

  it("createTransaction creates under the same key it read the budget under", async () => {
    h.state.onBudgetCheck = () => {
      h.state.keyState = "Y";
    };

    const { YnabBudgetProvider } = await import("./budget-ynab");
    const p = new YnabBudgetProvider();
    await p.createTransaction("acc1", "WholeFoods", "Groceries", "2026-05-10", "memo", 47.32);

    // getBudgetById then createTransaction. Pre-fix: ["X","Y"]. A create that
    // lands in a different budget than the match search escapes the per-budget
    // import_id dedupe → duplicate. Post-fix: ["X","X"].
    expect(h.state.served.map((s) => s.key)).toEqual(["X", "X"]);
  });
});

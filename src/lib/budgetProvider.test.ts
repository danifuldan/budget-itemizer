import { describe, it, expect } from "vitest";
import { budgetIdFieldFor, budgetIdUpdateFor, accountUpdateFor } from "./budgetProvider";

// The disagreement that broke setup (commit 3175490): an Actual budget
// id MUST land in actualSyncId, never in ynabBudgetId. These pin both
// the field name and the save patch so the two callsites (SetupWizard
// loader + save, SettingsView loader) can't regress to a hardcoded
// "ynabBudgetId".
describe("budgetIdFieldFor", () => {
  it("routes Actual to actualSyncId (not ynabBudgetId)", () => {
    expect(budgetIdFieldFor("actual")).toBe("actualSyncId");
  });
  it("routes YNAB to ynabBudgetId", () => {
    expect(budgetIdFieldFor("ynab")).toBe("ynabBudgetId");
  });
});

describe("budgetIdUpdateFor", () => {
  it("writes an Actual id to actualSyncId and leaves ynabBudgetId absent", () => {
    const patch = budgetIdUpdateFor("actual", "sync-abc");
    expect(patch).toEqual({ actualSyncId: "sync-abc" });
    expect("ynabBudgetId" in patch).toBe(false);
  });
  it("writes a YNAB id to ynabBudgetId and leaves actualSyncId absent", () => {
    const patch = budgetIdUpdateFor("ynab", "budget-123");
    expect(patch).toEqual({ ynabBudgetId: "budget-123" });
    expect("actualSyncId" in patch).toBe(false);
  });
});

// The import target is per-provider. A save must write ONLY the active
// provider's account fields — the absence of the other provider's fields is
// what guarantees saving one provider can't clobber the other's account.
describe("accountUpdateFor", () => {
  it("writes only the Actual account fields, leaving the YNAB ones absent", () => {
    const patch = accountUpdateFor("actual", "act-1", "Spending");
    expect(patch).toEqual({ actualAccountId: "act-1", actualDefaultAccount: "Spending" });
    expect("ynabAccountId" in patch).toBe(false);
    expect("ynabDefaultAccount" in patch).toBe(false);
  });
  it("writes only the YNAB account fields, leaving the Actual ones absent", () => {
    const patch = accountUpdateFor("ynab", "acc-1", "Checking");
    expect(patch).toEqual({ ynabAccountId: "acc-1", ynabDefaultAccount: "Checking" });
    expect("actualAccountId" in patch).toBe(false);
    expect("actualDefaultAccount" in patch).toBe(false);
  });
});

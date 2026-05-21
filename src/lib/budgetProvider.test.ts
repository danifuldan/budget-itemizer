import { describe, it, expect } from "vitest";
import { budgetIdFieldFor, budgetIdUpdateFor } from "./budgetProvider";

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

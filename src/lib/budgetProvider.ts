export type BudgetProviderId = "ynab" | "actual";

/**
 * The config field that stores the selected budget id for a provider:
 * YNAB → `ynabBudgetId`, Actual → `actualSyncId`.
 *
 * Centralized on purpose. A hardcoded `"ynabBudgetId"` at one callsite
 * (SetupWizard) wrote the Actual *sync id* into the YNAB field, so
 * `isSetupComplete()` never saw a budget for the Actual provider and
 * setup looped forever. Both the budget-account loader and the wizard's
 * save step now route through this so the two can't drift again.
 */
export function budgetIdFieldFor(
  provider: BudgetProviderId,
): "ynabBudgetId" | "actualSyncId" {
  return provider === "actual" ? "actualSyncId" : "ynabBudgetId";
}

/**
 * Config patch that persists a selected budget id under the active
 * provider's field, leaving the other provider's field untouched (by
 * omission — callers save partial config). Use when you want to write
 * only the active provider's id, not mirror both.
 */
export function budgetIdUpdateFor(
  provider: BudgetProviderId,
  budgetId: string,
): { ynabBudgetId: string } | { actualSyncId: string } {
  return provider === "actual"
    ? { actualSyncId: budgetId }
    : { ynabBudgetId: budgetId };
}

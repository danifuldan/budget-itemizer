/**
 * Regression (Bug 3): the Setup Wizard's Default Account dropdown must be
 * DISABLED until a budget is selected (it shows "Select budget first" with
 * nothing to load), and must BECOME enabled once a budget is chosen and its
 * accounts load.
 *
 * The deadlock fix changed the disable rule to `loadingAccounts &&
 * accounts.length === 0`, which correctly stops the onMouseDown-refresh from
 * disabling a populated dropdown — but it also flipped the empty-and-idle state
 * (no budget yet) from disabled to ENABLED, so the account dropdown looked
 * clickable before a budget existed. The fix ANDs back the budget gate:
 * `!selectedBudgetId || (loadingAccounts && accounts.length === 0)`.
 *
 * This test guards BOTH halves: disabled before a budget, enabled after — so a
 * future edit can't regress either the affordance or the deadlock fix.
 */
import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("wizard: Default Account dropdown is disabled until a budget is picked, then enabled", async ({ page }) => {
  await mockBackend(page, { modelsDownloaded: true });

  // Test Connection returns the budget list (populates the loader without
  // selecting a budget), and /accounts feeds the dropdown once one is picked.
  await page.route("**/setup/test-ynab", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, budgets: [{ id: "b1", name: "My Budget" }] }) }));
  await page.route(/\/accounts(\?.*)?$/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "a1", name: "Checking" }]) }));

  await page.goto("/");

  // Welcome → AI Setup → Choose Budget App → YNAB creds.
  await page.getByRole("button", { name: "Get Started" }).click();
  await expect(page.getByText("Model ready")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Choose Budget App")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click(); // provider defaults to YNAB

  // Advance to step 4 WITHOUT Test Connection (a real path: paste token, Next).
  // No budgets load, so no budget is selected — the reachable "before a budget"
  // state the account dropdown must reflect.
  await page.locator("#setup-ynab-token").fill("test-token");
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Default Account" })).toBeVisible();

  const accountSelect = page.locator("#setup-default-account");
  // No budget selected → the account dropdown is DISABLED (not a live,
  // clickable-but-inert control). This is the Bug 3 regression: the deadlock
  // fix's bare `&&` left it enabled here.
  await expect(accountSelect).toBeDisabled();
  await expect(accountSelect.locator("option")).toHaveText(["Select budget first"]);

  // Now go back, Test Connection (auto-selects the first budget), and return.
  // With a budget selected and its accounts loaded, the dropdown must be
  // ENABLED — the deadlock-fix half: a populated dropdown must not stay disabled.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Test Connection" }).click();
  await expect(page.getByText(/Connected \(1 budgets?\)/i)).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Default Account" })).toBeVisible();

  await expect(accountSelect).toBeEnabled({ timeout: 10_000 });
  await expect(accountSelect.locator("option[value='a1']")).toHaveText("Checking");
});

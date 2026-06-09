/**
 * Regression (premortem Bug 3): when the /budgets fetch fails, the Budget
 * dropdown used to show "No budgets found" with no indication anything
 * went wrong — primeBudgets swallowed the error. A user with budgets sees
 * an empty list and assumes their data is gone.
 *
 * This spec opens Settings while /budgets returns 500 and asserts an error
 * affordance appears, then that clicking Test Connection (which succeeds)
 * clears it and shows the budget by name.
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("settings: a failed budgets fetch surfaces an error, recovers on Test Connection", async ({ page }) => {
  await mockBackend(page);

  let budgetsShouldFail = true;

  const baseConfig = {
    ynabApiKey: "•••••token",
    ynabBudgetId: "ynab-budget-1",
    defaultAccount: "Checking",
    inboxPath: "/tmp/in",
    processedPath: "/tmp/out",
    budgetProvider: "ynab",
    watcherEnabled: true,
    watcherAutoImport: false,
    watcherFocusApp: true,
    watcherNotify: true,
    minimizeToTray: true,
    matchAcrossAccounts: true,
    discountMode: "distribute",
    hiddenAccounts: [],
  };

  await page.route("**/status", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ setup: true, llmReady: true, watcher: { running: true, path: "/tmp/in" } }),
  }));
  await page.route("**/setup/status", (r) => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ complete: true, config: { hasYnabApiKey: true, ...baseConfig }, auth: { username: "u", password: "p" } }),
  }));
  await page.route("**/config", (route) => {
    if (route.request().method() === "GET") {
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(baseConfig) });
    } else {
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
    }
  });

  // /budgets fails until Test Connection "fixes" it.
  await page.route("**/budgets", (route) => {
    if (budgetsShouldFail) {
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "upstream 500" }) });
    } else {
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "ynab-budget-1", name: "Test Budget" }]) });
    }
  });
  // Test Connection path: returns budgets directly and flips the flag.
  await page.route("**/setup/test-ynab", (route) => {
    budgetsShouldFail = false;
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, budgets: [{ id: "ynab-budget-1", name: "Test Budget" }] }) });
  });
  await page.route("**/accounts?all=true", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "acct-1", name: "Checking" }]) }));
  await page.route("**/accounts", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "acct-1", name: "Checking" }]) }));

  await page.goto("/");
  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await gear.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // The failed fetch must be surfaced, not silently shown as "No budgets found".
  await expect(page.getByText(/couldn.t load budgets/i)).toBeVisible();

  // Test Connection succeeds → error clears and the budget shows by name.
  await page.getByRole("button", { name: "Test Connection" }).click();
  await expect(page.getByText(/couldn.t load budgets/i)).toHaveCount(0);
  await expect(page.getByLabel("Budget", { exact: true })).toHaveValue("ynab-budget-1");
  await expect(page.getByLabel("Budget", { exact: true }).locator("option[value='ynab-budget-1']")).toHaveText("Test Budget");
});

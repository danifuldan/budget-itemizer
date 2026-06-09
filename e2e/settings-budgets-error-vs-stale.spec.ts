/**
 * Regression (premortem round 2, Bug 1): a failed /budgets re-fetch must
 * NOT render the "couldn't load budgets" error while the dropdown still
 * shows a valid, selected budget from a prior successful fetch. The error
 * is only meaningful when there's actually nothing to show.
 *
 * Setup: /budgets succeeds on mount (ynab) and on the Actual leg, then
 * fails on the switch back to YNAB. The YNAB loader still holds the
 * mount-time list, so the dropdown shows "Test Budget" — and the error
 * must stay hidden.
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("settings: budget-load error is suppressed when a budget is already shown", async ({ page }) => {
  await mockBackend(page);
  let provider = "ynab";
  let ynabCalls = 0;

  const baseConfig = {
    ynabApiKey: "•••••token",
    ynabBudgetId: "ynab-budget-1",
    actualSyncId: "actual-sync-1",
    actualServerUrl: "https://localhost:5006",
    ynabAccountId: "acct-1",
    defaultAccount: "Checking",
    inboxPath: "/tmp/in",
    processedPath: "/tmp/out",
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
    body: JSON.stringify({ complete: true, config: { hasYnabApiKey: true, ...baseConfig, budgetProvider: "ynab" }, auth: { username: "u", password: "p" } }),
  }));
  await page.route("**/config", (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...baseConfig, budgetProvider: provider }) });
    } else {
      const body = JSON.parse(req.postData() ?? "{}");
      if (body.budgetProvider) provider = body.budgetProvider;
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
    }
  });
  await page.route("**/budgets", (route) => {
    if (provider === "actual") {
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "actual-sync-1", name: "My Finances" }]) });
      return;
    }
    // YNAB: succeed on mount (first call), fail on the switch-back.
    ynabCalls += 1;
    if (ynabCalls === 1) {
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "ynab-budget-1", name: "Test Budget" }]) });
    } else {
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "upstream 500" }) });
    }
  });
  const accountsFor = () => provider === "ynab" ? [{ id: "acct-1", name: "Checking" }] : [{ id: "a-1", name: "Actual A" }];
  await page.route("**/accounts?all=true", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accountsFor()) }));
  await page.route("**/accounts", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accountsFor()) }));

  await page.goto("/");
  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await gear.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Budget", { exact: true })).toHaveValue("ynab-budget-1");

  // Round-trip; the switch back to YNAB triggers a failing /budgets fetch.
  await page.getByLabel("Budget App").selectOption("actual");
  await page.waitForTimeout(300);
  await page.getByLabel("Budget App").selectOption("ynab");
  await page.waitForTimeout(400);

  // The retained list still shows the budget by name, and the error is hidden.
  await expect(page.getByLabel("Budget", { exact: true })).toHaveValue("ynab-budget-1");
  await expect(page.getByLabel("Budget", { exact: true }).locator("option[value='ynab-budget-1']")).toHaveText("Test Budget");
  await expect(page.getByText(/couldn.t load budgets/i)).toHaveCount(0);
});

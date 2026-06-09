/**
 * Regression: switching the Budget App provider in Settings must show the
 * newly-active provider's budget by its human NAME, not the raw saved id.
 *
 * The bug: handleProviderChange restored the saved budget id and wrote
 * budgetProvider to config, but never re-fetched /budgets for the new
 * provider. So the YNAB budget dropdown fell back to rendering the raw
 * ynabBudgetId (a UUID) until the user clicked Test Connection.
 *
 * This spec starts on Actual, switches to YNAB, and asserts the budget
 * select shows "Test Budget" (and never the raw "ynab-budget-1" id).
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("settings: switching provider shows the budget name, not the raw id", async ({ page }) => {
  await mockBackend(page);

  // Backend's active provider. /budgets returns this provider's budgets
  // (mirrors getBudgetProvider() on the server). Flips on POST /config.
  let provider = "actual";

  const baseConfig = {
    ynabApiKey: "•••••token",
    ynabBudgetId: "ynab-budget-1",
    actualSyncId: "actual-sync-1",
    actualServerUrl: "https://localhost:5006",
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

  await page.route("**/status", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ setup: true, llmReady: true, watcher: { running: true, path: "/tmp/in" } }),
    });
  });

  await page.route("**/setup/status", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        complete: true,
        config: { hasYnabApiKey: true, ...baseConfig, budgetProvider: "actual" },
        auth: { username: "u", password: "p" },
      }),
    });
  });

  await page.route("**/config", (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...baseConfig, budgetProvider: provider }),
      });
    } else {
      const body = JSON.parse(req.postData() ?? "{}");
      if (body.budgetProvider) provider = body.budgetProvider;
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
    }
  });

  // /budgets returns the provider named in the `?provider=` query (the
  // frontend sends it on switch), falling back to the config-active provider
  // for mount reads that omit it — modeling the real backend.
  const providerOf = (url: string) => new URL(url).searchParams.get("provider") || provider;
  await page.route(/\/budgets(\?.*)?$/, (route) => {
    const list = providerOf(route.request().url()) === "ynab"
      ? [{ id: "ynab-budget-1", name: "Test Budget" }]
      : [{ id: "actual-sync-1", name: "My Finances" }];
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list) });
  });
  await page.route(/\/accounts(\?.*)?$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(["Checking", "Savings"]) }));

  await page.goto("/");

  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await gear.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Switch the Budget App from Actual to YNAB.
  await page.getByLabel("Budget App").selectOption("ynab");

  // The YNAB Budget dropdown must show the human name for the saved id,
  // never the raw UUID.
  const budgetSelect = page.getByLabel("Budget", { exact: true });
  await expect(budgetSelect).toHaveValue("ynab-budget-1");
  await expect(budgetSelect.locator("option[value='ynab-budget-1']")).toHaveText("Test Budget");
});

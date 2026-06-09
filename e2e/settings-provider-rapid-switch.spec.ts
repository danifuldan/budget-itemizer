/**
 * Regression (premortem round 3, Bug 1): rapidly toggling the budget app
 * must still settle the saved Default Account, not snap it to the first
 * account. Rapid switches fire several handleProviderChange tails
 * concurrently; without a supersede guard, an intermediate provider's
 * refreshAccounts pollutes the selection and the final refresh falls back
 * to its first account. The fix stamps a sequence per switch and only lets
 * the latest run its re-fetch.
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("settings: rapid provider toggling settles the saved account", async ({ page }) => {
  await mockBackend(page);
  let provider = "ynab";

  const baseConfig = {
    ynabApiKey: "•••••token", ynabBudgetId: "ynab-budget-1", actualSyncId: "actual-sync-1",
    actualServerUrl: "https://localhost:5006", ynabAccountId: "acct-2", defaultAccount: "Savings",
    inboxPath: "/tmp/in", processedPath: "/tmp/out",
    watcherEnabled: true, watcherAutoImport: false, watcherFocusApp: true,
    watcherNotify: true, minimizeToTray: true, matchAcrossAccounts: true,
    discountMode: "distribute", hiddenAccounts: [],
  };

  await page.route("**/status", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ setup: true, llmReady: true, watcher: { running: true, path: "/tmp/in" } }) }));
  await page.route("**/setup/status", (r) => r.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ complete: true, config: { hasYnabApiKey: true, ...baseConfig, budgetProvider: "ynab" }, auth: { username: "u", password: "p" } }) }));
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
  // Keyed off the `?provider=` query (the frontend sends it on switch), with
  // a config-active fallback for mount reads — so the response never depends
  // on /config POST ordering. This is the decoupling under test.
  const providerOf = (url: string) => new URL(url).searchParams.get("provider") || provider;
  await page.route(/\/budgets(\?.*)?$/, (route) => {
    const list = providerOf(route.request().url()) === "ynab" ? [{ id: "ynab-budget-1", name: "Test Budget" }] : [{ id: "actual-sync-1", name: "My Finances" }];
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list) });
  });
  const accountsFor = (url: string) => providerOf(url) === "ynab"
    ? [{ id: "acct-1", name: "Checking" }, { id: "acct-2", name: "Savings" }]
    : [{ id: "a-1", name: "Actual A" }];
  await page.route(/\/accounts(\?.*)?$/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accountsFor(r.request().url())) }));

  await page.goto("/");
  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await gear.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByLabel("Default Account")).toHaveValue("acct-2");

  // Rapid toggles, no settle time between.
  await page.getByLabel("Budget App").selectOption("actual");
  await page.getByLabel("Budget App").selectOption("ynab");
  await page.getByLabel("Budget App").selectOption("actual");
  await page.getByLabel("Budget App").selectOption("ynab");
  await page.waitForTimeout(600);

  // Final state: YNAB, saved budget + account, consistent account list.
  await expect(page.getByLabel("Budget", { exact: true })).toHaveValue("ynab-budget-1");
  await expect(page.getByLabel("Default Account")).toHaveValue("acct-2");
  await expect(page.getByLabel("Default Account").locator("option[value='acct-2']")).toHaveText("Savings");
});

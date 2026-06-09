/**
 * Regression (premortem Bug 1): switching the Budget App away and back
 * must NOT silently change the saved Default Account. The account is the
 * import target, so snapping it to the provider's first account on a
 * round-trip would reroute receipts to the wrong account.
 *
 * The bug: handleProviderChange's added refreshAccounts() ran
 * fetchAccountsFor, which unconditionally re-selected accts[0]. Fixed by
 * making the auto-select preserve a still-present existing selection.
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("settings: default account survives a provider round-trip", async ({ page }) => {
  await mockBackend(page);
  let provider = "ynab";

  const baseConfig = {
    ynabApiKey: "•••••token",
    ynabBudgetId: "ynab-budget-1",
    actualSyncId: "actual-sync-1",
    actualServerUrl: "https://localhost:5006",
    ynabAccountId: "acct-2",
    defaultAccount: "Savings",
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
    body: JSON.stringify({
      complete: true,
      config: { hasYnabApiKey: true, ...baseConfig, budgetProvider: "ynab" },
      auth: { username: "u", password: "p" },
    }),
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
    const list = provider === "ynab"
      ? [{ id: "ynab-budget-1", name: "Test Budget" }]
      : [{ id: "actual-sync-1", name: "My Finances" }];
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list) });
  });
  // Provider-aware accounts (proper AccountRef objects). The YNAB saved
  // account "acct-2" is intentionally NOT the first one.
  const accountsFor = () => provider === "ynab"
    ? [{ id: "acct-1", name: "Checking" }, { id: "acct-2", name: "Savings" }]
    : [{ id: "a-1", name: "Actual A" }];
  await page.route("**/accounts?all=true", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accountsFor()) }));
  await page.route("**/accounts", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(accountsFor()) }));

  await page.goto("/");
  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await gear.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Establish the saved account is selected, then round-trip the provider.
  await expect(page.getByLabel("Default Account")).toHaveValue("acct-2");
  await page.getByLabel("Budget App").selectOption("actual");
  await page.waitForTimeout(300);
  await page.getByLabel("Budget App").selectOption("ynab");

  // The saved Default Account must still be selected after the round-trip.
  await expect(page.getByLabel("Default Account")).toHaveValue("acct-2");
});

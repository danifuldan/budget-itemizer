/**
 * Investigation/regression for complaint (B): selecting Actual should load the
 * Actual budget list immediately — without clicking Test Connection. The app
 * log showed NO /budgets request fired on the provider switch, so budgets only
 * appeared once Test Connection fetched them through its own path.
 *
 * This asserts that after switching to Actual the budget dropdown shows the
 * Actual budget name AND that /budgets?provider=actual was requested — with no
 * Test Connection click.
 */
import { test, expect } from "@playwright/test";

test("settings: switching to Actual loads budgets without Test Connection", async ({ page }) => {
  let provider = "ynab";
  const budgetsUrls: string[] = [];

  const baseConfig = {
    ynabApiKey: "•••••token",
    ynabBudgetId: "ynab-b1",
    actualSyncId: "actual-s1",
    actualServerUrl: "https://localhost:5006",
    ynabAccountId: "",
    actualAccountId: "",
    inboxPath: "/tmp/in",
    processedPath: "/tmp/out",
    watcherEnabled: true,
    watcherAutoImport: false,
    watcherFocusApp: true,
    watcherNotify: true,
    minimizeToTray: true,
    matchAcrossAccounts: true,
    discountMode: "distribute",
    ynabHiddenAccounts: [],
    actualHiddenAccounts: [],
  };

  await page.route("**/status", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ setup: true, llmReady: true, watcher: { running: true, path: "/tmp/in" } }) }));
  await page.route("**/setup/status", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ complete: true, config: { hasYnabApiKey: true, ...baseConfig, budgetProvider: "ynab" }, auth: { username: "u", password: "p" } }) }));
  await page.route("**/config", (r) => {
    const req = r.request();
    if (req.method() === "GET") {
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...baseConfig, budgetProvider: provider }) });
    }
    const body = JSON.parse(req.postData() ?? "{}");
    if (body.budgetProvider) provider = body.budgetProvider;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
  });
  await page.route(/\/budgets(\?.*)?$/, (r) => {
    const url = r.request().url();
    budgetsUrls.push(url);
    const p = new URL(url).searchParams.get("provider") || provider;
    const list = p === "ynab" ? [{ id: "ynab-b1", name: "YNAB Budget" }] : [{ id: "actual-s1", name: "My Finances" }];
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list) });
  });
  await page.route(/\/accounts(\?.*)?$/, (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "acct-apple", name: "Apple Card" }]) }));

  await page.goto("/");
  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await gear.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByLabel("Budget App").selectOption("actual");

  // Budget dropdown must show the Actual budget by name — no Test Connection.
  const budgetSelect = page.getByLabel("Budget", { exact: true });
  await expect(budgetSelect).toHaveValue("actual-s1", { timeout: 10_000 });
  await expect(budgetSelect.locator("option[value='actual-s1']")).toHaveText("My Finances");

  // And a provider=actual budgets fetch actually went out on the switch.
  expect(budgetsUrls.some((u) => u.includes("provider=actual")), `budgets urls: ${JSON.stringify(budgetsUrls)}`).toBe(true);
});

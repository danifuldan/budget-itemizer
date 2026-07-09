/**
 * Regression (B): switching to Actual must load the Actual budgets even when the
 * /config POST response fails to parse on the client. Switching tears down the
 * prior Actual connection ("Closing budget"), which can disrupt the config-write
 * response so apiPost's res.json() rejects. handleProviderChange used to `await`
 * that POST with no catch, so the rejection aborted before primeBudgets — and
 * budgets only appeared after a manual Test Connection.
 *
 * This mocks POST /config as 200-with-empty-body (res.json() throws, mimicking a
 * disrupted response) and asserts the budget dropdown still loads and a
 * /budgets?provider=actual fetch still fires. Fails on the pre-fix handler.
 */
import { test, expect } from "@playwright/test";

test("settings: switching to Actual loads budgets even if the /config POST throws", async ({ page }) => {
  let provider = "ynab";
  const budgetsUrls: string[] = [];
  const baseConfig = {
    ynabApiKey: "•••••token", ynabBudgetId: "ynab-b1", actualSyncId: "actual-s1",
    actualServerUrl: "https://localhost:5006", ynabAccountId: "", actualAccountId: "",
    inboxPath: "/tmp/in", processedPath: "/tmp/out", watcherEnabled: true,
    watcherAutoImport: false, watcherFocusApp: true, watcherNotify: true,
    minimizeToTray: true, matchAcrossAccounts: true, discountMode: "distribute",
    ynabHiddenAccounts: [], actualHiddenAccounts: [],
  };

  await page.route("**/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ setup: true, llmReady: true, watcher: { running: true, path: "/tmp/in" } }) }));
  await page.route("**/setup/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ complete: true, config: { hasYnabApiKey: true, ...baseConfig, budgetProvider: "ynab" }, auth: { username: "u", password: "p" } }) }));
  await page.route("**/config", (r) => {
    const req = r.request();
    if (req.method() === "GET") {
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...baseConfig, budgetProvider: provider }) });
    }
    const body = JSON.parse(req.postData() ?? "{}");
    if (body.budgetProvider) provider = body.budgetProvider;
    // 200 but EMPTY body → the frontend's res.json() throws (disrupted response).
    return r.fulfill({ status: 200, contentType: "application/json", body: "" });
  });
  await page.route(/\/budgets(\?.*)?$/, (r) => {
    budgetsUrls.push(r.request().url());
    const p = new URL(r.request().url()).searchParams.get("provider") || provider;
    const list = p === "ynab" ? [{ id: "ynab-b1", name: "YNAB Budget" }] : [{ id: "actual-s1", name: "My Finances" }];
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list) });
  });
  await page.route(/\/accounts(\?.*)?$/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "acct-apple", name: "Apple Card" }]) }));

  await page.goto("/");
  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await gear.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByLabel("Budget App").selectOption("actual");

  // Despite the thrown config POST, the Actual budget list must load.
  const budgetSelect = page.getByLabel("Budget", { exact: true });
  await expect(budgetSelect).toHaveValue("actual-s1", { timeout: 10_000 });
  await expect(budgetSelect.locator("option[value='actual-s1']")).toHaveText("My Finances");

  // And the provider=actual budgets fetch actually fired (primeBudgets ran).
  expect(budgetsUrls.some((u) => u.includes("provider=actual")), `budgets urls: ${JSON.stringify(budgetsUrls)}`).toBe(true);
});

/**
 * Regression: the Default Account dropdown must stay selectable. It used to
 * deadlock — `onMouseDown` fired a refresh that set loadingAccounts=true, and
 * `disabled={loadingAccounts}` then disabled the select the instant you clicked
 * it, so it could never open to pick a different account. Fixed by disabling
 * only during the initial load (`loadingAccounts && accounts.length === 0`).
 *
 * The mock delays /accounts so the refresh window is observable: after clicking
 * the (already-populated) select, it must NOT be disabled, and a second account
 * must be selectable.
 */
import { test, expect } from "@playwright/test";

test("settings: Default Account stays selectable during an open-triggered refresh", async ({ page }) => {
  let provider = "ynab";
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
    if (req.method() === "GET") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...baseConfig, budgetProvider: provider }) });
    const body = JSON.parse(req.postData() ?? "{}");
    if (body.budgetProvider) provider = body.budgetProvider;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
  });
  await page.route(/\/budgets(\?.*)?$/, (r) => {
    const p = new URL(r.request().url()).searchParams.get("provider") || provider;
    const list = p === "ynab" ? [{ id: "ynab-b1", name: "YNAB Budget" }] : [{ id: "actual-s1", name: "My Finances" }];
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list) });
  });
  // Delay /accounts so loadingAccounts is observably true during a refresh.
  await page.route(/\/accounts(\?.*)?$/, async (r) => {
    await new Promise((res) => setTimeout(res, 700));
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "acct-apple", name: "Apple Card" }, { id: "acct-checking", name: "Checking" }]) });
  });

  await page.goto("/");
  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await gear.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByLabel("Budget App").selectOption("actual");

  const acct = page.getByLabel("Default Account", { exact: true });
  // Wait for accounts to finish the initial load (select populated + enabled).
  await expect(acct).toHaveValue("acct-apple", { timeout: 10_000 });
  await expect(acct).toBeEnabled();

  // Click to open — this fires the onMouseDown refresh (loadingAccounts=true
  // for ~700ms). The select must NOT disable itself now that accounts exist.
  await acct.click();
  expect(await acct.isDisabled(), "select disabled itself on open (deadlock)").toBe(false);

  // And a different account is selectable and persists.
  await acct.selectOption("acct-checking");
  await expect(acct).toHaveValue("acct-checking");
});

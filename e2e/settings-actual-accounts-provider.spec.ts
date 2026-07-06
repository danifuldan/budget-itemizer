/**
 * Regression: switching to Actual must load the Actual account list, and every
 * /accounts request must carry ?provider= (never a bare call that the server
 * resolves against its stale config-active guess).
 *
 * The bug: no-provider account fetches resolved to YNAB while on Actual; YNAB
 * was unreachable, the call failed, and last-write-wins blanked the good Actual
 * result — so the Default Account dropdown stayed empty until a manual click.
 *
 * This mock returns the Actual account ONLY for provider=actual; a bare or
 * provider=ynab call 500s (simulating unreachable YNAB). So the dropdown fills
 * iff the frontend sent provider=actual — and we also assert no /accounts
 * request ever went out without a provider.
 */
import { test, expect } from "@playwright/test";

test("settings: switching to Actual loads accounts via provider=actual, never bare", async ({ page }) => {
  let provider = "ynab";
  const accountsUrls: string[] = [];

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
    const p = new URL(r.request().url()).searchParams.get("provider") || provider;
    const list = p === "ynab" ? [{ id: "ynab-b1", name: "YNAB Budget" }] : [{ id: "actual-s1", name: "My Finances" }];
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list) });
  });
  // The crux: branch on ?provider. Actual → Apple Card; bare/ynab → simulate
  // the unreachable-YNAB failure that used to blank the list.
  await page.route(/\/accounts(\?.*)?$/, (r) => {
    const url = r.request().url();
    accountsUrls.push(url);
    const p = new URL(url).searchParams.get("provider");
    if (p === "actual") {
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "acct-apple", name: "Apple Card" }]) });
    }
    return r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Could not connect to YNAB" }) });
  });

  await page.goto("/");
  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await gear.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Switch the Budget App to Actual.
  await page.getByLabel("Budget App").selectOption("actual");

  // The Default Account dropdown must populate with the Actual account —
  // only possible if the fetch carried provider=actual.
  const acct = page.getByLabel("Default Account", { exact: true });
  await expect(acct).toHaveValue("acct-apple", { timeout: 10_000 });
  await expect(acct.locator("option[value='acct-apple']")).toHaveText("Apple Card");

  // Regression guard: NOT ONE /accounts request went out without a provider.
  const bare = accountsUrls.filter((u) => !new URL(u).searchParams.has("provider"));
  expect(bare, `bare /accounts calls: ${JSON.stringify(bare)}`).toHaveLength(0);
});

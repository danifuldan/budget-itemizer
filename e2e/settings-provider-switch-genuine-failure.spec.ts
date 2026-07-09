/**
 * Regression (Bug 2, Medium): a GENUINE /config failure on provider switch must
 * be surfaced, not swallowed as a phantom success.
 *
 * handleProviderChange wraps the switch write in try/catch. That catch is
 * correct for ONE case: a 200 whose body is truncated by the "Closing budget"
 * teardown, which makes res.json() reject with a PARSE error though the write
 * committed (see settings-budgets-load-on-config-throw). But it must NOT swallow
 * a non-2xx (ApiError): on the server, saveConfig runs AFTER the teardown, so a
 * non-2xx means the write did NOT commit — the backend is still on the OLD
 * provider. Swallowing it and priming the new provider's data shows the user a
 * switch that never happened.
 *
 * This mocks POST /config → 400 and asserts: (1) an error is surfaced, and
 * (2) primeBudgets did NOT run for the new provider (no /budgets?provider=actual).
 * Fails on the pre-fix indiscriminate catch.
 */
import { test, expect } from "@playwright/test";

test("settings: a non-2xx /config on provider switch surfaces an error and does not phantom-switch", async ({ page }) => {
  const provider = "ynab"; // backend stays on ynab — the 400 never commits the switch
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
    // Genuine failure: non-2xx, write NOT committed. apiFetch throws an ApiError.
    return r.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "actual server unreachable" }) });
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

  // Attempt the switch — the backend rejects it (400).
  await page.getByLabel("Budget App").selectOption("actual");

  // The failure is surfaced, not silently shown as a successful switch.
  await expect(page.getByText(/couldn't switch budget app/i)).toBeVisible({ timeout: 10_000 });

  // And the new provider's budgets were NOT primed (the switch didn't persist).
  expect(
    budgetsUrls.some((u) => u.includes("provider=actual")),
    `no provider=actual budgets should have been fetched; got: ${JSON.stringify(budgetsUrls)}`,
  ).toBe(false);
});

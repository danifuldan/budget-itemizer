/**
 * Durable fix: leaving Settings for the main view re-reads /config, and the
 * provider-scoped lists (accounts + categories) are refetched ONLY when the
 * active provider actually changed.
 *
 * Settings commits a provider switch via a direct /config write that bypasses
 * App's useConfig, and useConfig fetches /config only once (no interval). So
 * after switching WITHOUT a full Save, appConfig stayed stale: activeAccountId
 * (the default import account) and the bare lists kept showing the OLD provider
 * until a focus refresh or restart. onBack now re-reads /config; a provider
 * change triggers the list refetch.
 *
 * Test 1: a switch → /config + bare /accounts + bare /categories all refire.
 * Test 2 (efficiency guard): a no-op Settings visit → only /config refires; the
 * budget-API list calls do NOT, so idle Settings toggling can't burn quota.
 */
import { test, expect, type Page } from "@playwright/test";

const baseConfig = {
  ynabApiKey: "•••••token", ynabBudgetId: "ynab-b1", actualSyncId: "actual-s1",
  actualServerUrl: "https://localhost:5006", ynabAccountId: "ynab-acct", actualAccountId: "actual-acct",
  inboxPath: "/tmp/in", processedPath: "/tmp/out", watcherEnabled: true,
  watcherAutoImport: false, watcherFocusApp: true, watcherNotify: true,
  minimizeToTray: true, matchAcrossAccounts: true, discountMode: "distribute",
  ynabHiddenAccounts: [], actualHiddenAccounts: [],
};

async function mockMainView(page: Page, initialProvider: "ynab" | "actual" = "ynab") {
  const state = { provider: initialProvider };
  const configGets: string[] = [];
  const bareAccountsGets: string[] = [];
  const bareCategoriesGets: string[] = [];

  await page.route("**/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ setup: true, llmReady: true, watcher: { running: true, path: "/tmp/in" } }) }));
  await page.route("**/setup/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ complete: true, config: { hasYnabApiKey: true, ...baseConfig, budgetProvider: initialProvider }, auth: { username: "u", password: "p" } }) }));
  await page.route("**/config", (r) => {
    const req = r.request();
    if (req.method() === "GET") {
      configGets.push(req.url());
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...baseConfig, budgetProvider: state.provider }) });
    }
    const body = JSON.parse(req.postData() ?? "{}");
    if (body.budgetProvider) state.provider = body.budgetProvider; // switch commits server-side
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
  });
  await page.route(/\/budgets(\?.*)?$/, (r) => {
    const p = new URL(r.request().url()).searchParams.get("provider") || state.provider;
    const list = p === "ynab" ? [{ id: "ynab-b1", name: "YNAB Budget" }] : [{ id: "actual-s1", name: "My Finances" }];
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list) });
  });
  await page.route(/\/accounts(\?.*)?$/, (r) => {
    const url = r.request().url();
    if (!new URL(url).searchParams.has("provider")) bareAccountsGets.push(url);
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "actual-acct", name: "Apple Card" }]) });
  });
  await page.route(/\/categories(\?.*)?$/, (r) => {
    const url = r.request().url();
    if (!new URL(url).searchParams.has("provider")) bareCategoriesGets.push(url);
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(["Groceries"]) });
  });

  await page.goto("/");
  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  // Mount fired one bare read of each — wait so the snapshot is stable.
  await expect.poll(() => configGets.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => bareAccountsGets.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => bareCategoriesGets.length, { timeout: 10_000 }).toBeGreaterThan(0);

  return { gear, configGets, bareAccountsGets, bareCategoriesGets };
}

test("switching provider then leaving Settings refetches config + bare accounts + bare categories", async ({ page }) => {
  const { gear, configGets, bareAccountsGets, bareCategoriesGets } = await mockMainView(page);

  await gear.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByLabel("Budget App").selectOption("actual"); // switch, no full Save

  const cfgBefore = configGets.length;
  const acctBefore = bareAccountsGets.length;
  const catBefore = bareCategoriesGets.length;

  await page.getByRole("button", { name: /back/i }).first().click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeHidden();

  // /config re-read, and the provider change triggers the list refetch.
  await expect.poll(() => configGets.length, { timeout: 10_000 }).toBeGreaterThan(cfgBefore);
  await expect.poll(() => bareAccountsGets.length, { timeout: 10_000 }).toBeGreaterThan(acctBefore);
  await expect.poll(() => bareCategoriesGets.length, { timeout: 10_000 }).toBeGreaterThan(catBefore);
});

test("a no-op Settings visit refetches only /config, not the budget-API lists", async ({ page }) => {
  const { gear, configGets, bareAccountsGets, bareCategoriesGets } = await mockMainView(page);

  await gear.click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  const cfgBefore = configGets.length;
  const acctBefore = bareAccountsGets.length;
  const catBefore = bareCategoriesGets.length;

  // Leave without changing anything.
  await page.getByRole("button", { name: /back/i }).first().click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeHidden();

  // /config re-read fires…
  await expect.poll(() => configGets.length, { timeout: 10_000 }).toBeGreaterThan(cfgBefore);
  // …but the provider didn't change, so no bare list refetch (no wasted budget-API calls).
  await page.waitForTimeout(500);
  expect(bareAccountsGets.length, "bare /accounts must not refetch on a no-op visit").toBe(acctBefore);
  expect(bareCategoriesGets.length, "bare /categories must not refetch on a no-op visit").toBe(catBefore);
});

test("an already-configured Actual startup fetches each bare list once (no redundant refetch)", async ({ page }) => {
  // Provider is Actual from the first byte. The provider-change effect must
  // BASELINE off the first authoritative /config load rather than the pre-load
  // "ynab" default — otherwise ynab→actual looks like a change and refetches
  // the lists a second time at startup.
  const { bareAccountsGets, bareCategoriesGets } = await mockMainView(page, "actual");
  await page.waitForTimeout(750); // let any spurious effect-triggered refetch land
  expect(bareAccountsGets.length, `bare /accounts at startup: ${JSON.stringify(bareAccountsGets)}`).toBe(1);
  expect(bareCategoriesGets.length, `bare /categories at startup: ${JSON.stringify(bareCategoriesGets)}`).toBe(1);
});

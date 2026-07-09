/**
 * Regression (Bug 1, High): the MAIN VIEW must read /accounts and /categories
 * BARE — letting the server use its authoritative on-disk config-active
 * provider. A branch change pinned these fetches to App's cached
 * appConfig.budgetProvider, which is fetched once and never refetched (no
 * interval; onBack is a bare NAVIGATE). After an in-session provider switch it
 * goes STALE, so the main view fetched the OLD provider's accounts/categories
 * and — worse — a refresh kept sending the wrong ?provider= explicitly, so it
 * could never self-heal. On master the bare call self-healed on the next
 * refresh because the server is authoritative.
 *
 * The catch is at the mount fetch: re-introducing the stale-provider pin makes
 * these requests carry ?provider=..., which this asserts against. No review
 * state needed — the fetches fire the moment the main view mounts.
 */
import { test, expect } from "@playwright/test";

test("main view: /accounts and /categories are fetched bare (server-authoritative)", async ({ page }) => {
  const accountsUrls: string[] = [];
  const categoriesUrls: string[] = [];
  const baseConfig = {
    ynabApiKey: "•••••token", ynabBudgetId: "ynab-b1", actualSyncId: "actual-s1",
    actualServerUrl: "https://localhost:5006", ynabAccountId: "", actualAccountId: "",
    inboxPath: "/tmp/in", processedPath: "/tmp/out", watcherEnabled: true,
    watcherAutoImport: false, watcherFocusApp: true, watcherNotify: true,
    minimizeToTray: true, matchAcrossAccounts: true, discountMode: "distribute",
    ynabHiddenAccounts: [], actualHiddenAccounts: [],
    // Backend is on Actual — a bare call must resolve to Actual server-side.
    budgetProvider: "actual",
  };

  await page.route("**/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ setup: true, llmReady: true, watcher: { running: true, path: "/tmp/in" } }) }));
  await page.route("**/setup/status", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ complete: true, config: { hasYnabApiKey: true, ...baseConfig }, auth: { username: "u", password: "p" } }) }));
  await page.route("**/config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(baseConfig) }));
  await page.route(/\/accounts(\?.*)?$/, (r) => {
    accountsUrls.push(r.request().url());
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "acct-1", name: "Checking" }]) });
  });
  await page.route(/\/categories(\?.*)?$/, (r) => {
    categoriesUrls.push(r.request().url());
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(["Groceries", "Household"]) });
  });
  await page.route("**/pending", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/history", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/auth/sse-token", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ token: "t" }) }));

  await page.goto("/");

  // Main view rendered (has the settings gear) → the account/category reads have fired.
  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await expect.poll(() => accountsUrls.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => categoriesUrls.length, { timeout: 10_000 }).toBeGreaterThan(0);

  // Every main-view read is BARE — no ?provider= pin (which would go stale).
  for (const u of accountsUrls) expect(u, `accounts url must be bare: ${u}`).not.toContain("provider=");
  for (const u of categoriesUrls) expect(u, `categories url must be bare: ${u}`).not.toContain("provider=");
});

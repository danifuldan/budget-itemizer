/**
 * The Actual provider had no Test-Connection e2e coverage — the existing
 * settings-save-and-test spec is YNAB-only, which is why GUI verification
 * of the Actual path kept falling back to a manual click. This drives the
 * Actual Test Connection flow end to end against a mocked backend: open
 * Settings with provider=actual, type the server password, click Test
 * Connection, and assert the success pill renders and the budget dropdown
 * populates from /setup/test-actual with one option per budget.
 *
 * The dedupe of local+remote budget copies lives server-side in
 * getAllBudgets() and is asserted in services/budget-actual.test.ts; here
 * we assert the UI renders exactly what the endpoint returns (no dupes
 * introduced or dropped on the way to the dropdown).
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("settings: Actual Test Connection shows Connected and populates the budget dropdown", async ({ page }) => {
  // mockBackend first — last-registered-wins, so overrides below take precedence.
  await mockBackend(page);

  await page.route("**/status", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        setup: true,
        llmReady: true,
        watcher: { running: true, path: "/tmp/in" },
      }),
    });
  });

  // Saved config selects the Actual provider so the Actual fields render
  // on open. No actualSyncId yet → the dropdown starts empty and is filled
  // by the Test Connection response (the flow under test).
  const actualConfig = {
    budgetProvider: "actual",
    actualServerUrl: "https://localhost:5006",
    actualPasswordLength: 8,
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

  await page.route("**/setup/status", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        complete: true,
        config: { ...actualConfig, hasActualPassword: true },
        auth: { username: "u", password: "p" },
      }),
    });
  });

  await page.route("**/config", (route) => {
    if (route.request().method() === "GET") {
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(actualConfig) });
    } else {
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
    }
  });

  // Fetched once on Settings open (loader's list; the Actual UI uses its own).
  // Regex matcher so the `?provider=` query suffix is matched.
  await page.route(/\/budgets(\?.*)?$/, (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
  });

  // The endpoint returns the already-deduped list (the server-side dedupe is
  // unit-tested separately). Two distinct budgets, one row each.
  await page.route("**/setup/test-actual", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        budgets: [
          { id: "697f180e", name: "My Finances" },
          { id: "34ec2039", name: "Budget" },
        ],
      }),
    });
  });

  await page.route(/\/accounts(\?.*)?$/, (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(["Checking", "Savings"]) });
  });

  await page.goto("/");

  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await gear.click();

  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Provider is Actual (from config) → Actual fields shown, URL pre-filled.
  await expect(page.getByLabel("Server URL")).toHaveValue("https://localhost:5006");

  // Type the server password and click Test Connection.
  await page.getByLabel("Password").fill("hunter2!!");

  const testActualPost = page.waitForRequest(
    (req) => req.url().includes("/setup/test-actual") && req.method() === "POST",
  );
  await page.getByRole("button", { name: "Test Connection" }).click();
  await testActualPost;

  // Success pill renders.
  await expect(page.locator(".test-result.success")).toContainText("Connected");

  // Budget dropdown populated with exactly the two returned budgets — no
  // duplicate rows, in order.
  const budgetSelect = page.locator("#settings-actual-budget");
  await expect(budgetSelect.locator("option")).toHaveText(["My Finances", "Budget"]);
});

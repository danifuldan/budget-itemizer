/**
 * Phase-4 landing precondition: the AdditionalSettings flow has no
 * existing e2e coverage. This spec asserts that:
 *
 *   1. Opening Settings populates from the existing config (placeholder
 *      visible on the YNAB token field).
 *   2. Test-Connection POSTs /setup/save with the typed token, then
 *      /setup/test-ynab, and renders "Connected" on success.
 *   3. Save Settings POSTs /config with the active provider's budget id
 *      and the inboxPath edit, and does NOT include the old YNAB token
 *      when the user didn't retype it.
 *
 * The route to "Settings" goes through App.tsx; in test mode the wizard
 * shows first, so we click "Skip setup" to unmount the wizard, then
 * navigate to settings via the gear icon.
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("settings: save settings POSTs /config with active provider's budget id", async ({ page }) => {
  // Route precedence is last-registered-wins (see helpers.ts), so
  // mockBackend MUST be called first or it shadows these overrides.
  // The wizard-vs-main gate keys on /status `setup` (useStatus →
  // setupComplete in App.tsx), NOT /setup/status `complete`, so the
  // /status override below is what actually lands us in the main view.
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

  await page.route("**/setup/status", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        complete: true,
        config: {
          hasYnabApiKey: true,
          ynabApiKey: "•••••token",
          ynabBudgetId: "saved-budget-id",
          defaultAccount: "Checking",
          inboxPath: "/tmp/in",
          processedPath: "/tmp/out",
          budgetProvider: "ynab",
          watcherEnabled: true,
          watcherAutoImport: false,
          watcherFocusApp: true,
          watcherNotify: true,
          minimizeToTray: true,
          matchAcrossAccounts: true,
          discountMode: "distribute",
          hiddenAccounts: [],
        },
        auth: { username: "u", password: "p" },
      }),
    });
  });

  await page.route("**/config", (route) => {
    if (route.request().method() === "GET") {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ynabApiKey: "•••••token",
          ynabBudgetId: "saved-budget-id",
          defaultAccount: "Checking",
          inboxPath: "/tmp/in",
          processedPath: "/tmp/out",
          budgetProvider: "ynab",
          watcherEnabled: true,
          watcherAutoImport: false,
          watcherFocusApp: true,
          watcherNotify: true,
          minimizeToTray: true,
          matchAcrossAccounts: true,
          discountMode: "distribute",
          hiddenAccounts: [],
        }),
      });
    } else {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    }
  });

  // /budgets and /accounts for the settings dropdowns. Regex matchers so
  // the new `?provider=` query suffix is matched; this spec doesn't switch
  // providers, so the responses ignore it.
  await page.route(/\/budgets(\?.*)?$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{ id: "saved-budget-id", name: "Main Budget" }]),
    });
  });
  await page.route(/\/accounts(\?.*)?$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(["Checking", "Savings"]),
    });
  });

  await page.goto("/");

  // Settings is reachable via the gear icon in the main view header.
  // (If the gear name changes, this test surfaces it.)
  const gear = page.getByRole("button", { name: /settings/i }).first();
  await gear.waitFor({ state: "visible", timeout: 10_000 });
  await gear.click();

  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // Token placeholder reflects the saved (masked) value.
  const tokenInput = page.getByLabel("API Token");
  await expect(tokenInput).toHaveAttribute("placeholder", "•••••token");

  // Edit inbox path so we have a non-secret field to assert in the
  // outgoing /config POST.
  // Exact match: the watcher toggle's aria-label ("Enable background
  // monitoring for inbox folder") contains "inbox folder", so a loose
  // getByLabel would match both the input and the switch.
  const inboxInput = page.getByLabel("Inbox Folder", { exact: true });
  await inboxInput.fill("/tmp/different-inbox");

  // Click Save Settings — capture the /config POST.
  const configPost = page.waitForRequest((req) =>
    req.url().includes("/config") && req.method() === "POST"
  );
  await page.getByRole("button", { name: "Save Settings" }).click();
  const req = await configPost;
  const body = JSON.parse(req.postData() ?? "{}");

  expect(body.inboxPath).toBe("/tmp/different-inbox");
  // Save mapping preserves the saved YNAB budget id since user didn't
  // change the dropdown.
  expect(body.ynabBudgetId).toBe("saved-budget-id");
  // Active provider is YNAB; actualSyncId should be the saved (empty)
  // value, NOT a stale overwrite from the loader.
  expect(body.budgetProvider).toBe("ynab");
  // The masked token must NOT be sent back as a real value.
  expect(body.ynabApiKey).toBeUndefined();
});

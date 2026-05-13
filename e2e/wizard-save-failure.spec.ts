/**
 * Bug 4 regression: SetupWizard `goNext` ignores `saveSetup` return value.
 *
 * Pre-fix, `goNext` called `await saveSetup({...})` then unconditionally
 * `setStep((s) => s + 1)`. `useSetup.ts saveSetup` catches every error and
 * returns `false`, but the caller never reads the return value. A network
 * blip mid-wizard advanced the user past a step whose data wasn't
 * persisted; they finished the wizard with missing fields and didn't
 * notice until next launch.
 *
 * Fix: read the boolean. On `false`, set `advanceError` (rendered as a
 * `wizard-banner-warning`) and do not advance.
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("wizard stays on step 1 and shows error banner when saveSetup returns success:false", async ({ page }) => {
  // Model is already downloaded — Next button on step 1 is enabled after
  // the /models/available fetch sets downloadDone=true.
  await mockBackend(page, { modelsDownloaded: true });

  // Override /setup/save to simulate the failure mode (network blip, server
  // error, Keychain unwriteable, etc.) — returns 200 with success:false,
  // which is the path saveSetup translates into Boolean false.
  await page.route("**/setup/save", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: false, error: "simulated save failure" }),
    });
  });

  await page.goto("/");

  // Welcome step → AI Setup step.
  await page.getByRole("button", { name: "Get Started" }).click();
  await expect(page.getByText("AI Setup")).toBeVisible();

  // Wait for the model-available fetch + downloadDone to flip true.
  // The "Model ready" line is the visible signal that the Next button
  // will be enabled.
  await expect(page.getByText("Model ready")).toBeVisible();

  // Click Next — goNext calls saveSetup({ embeddedModel: "llama3.1-8b", ... })
  // which returns false because our mock said success:false.
  await page.getByRole("button", { name: "Next" }).click();

  // Critical assertion 1: wizard did NOT advance to step 2 ("Choose Budget App").
  await expect(page.getByText("Choose Budget App")).not.toBeVisible();

  // Critical assertion 2: still on step 1.
  await expect(page.getByText("AI Setup")).toBeVisible();

  // Critical assertion 3: an error banner is visible explaining why.
  // The wizard renders advanceError via a wizard-banner-warning with role="alert".
  await expect(page.getByRole("alert")).toContainText(/save|settings|connection|try again/i);
});

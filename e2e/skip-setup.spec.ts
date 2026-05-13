/**
 * Regression: "Skip setup" did not actually skip.
 *
 * The original bug: clicking "Skip setup" dispatched DISMISS_SETUP but
 * `setupDismissed` wasn't being set correctly in the reducer, so the wizard
 * condition `(!status.setupComplete && !state.setupDismissed)` remained true
 * and the wizard re-rendered immediately after dismissal.
 *
 * After the fix, DISMISS_SETUP sets `setupDismissed: true` in the reducer,
 * the wizard condition becomes false, and the wizard unmounts — the welcome
 * heading is no longer in the DOM.
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("skip setup dismisses the wizard", async ({ page }) => {
  await mockBackend(page);

  await page.goto("/");

  // Step 0 of the wizard is visible.
  await expect(page.getByText("Welcome to Budget Itemizer")).toBeVisible();

  // Click "Skip setup".
  await page.getByRole("button", { name: "Skip setup" }).click();

  // The wizard must have unmounted — the welcome heading should be gone.
  // If the regression is present, the wizard re-renders and the heading
  // remains visible.
  await expect(page.getByText("Welcome to Budget Itemizer")).not.toBeVisible();
});

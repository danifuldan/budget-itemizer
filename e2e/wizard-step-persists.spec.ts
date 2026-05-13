/**
 * Regression: wizard step resets under rapid status polling.
 *
 * Before the fix, `loaded` in useStatus was derived from `!loading`, which
 * flipped back to false on every 3-second poll. App.tsx gated on `!loaded` to
 * show the SplashScreen, so the SplashScreen re-mounted on each poll —
 * unmounting SetupWizard and resetting its `step` state back to 0.
 *
 * After the fix, `loaded` is a sticky boolean (`hasLoaded` in useStatus) that
 * only ever goes from false → true and never resets. The wizard should remain
 * on step 1 ("AI Setup") even after multiple polls have fired.
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("wizard stays on step 1 after multiple status polls", async ({ page }) => {
  await mockBackend(page);

  await page.goto("/");

  // App renders the wizard because setup is not complete and not dismissed.
  // Step 0 shows "Welcome to Budget Itemizer".
  await expect(page.getByText("Welcome to Budget Itemizer")).toBeVisible();

  // Advance to step 1.
  await page.getByRole("button", { name: "Get Started" }).click();

  // Step 1 is "AI Setup".
  await expect(page.getByText("AI Setup")).toBeVisible();

  // Wait at least 7 seconds — enough for at least two 3-second useStatus
  // polls to fire and complete. The poll calls /status (mocked) and briefly
  // sets loading=true, which previously caused the splash to re-mount.
  await page.waitForTimeout(7_500);

  // The wizard must still be on step 1; "AI Setup" must still be visible.
  // If the regression is present, the component has unmounted and remounted,
  // resetting to step 0, and "Welcome to Budget Itemizer" would be visible
  // instead.
  await expect(page.getByText("AI Setup")).toBeVisible();
  await expect(page.getByText("Welcome to Budget Itemizer")).not.toBeVisible();
});

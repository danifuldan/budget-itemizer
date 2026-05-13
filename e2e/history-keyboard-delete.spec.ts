/**
 * Bug 3 regression: hidden Delete History button keyboard-focusable.
 *
 * The swipe-to-delete background on each HistoryRow was made a real <button>
 * during the a11y pass (commit 3cc5d45). CSS keeps it `opacity: 0;
 * pointer-events: none` until the row is swipe-revealed, but
 * `pointer-events: none` only blocks mouse events — focus and keyboard
 * activation are unaffected. A keyboard user could Tab to an invisible
 * delete button (no visible focus ring because it's at opacity:0) and
 * Enter through it, deleting a record without confirmation.
 *
 * Fix: `tabIndex={revealed ? 0 : -1}` and `aria-hidden={!revealed}` on the
 * button, so screen readers + Tab order both skip it while it's hidden.
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("hidden delete button on a history row is not in the tab order", async ({ page }) => {
  // Return a record so HistoryRow actually renders.
  // Order matters: register this BEFORE mockBackend so our /history mock
  // wins over the empty default.
  await page.route("**/history*", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "row-1",
          filename: "walmart.pdf",
          merchant: "Walmart",
          totalAmount: 42.99,
          itemCount: 3,
          transactionDate: "2026-05-01",
          importedAt: "2026-05-01T12:00:00Z",
          success: true,
        },
      ]),
    });
  });
  await mockBackend(page);

  await page.goto("/");

  // Bypass the setup wizard via Skip — same pattern as skip-setup.spec.
  await page.getByRole("button", { name: "Skip setup" }).click();

  // Find the row's delete button by its aria-label (only it has this text).
  const deleteButton = page.getByLabel("Delete Walmart record");
  await expect(deleteButton).toBeAttached();

  // Critical assertion: while the row is collapsed (no .revealed class),
  // the button is removed from the tab order. Without the fix, default
  // <button> tabIndex is 0 and the button is reachable.
  await expect(deleteButton).toHaveAttribute("tabindex", "-1");
  await expect(deleteButton).toHaveAttribute("aria-hidden", "true");
});

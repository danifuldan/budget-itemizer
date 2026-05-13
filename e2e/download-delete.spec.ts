/**
 * Regression: delete model silently dropped the fetch request.
 *
 * The original bug: the wizard used `window.confirm()` for the delete
 * confirmation. In the Tauri webview, `window.confirm` always returns false
 * (dialog is suppressed), so the guard `if (!confirm(...)) return` exited
 * before calling the delete endpoint — no request ever fired.
 *
 * After the fix, the confirmation is handled by the in-app <ConfirmDialog>
 * component (a React modal), which is testable. Clicking "Delete" in that
 * dialog must trigger a POST to /models/delete.
 *
 * This test:
 * 1. Mocks /models/available to report the model as already downloaded,
 *    which causes the wizard to show "Model ready" with an X button.
 * 2. Navigates to the AI Setup step (step 1).
 * 3. Clicks the X button next to "Model ready".
 * 4. Asserts the ConfirmDialog is visible with the expected message text.
 * 5. Sets up a waitForRequest promise BEFORE clicking "Delete".
 * 6. Clicks "Delete" and awaits the request — asserts it fired.
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("delete model fires POST to /models/delete after confirming in the dialog", async ({ page }) => {
  // Override: model is already downloaded so "Model ready" + X button appear.
  await mockBackend(page, { modelsDownloaded: true });

  // Stub the cancel-download endpoint (called defensively during delete).
  await page.route("**/models/cancel-download", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });

  // Stub the delete endpoint — we just need it to succeed so the flow completes.
  await page.route("**/models/delete", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });

  await page.goto("/");

  // The wizard opens at step 0 ("Welcome to Budget Itemizer").
  await expect(page.getByText("Welcome to Budget Itemizer")).toBeVisible();

  // Advance to step 1 (AI Setup).
  await page.getByRole("button", { name: "Get Started" }).click();

  // Step 1 is "AI Setup". Because the model is already downloaded,
  // "Model ready" status indicator should be visible.
  await expect(page.getByText("AI Setup")).toBeVisible();
  await expect(page.getByText("Model ready")).toBeVisible();

  // Click the X button next to "Model ready" to request deletion.
  await page.getByRole("button", { name: "Delete model" }).click();

  // The ConfirmDialog should appear with the expected message text.
  // "Delete the model?" appears at the start of the message for the
  // fully-downloaded state.
  await expect(page.getByText(/Delete the model\?/)).toBeVisible();

  // Set up the request interceptor BEFORE triggering the click so we don't
  // create a race between the click resolving and the waitForRequest promise.
  const deleteRequestPromise = page.waitForRequest("**/models/delete");

  // Click "Delete" inside the ConfirmDialog. Scope to the dialog role so we
  // don't accidentally match the "Delete model" X icon button in the wizard
  // body, which also surfaces as a "Delete" button to the accessibility tree.
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();

  // Await the captured request — if the bug is present this will time out
  // because no request is ever sent.
  const deleteRequest = await deleteRequestPromise;
  expect(deleteRequest.method()).toBe("POST");
});

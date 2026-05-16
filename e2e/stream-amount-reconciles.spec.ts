/**
 * Real-world, watchable proof of the Bug-2 fix.
 *
 * Scenario: a receipt streams in. The line item "Widget" first appears
 * with the PROVISIONAL streamed amount $9.99 (the quick guess made before
 * the receipt's total/summary lines were claimed). Parsing then completes
 * and the backend's `done` event carries the RECONCILED receipt where
 * Widget is $12.00. The review screen must show $12.00 — the reconciled
 * figure that the import / reconcile gate actually uses — not the $9.99
 * guess.
 *
 * Watch it yourself:
 *   npx playwright test e2e/stream-amount-reconciles.spec.ts --headed
 *
 * (Headed/slow-mo lets you see the receipt drop and the review screen
 * render with the corrected amount. The deterministic unit-level proof of
 * the wrong->right swap is src/App.reducer.test.tsx ->
 * "adopts reconciled line-item amounts from the final receipt".)
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("review screen shows the reconciled line amount, not the streamed guess", async ({ page }) => {
  // mockBackend first — route precedence is last-registered-wins.
  await mockBackend(page);

  // Land directly in the main view: setup complete + model ready.
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
        config: { hasYnabApiKey: true, inboxPath: "/tmp/in", processedPath: "/tmp/out" },
        auth: { username: "u", password: "p" },
      }),
    });
  });
  await page.route("**/accounts**", (route) => {
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(["Checking"]) });
  });

  // The streamed-then-reconciled SSE the /parse-image/stream endpoint
  // produces. Widget streams at 9.99; the `done` receipt corrects it to
  // 12.00.
  const sse = [
    `event: status\ndata: ${JSON.stringify({ step: "label-extraction" })}\n\n`,
    `event: header\ndata: ${JSON.stringify({ merchant: "TestCo", transactionDate: "2026-05-10" })}\n\n`,
    `event: item\ndata: ${JSON.stringify({ index: 0, productName: "Widget", quantity: 1, amount: 9.99 })}\n\n`,
    `event: total\ndata: ${JSON.stringify({ totalAmount: 12.0 })}\n\n`,
    `event: categories\ndata: ${JSON.stringify({ categories: ["Shopping"] })}\n\n`,
    `event: done\ndata: ${JSON.stringify({
      receipt: {
        merchant: "TestCo",
        transactionDate: "2026-05-10",
        memo: "",
        totalAmount: 12.0,
        category: "Shopping",
        lineItems: [
          { productName: "Widget", quantity: 1, lineItemTotalAmount: 12.0, category: "Shopping" },
        ],
      },
    })}\n\n`,
  ].join("");

  await page.route("**/parse-image/stream", (route) => {
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache", Connection: "keep-alive" },
      body: sse,
    });
  });

  await page.goto("/");

  // Drop the receipt via the DropZone's file input (no real PDF needed —
  // the parse is mocked; the bytes are never read).
  await page.setInputFiles('input[type="file"]', {
    name: "receipt.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 mock receipt"),
  });

  // The line renders, and its amount is the reconciled 12.00 — NOT the
  // 9.99 that streamed first. Before the fix this read "9.99".
  const amount = page.getByRole("textbox", { name: "Amount for Widget" });
  await expect(amount).toBeVisible({ timeout: 5_000 });
  await expect(amount).toHaveValue("12.00");

  // And the streamed item genuinely went through the streaming path
  // (name came from the `item` event, amount from the `done` receipt).
  await expect(page.getByRole("textbox", { name: /Item name/ })).toHaveValue("Widget");
});

/**
 * Bug 6 regression: progressBufferRef pruned during optimistic Discard.
 *
 * Pre-fix scenario:
 *   - A file is parsing; file-parse-progress events stream in and get
 *     buffered into progressBufferRef.
 *   - User clicks Discard (optimistic — `removePendingLocal` strips the
 *     entry from `pendingFiles` immediately).
 *   - A `useEffect[pendingFiles]` then ran and pruned every buffer
 *     entry whose filename wasn't in `pendingFiles` — wiping ours.
 *   - DELETE returns 409 (concurrent re-upload race). `skipFile` calls
 *     `fetchPending` to restore. The entry comes back in pendingFiles.
 *   - User clicks the entry to review. `handleReviewPending` calls
 *     `getBufferedProgress(filename)` — returns []. Items panel is empty.
 *
 * Fix:
 *   - `removePendingLocal` no longer deletes the buffer.
 *   - The over-eager `useEffect` was removed.
 *   - `pruneStaleBuffers` is invoked only from `fetchPending` (the
 *     server-state-replacing path). At fetchPending time, after the 409
 *     restored the entry, the filename IS in the returned list and the
 *     buffer is preserved.
 *
 * What we assert: after Discard → 409 → entry restored → click into
 * review, items from the buffered progress events DO appear.
 */

import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("buffered parse-progress events survive Discard→409→restore round-trip", async ({ page }) => {
  const DETECTED_AT = "2026-05-11T12:00:00.000Z";
  let pendingFetchCount = 0;

  // SSE event stream: emit one file-parse-progress event for our entry,
  // then a file-queued (which ensures the entry registers in the FE
  // pendingFiles list immediately, before the polled /watcher/pending
  // fetch lands), then keep the connection open with periodic pings.
  await page.route("**/watcher/events**", async (route) => {
    const queued = JSON.stringify({
      filename: "racey.pdf",
      filePath: "/inbox/racey.pdf",
      detectedAt: DETECTED_AT,
      status: "parsing",
    });
    const headerEvent = JSON.stringify({
      filename: "racey.pdf",
      event: "header",
      data: { merchant: "TestCo", transactionDate: "2026-05-10" },
    });
    const itemEvent = JSON.stringify({
      filename: "racey.pdf",
      event: "item",
      data: { index: 0, productName: "BufferedItemA", quantity: 1, lineText: "BufferedItemA", amount: 9.99 },
    });
    const body =
      `event: file-queued\ndata: ${queued}\n\n` +
      `event: file-parse-progress\ndata: ${headerEvent}\n\n` +
      `event: file-parse-progress\ndata: ${itemEvent}\n\n` +
      `event: ping\ndata: {}\n\n`;
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body,
    });
  });

  // mockBackend first — Playwright uses last-registered-wins, so our
  // specific routes below override the defaults.
  await mockBackend(page);

  // /watcher/pending: returns a single parsing entry. Same response on
  // refetch so the post-409 fetchPending restores the entry.
  await page.route("**/watcher/pending", (route) => {
    pendingFetchCount++;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          filename: "racey.pdf",
          filePath: "/inbox/racey.pdf",
          detectedAt: DETECTED_AT,
          status: "parsing",
        },
      ]),
    });
  });

  // DELETE /watcher/pending/:filename returns 409 to simulate the
  // re-upload race the detectedAt token guards against.
  await page.route(/\/watcher\/pending\/[^?]+(\?.*)?$/, (route) => {
    if (route.request().method() === "DELETE") {
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "File was re-uploaded after you opened this view." }),
      });
      return;
    }
    route.continue();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Skip setup" }).click();

  // Wait for the SSE event to land — pending list should show the entry.
  const row = page.locator(".pending-item").filter({ hasText: "racey.pdf" });
  await expect(row).toBeVisible();

  // Click Discard — fires the optimistic removePendingLocal, then DELETE.
  // DELETE → 409 → skipFile calls fetchPending → entry restored.
  await row.getByRole("button", { name: /Cancel|Discard/ }).click();

  // After 409 + refetch, the entry comes back. The pending fetch counter
  // confirms a refetch happened (initial mount fetch + post-409 fetch).
  await expect(row).toBeVisible();
  expect(pendingFetchCount).toBeGreaterThanOrEqual(2);

  // Click the row to enter review. handleReviewPending replays buffered
  // events. If the bug were still present, getBufferedProgress would
  // return [] and the items panel would be empty. With the fix, the
  // buffered item event replays and BufferedItemA appears.
  await row.getByRole("button", { name: /View/ }).click();

  // The buffered item event replays into the review screen as an
  // editable item row whose name input is pre-filled with BufferedItemA.
  // getByText would miss this (it's an input value, not text content).
  await expect(
    page.getByRole("textbox", { name: /Item name/ })
  ).toHaveValue("BufferedItemA", { timeout: 5_000 });
});

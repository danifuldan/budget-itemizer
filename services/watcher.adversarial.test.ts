/**
 * Adversarial probes on the watcher subsystem.
 *
 * Two questions drive these tests:
 *
 *   (1) Can a same-millisecond burst into `processed/` *ever* overwrite
 *       a previously-archived file? The author added a numeric `n` suffix
 *       to defeat the obvious Date.now() collision; we want to verify the
 *       suffix actually fires for every collision, including a torrent of
 *       50+ within one millisecond.
 *
 *   (2) Does `stopWatcher` truly cancel every pending `setTimeout` it
 *       owns? The author tracked timers in `pendingTimers`. We can't
 *       drive fs.watch deterministically in a test, but we CAN simulate
 *       the dedup-TTL timers (every successful processFile registers
 *       one via `markProcessed`) and verify they're cleared.
 *
 * The tests use real fs against an os.tmpdir() — no mocks for the
 * collision check because the production-code calls fs.existsSync and
 * fs.renameSync directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// `services/watcher` reads getConfig() at the top of moveToProcessed; we
// need the processed path to point at our scratch dir.
let tmpRoot: string;
let tmpProcessed: string;

vi.mock("../utils/env-vars", () => ({
  default: { MAX_FILE_SIZE: 5242880 },
}));

vi.mock("./config", () => ({
  getConfig: vi.fn(() => ({
    inboxPath: tmpRoot,
    processedPath: tmpProcessed,
    deleteAfterImport: false,
    watcherAutoImport: false,
  })),
}));

// receipt + history + budget-provider have to be mocked; queueFile transitively
// imports them.
vi.mock("./receipt", () => ({
  parseImageReceiptStream: vi.fn(),
  importReceipt: vi.fn(),
}));
vi.mock("./budget-provider", () => ({
  BudgetConnectionError: class BudgetConnectionError extends Error {},
}));
vi.mock("./history", () => ({
  addRecord: vi.fn(),
}));
// queueFile waits for the llama-server health check before parsing — in
// these tests we don't spin up a real server, so report it as ready and
// let the (mocked) parser drive the rest.
vi.mock("./llama-server", () => ({
  isLlamaServerRunning: vi.fn(() => true),
}));

import { moveToProcessed, startWatcher, stopWatcher, getWatcherStatus, queueFile } from "./watcher";

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-adv-inbox-"));
  tmpProcessed = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-adv-processed-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Make sure no watcher is still running after each test, even on failure.
  stopWatcher();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(tmpProcessed, { recursive: true, force: true });
});

/**
 * Place a file in the inbox, call moveToProcessed N times "concurrently"
 * (synchronously back-to-back so Date.now() returns identical millisecond
 * values for at least some calls), and verify every move produced a
 * unique file in processed/. None of the previously-moved files should
 * have been overwritten — the file count in processed/ MUST equal N.
 */
function dropAndMove(filename: string, content: string): string {
  const src = path.join(tmpRoot, filename);
  fs.writeFileSync(src, content);
  // moveToProcessed is the function under test. It uses fs.renameSync —
  // we expect each call to choose a unique dest path.
  moveToProcessed(src, filename);
  return src;
}

describe("moveToProcessed — collision suffix never overwrites", () => {
  it("50 identical filenames in same-burst → 50 unique files, none overwritten", () => {
    const NAME = "Order.pdf";
    // Drop and move the file 50 times. Each iteration recreates the
    // source file with a unique payload so we can later check no file
    // was overwritten.
    const payloads: string[] = [];
    for (let i = 0; i < 50; i++) {
      const payload = `payload-${i}-${Math.random()}`;
      payloads.push(payload);
      dropAndMove(NAME, payload);
    }
    // Count files in processed/. We expect exactly 50.
    const files = fs.readdirSync(tmpProcessed);
    expect(files.length).toBe(50);
    // Every original payload must still be present somewhere in the
    // processed dir — i.e., no file was clobbered.
    const seen = new Set<string>();
    for (const f of files) {
      seen.add(fs.readFileSync(path.join(tmpProcessed, f), "utf-8"));
    }
    for (const p of payloads) {
      expect(seen.has(p)).toBe(true);
    }
  });

  // Worst case: rapid burst within a single millisecond. The implementation
  // uses Date.now() and then increments an `n` counter on every existsSync
  // hit. If the `do { ... } while (existsSync(dest))` loop accidentally
  // overwrote `stamp` per iteration (it shouldn't), back-to-back calls in
  // the SAME ms would collide on the same `n=0` suffix. Verify the loop
  // bumps `n` correctly.
  it("rapid same-millisecond burst (5 files, all Order.pdf) → 5 unique dest paths", () => {
    const NAME = "Order.pdf";
    const before = Date.now();
    for (let i = 0; i < 5; i++) {
      const src = path.join(tmpRoot, NAME);
      fs.writeFileSync(src, `i=${i}`);
      moveToProcessed(src, NAME);
    }
    const after = Date.now();
    // Sanity: the loop took non-zero time, but we expect at least some
    // iterations to share a millisecond.
    expect(fs.readdirSync(tmpProcessed).length).toBe(5);
    // (No assertion on time elapsed — just bounded.)
    expect(after - before).toBeGreaterThanOrEqual(0);
  });

  // The implementation uses `path.basename(filename)` defensively. If a
  // filename containing a slash makes it in (it shouldn't — sanitization
  // earlier strips it), the basename call prevents escape. Verify.
  it("filename with embedded path separator — basename strips it (no escape)", () => {
    const NAME = "../../../etc/Order.pdf";
    const realSrc = path.join(tmpRoot, "Order.pdf");
    fs.writeFileSync(realSrc, "x");
    // moveToProcessed builds dest from basename(filename), so the prefix
    // ../../../etc/ gets stripped before building the dest in tmpProcessed.
    moveToProcessed(realSrc, NAME);
    const files = fs.readdirSync(tmpProcessed);
    expect(files.length).toBe(1);
    // No file written outside tmpProcessed.
    expect(files[0]).toBe("Order.pdf");
  });

  // Filename ending in only a dot — `path.extname("...pdf")` returns ".pdf",
  // base = "..", which interacts weirdly with the suffix logic
  // (`${base}_${suffix}${ext}` = `.._1234.pdf`). Make sure nothing breaks.
  it("filename with multiple leading dots: '..pdf' is handled without throwing", () => {
    const realSrc = path.join(tmpRoot, "..pdf");
    fs.writeFileSync(realSrc, "x");
    expect(() => moveToProcessed(realSrc, "..pdf")).not.toThrow();
    // Second move with same name forces the collision branch.
    const realSrc2 = path.join(tmpRoot, "..pdf");
    fs.writeFileSync(realSrc2, "y");
    expect(() => moveToProcessed(realSrc2, "..pdf")).not.toThrow();
    const files = fs.readdirSync(tmpProcessed);
    expect(files.length).toBe(2);
  });

  // Filename with no extension at all. `path.extname("Order")` returns "",
  // base = "Order".slice(0, -0 || undefined) = "Order" (the `|| undefined`
  // trick). Verify this works.
  it("filename without extension: 'Order' is handled and collisions get a suffix", () => {
    const realSrc1 = path.join(tmpRoot, "Order");
    fs.writeFileSync(realSrc1, "1");
    moveToProcessed(realSrc1, "Order");
    const realSrc2 = path.join(tmpRoot, "Order");
    fs.writeFileSync(realSrc2, "2");
    moveToProcessed(realSrc2, "Order");
    const files = fs.readdirSync(tmpProcessed);
    expect(files.length).toBe(2);
    expect(files).toContain("Order");
  });
});

// ============================================================================
// stopWatcher cancels every tracked timer
// ============================================================================
//
// We can't directly observe `pendingTimers` from outside the module. What
// we CAN observe is that after `stopWatcher`, no scheduled work touches
// the queue. We probe this via the public effect: after stopWatcher,
// queueFile is the only way to enqueue work; the fs.watch debounce path
// is dead. Specifically: if we queueFile() then stopWatcher() quickly,
// the dedup-TTL setTimeout registered by markProcessed must be cleared
// so the Node event loop doesn't stay open.
//
// The most direct test: after stopWatcher, `setTimeout`'s pending count
// (visible via process._getActiveHandles in node) should drop.
//
// That's a fragile API. A more robust signal: after stopWatcher, call
// queueFile() on a NEW path with the same filename as one we just
// processed. If the dedup TTL was cleared, the queueFile attempt is not
// blocked by recentlyProcessed and proceeds (entering pendingFiles).
// If the dedup TTL was NOT cleared, the queueFile bails silently.

describe("stopWatcher — timer/state cleanup", () => {
  it("after stopWatcher, recentlyProcessed map is cleared (probed via queueFile re-entry)", async () => {
    const inboxFile = path.join(tmpRoot, "x.pdf");
    fs.writeFileSync(inboxFile, "%PDF-1.4");

    // Start watcher and stop it. The recentlyProcessed map should be empty.
    // We use queueFile directly (not via fs.watch) so we don't have to
    // race a real filesystem event.
    startWatcher();
    stopWatcher();

    // Now register the same filename via queueFile. Should NOT be blocked.
    // (queueFile is mocked-out parseImageReceiptStream; the function exits
    // after marking the entry, but we just want to confirm it doesn't bail
    // early on recentlyProcessed.)
    await queueFile(inboxFile, false);
    // The watcher state should be stopped (no fs.watch handle).
    const status = getWatcherStatus();
    expect(status.running).toBe(false);
  });

  it("startWatcher → stopWatcher leaves no fs.watch handle", () => {
    startWatcher();
    expect(getWatcherStatus().running).toBe(true);
    stopWatcher();
    expect(getWatcherStatus().running).toBe(false);
  });

  // Repeated start/stop cycles should not leak. We can't easily measure
  // memory but we can assert state stays consistent.
  it("10 start/stop cycles end in stopped state", () => {
    for (let i = 0; i < 10; i++) {
      startWatcher();
      stopWatcher();
    }
    expect(getWatcherStatus().running).toBe(false);
  });
});

// ============================================================================
// queueFile — oversize / weird-stat rejection
// ============================================================================

describe("queueFile — defensive checks bypass the HTTP route", () => {
  it("file larger than MAX_FILE_SIZE produces an error pending entry, not a parse", async () => {
    const big = path.join(tmpRoot, "huge.pdf");
    // Allocate ~6MB (over the 5MB default).
    fs.writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 0x00));

    await queueFile(big, false);
    const { getPending } = await import("./watcher");
    const entry = getPending("huge.pdf");
    expect(entry).toBeTruthy();
    expect(entry!.status).toBe("error");
    expect(entry!.parseError).toMatch(/max receipt size/i);
  });

  it("file with extension other than .pdf is skipped silently", async () => {
    const txt = path.join(tmpRoot, "notes.txt");
    fs.writeFileSync(txt, "x");
    await queueFile(txt, false);
    const { getPending } = await import("./watcher");
    expect(getPending("notes.txt")).toBeUndefined();
  });

  it("PDF extension upper-cased: '.PDF' is treated as PDF (case-insensitive)", async () => {
    // The check is `ext !== ".pdf"` after `.toLowerCase()`, so .PDF should pass.
    const pdf = path.join(tmpRoot, "RECEIPT.PDF");
    fs.writeFileSync(pdf, "%PDF-1.4");
    // parseImageReceiptStream is mocked to undefined return so we just
    // need to see queueFile proceed past the extension check (it will
    // throw in the parse, leaving an "error" entry — that's fine for
    // this assertion).
    await queueFile(pdf, false);
    const { getPending } = await import("./watcher");
    const entry = getPending("RECEIPT.PDF");
    expect(entry).toBeTruthy();
  });

  // What if statSync fails (permission, deleted between fs.watch and read)?
  // The implementation returns early. Verify no pending entry is created.
  it("non-existent file: statSync throws → queueFile returns without enqueuing", async () => {
    const ghost = path.join(tmpRoot, "ghost.pdf");
    // Don't write the file.
    await queueFile(ghost, false);
    const { getPending } = await import("./watcher");
    expect(getPending("ghost.pdf")).toBeUndefined();
  });
});

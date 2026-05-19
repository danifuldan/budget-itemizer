/**
 * Step 2 of cancellation pass: queueFile registers an AbortController per
 * filename, signal is passed to parseImageReceiptStream, and abortParse(name)
 * cancels an in-flight parse. The catch distinguishes AbortError from a real
 * parse failure — a cancelled parse must NOT flip the entry to "error".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpInbox: string;
let tmpProcessed: string;

vi.mock("../utils/env-vars", () => ({ default: { MAX_FILE_SIZE: 5242880 } }));
vi.mock("./config", () => ({
  getConfig: vi.fn(() => ({
    inboxPath: tmpInbox,
    processedPath: tmpProcessed,
    deleteAfterImport: false,
    watcherAutoImport: false,
  })),
}));
vi.mock("./budget-provider", () => ({ BudgetConnectionError: class extends Error {} }));
vi.mock("./history", () => ({ addRecord: vi.fn() }));
vi.mock("./llama-server", () => ({
  isLlamaServerRunning: vi.fn(() => true), // skip the warmup wait
  getLlamaServerStartError: vi.fn(() => null),
  isLlamaServerStarting: vi.fn(() => false),
}));
// parseImageReceiptStream hangs until its signal aborts. With step 1 the
// signal flows from queueFile (once step 2 wires it) → here.
vi.mock("./receipt", () => ({
  parseImageReceiptStream: vi.fn(
    (_file: unknown, _events: unknown, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  ),
  importReceipt: vi.fn(),
}));

import { queueFile, abortParse, getPending } from "./watcher";
import { parseImageReceiptStream } from "./receipt";

beforeEach(() => {
  tmpInbox = fs.mkdtempSync(path.join(os.tmpdir(), "wc-inbox-"));
  tmpProcessed = fs.mkdtempSync(path.join(os.tmpdir(), "wc-processed-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(tmpInbox, { recursive: true, force: true });
  fs.rmSync(tmpProcessed, { recursive: true, force: true });
});

describe("queueFile cancellation (step 2)", () => {
  it("abortParse(name) cancels the in-flight parse; entry is NOT flipped to 'error'", async () => {
    const filename = "receipt.pdf";
    const filePath = path.join(tmpInbox, filename);
    fs.writeFileSync(filePath, "PDF");

    const inflight = queueFile(filePath, false);
    // Let queueFile register its controller + status="parsing" + reach the await
    await new Promise((r) => setTimeout(r, 20));
    expect(getPending(filename)?.status).toBe("parsing");

    const aborted = abortParse(filename);
    expect(aborted).toBe(true);

    await inflight; // queueFile must resolve cleanly (no throw out)

    const entry = getPending(filename);
    expect(entry?.status).not.toBe("error"); // cancelled is NOT a parse error
  });

  it("abortParse returns false when no parse is in flight for that name", () => {
    expect(abortParse("nope.pdf")).toBe(false);
  });

  // Premortem Bug 1: the catch's silent-bail must NOT trip on every
  // AbortError — only on user-initiated cancellation (our controller).
  // The fetch inside callLLM/callLLMStream still uses
  // AbortSignal.timeout(120_000) as a safety net; that timeout firing
  // also surfaces as AbortError but leaves controller.signal.aborted ===
  // false. It MUST be classified as a parse error, not silently bailed.
  it("AbortError from the 120s safety timeout (not user-abort) → entry MUST be 'error'", async () => {
    // Unique filename — pendingFiles persists across tests in this suite
    // and the prior abort-not-error test leaves "receipt.pdf" at
    // status="parsing", so reusing it would short-circuit queueFile's
    // dedup and skip our mock.
    const filename = "timeout-receipt.pdf";
    fs.writeFileSync(path.join(tmpInbox, filename), "PDF");
    // Override the default hanging mock for this one call: simulate the
    // fetch timeout signal firing AbortError without the user controller.
    vi.mocked(parseImageReceiptStream).mockImplementationOnce(async () => {
      throw new DOMException("LLM safety timeout", "AbortError");
    });
    await queueFile(path.join(tmpInbox, filename), false);
    expect(getPending(filename)?.status).toBe("error");
  });
});

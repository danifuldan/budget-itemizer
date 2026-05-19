/**
 * Step 1 of cancellation pass: parseImageReceiptStream must accept an
 * AbortSignal and propagate it into the LLM step (parseReceiptFromTextStream),
 * so a Discard-while-parsing aborts the in-flight LLM call instead of
 * letting it run to completion and pin the llama slot.
 *
 * The leaf transport (transport.ts callLLMStream → fetch) is threaded as
 * part of GREEN too; this test mocks parseReceiptFromTextStream and only
 * asserts the layer above propagates the signal correctly.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("./budget", () => ({
  getAllEnvelopes: vi.fn(async () => [] as string[]),
  createTransaction: vi.fn(),
  findMatchingTransaction: vi.fn(),
  updateTransactionWithSplits: vi.fn(),
}));
vi.mock("./budget-provider", () => ({
  ReconciliationError: class extends Error {},
}));
vi.mock("./pipeline/pdf-text", () => ({
  extractPdfText: vi.fn(async () => "fake extracted text"),
}));
vi.mock("./pipeline/build-receipt", () => ({
  // Hangs until aborted — proves the signal is threaded through from
  // parseImageReceiptStream. Without GREEN, parseImageReceiptStream
  // ignores signal → 6th arg is undefined here → promise never rejects
  // → test times out (RED).
  parseReceiptFromTextStream: vi.fn(
    (_text: string, _cats: unknown, _events: unknown, _sourceUrl: unknown, _fullText: unknown, signal?: AbortSignal) =>
      new Promise((_resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  ),
}));
vi.mock("./swift-sidecar", () => ({
  isSidecarAvailable: vi.fn(() => false),
  getCapabilities: vi.fn(async () => ({ visionAvailable: false })),
  runVision: vi.fn(),
}));
vi.mock("./text/vision-reconstruct", () => ({ buildTextFromVisionResult: vi.fn(() => "") }));
vi.mock("./config", () => ({ getConfig: vi.fn(() => ({})) }));
vi.mock("../utils/scrub-string", () => ({
  scrubLlmString: (s: string) => s,
  SCRUB_LIMITS: {},
}));

import { parseImageReceiptStream } from "./receipt";

describe("parseImageReceiptStream — AbortSignal propagation (step 1)", () => {
  it("rejects promptly when the signal is aborted (in-flight LLM call cancels)", async () => {
    const ac = new AbortController();
    const pdf = new File([Buffer.from("fake-pdf")], "receipt.pdf", { type: "application/pdf" });
    const events = {
      onStatus: vi.fn(),
      onHeader: vi.fn(),
      onItem: vi.fn(),
      onTotal: vi.fn(),
      onCategories: vi.fn(),
    };

    const p = parseImageReceiptStream(pdf, events, ac.signal);
    setTimeout(() => ac.abort(), 10);

    await expect(p).rejects.toThrow(/abort/i);
  }, 2000);
});

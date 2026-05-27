/**
 * Lock-down: AbortError must propagate up through parseReceiptFromTextStream.
 *
 * The bug: AbortSignal IS threaded through every layer down to the LLM
 * fetch (services/llm/transport.ts), but build-receipt.ts had TWO catches
 * that swallowed the resulting AbortError as if it were any other LLM
 * failure:
 *   1. `assignCategories` catch — returned `[null, null, ...]` so the
 *      parse "completed" with empty categories on every line item AND
 *      fired `events.onDone` as if it had succeeded. A Discard hit
 *      mid-categorize silently produced a fake-completed receipt.
 *   2. `parseReceiptFromTextStream` label-extraction catch — surfaced
 *      the abort as `events.onError("label-extraction")`, so the FE
 *      saw a parse failure when the user was just cancelling.
 *
 * Fix: detect `signal?.aborted` or `err.name === "AbortError"` in both
 * catches and re-throw. These tests assert the disagreement — pre-fix
 * they fail (parse "completes" or surfaces as a label-extraction error);
 * post-fix the abort propagates.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { callLLMStream, callLLM } = vi.hoisted(() => ({
  callLLMStream: vi.fn(),
  callLLM: vi.fn(),
}));
vi.mock("../llm/transport", () => ({
  callLLMStream: (...a: unknown[]) => callLLMStream(...a),
  callLLM: (...a: unknown[]) => callLLM(...a),
  getLlmTextModel: () => "test-model",
}));

import { parseReceiptFromTextStream } from "./build-receipt";

const events = () => ({
  onStatus: vi.fn(),
  onHeader: vi.fn(),
  onItem: vi.fn(),
  onTotal: vi.fn(),
  onCategories: vi.fn(),
  onDone: vi.fn(),
  onError: vi.fn(),
});

beforeEach(() => {
  callLLMStream.mockReset();
  callLLM.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("parseReceiptFromTextStream re-throws AbortError instead of swallowing it", () => {
  it("Discard during LABEL EXTRACT propagates AbortError (does NOT surface as a label-extraction failure)", async () => {
    // callLLMStream is a generator. Make it throw AbortError on iteration —
    // simulates fetch aborting mid-stream.
    callLLMStream.mockReturnValue(
      (async function* () {
        throw new DOMException("aborted", "AbortError");
        // eslint-disable-next-line no-unreachable
        yield "";
      })(),
    );
    const e = events();

    await expect(
      parseReceiptFromTextStream("any text", [], e, undefined, "any text"),
    ).rejects.toThrow(/abort/i);

    // The disagreement: pre-fix, events.onError("label-extraction") would
    // have fired — making a cancel look like a parse failure on the FE.
    expect(e.onError).not.toHaveBeenCalled();
    expect(e.onDone).not.toHaveBeenCalled();
  });

  it("Discard during CATEGORIZE propagates AbortError (does NOT silently complete with empty categories)", async () => {
    // Label extraction succeeds — yield one complete JSON delta the
    // IncrementalLabelParser can consume in one shot. One line item so
    // assignCategories isn't short-circuited by the `items.length === 0`
    // early-return.
    const labelJson = JSON.stringify({
      merchant: "Test",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [{ productName: "Milk", quantity: 1, lineText: "Milk 3.99" }],
    });
    callLLMStream.mockReturnValue(
      (async function* () {
        yield labelJson;
      })(),
    );

    // Categorize call throws AbortError — same shape as a real
    // signal-aborted fetch tearing down mid-call.
    callLLM.mockRejectedValue(new DOMException("aborted", "AbortError"));

    const text = "Milk 3.99\nTotal 3.99";
    const e = events();

    await expect(
      parseReceiptFromTextStream(text, ["Groceries"], e, undefined, text),
    ).rejects.toThrow(/abort/i);

    // The load-bearing disagreement: pre-fix, events.onDone was called
    // with a receipt whose line items all had null categories — the
    // parse "succeeded" from the FE's perspective even though the user
    // had hit Discard.
    expect(e.onDone).not.toHaveBeenCalled();
    expect(e.onCategories).not.toHaveBeenCalled();
  });
});

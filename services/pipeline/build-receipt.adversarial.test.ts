/**
 * Adversarial probe: can a prompt-injected LLM make buildReceiptFromLabels
 * output a fraudulent amount?
 *
 * The architecture says: the LLM identifies WHICH LABEL marks the total —
 * a *string* like "TOTAL" or "Grand Total". The DETERMINISTIC code then
 * scans the OCR text for that label and reads the dollar amount adjacent
 * to it. So the LLM can only:
 *
 *   - Move the "total" marker to a different label that exists in the text
 *   - Pick a wrong label that doesn't exist (→ totalAmount = 0)
 *   - Hallucinate a line item that doesn't appear in the OCR text
 *
 * What the LLM CANNOT do is inject a numeric value directly. The number
 * always comes from `findAmountByLabel(text, label, ...)` — and that
 * function reads from the OCR text, not from any LLM output.
 *
 * The hostile question: is there ANY way for LLM-supplied data to flow
 * into a numeric field on the final receipt? We test by constructing
 * a maximally-malicious LabelResult with fake labels and inflated
 * quantities, and asserting that the final amounts on the receipt are
 * still derived from the OCR text only.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config", () => ({
  getConfig: vi.fn(() => ({})),
}));

import { buildReceiptFromLabels } from "./build-receipt";
import type { LabelResult } from "../llm/prompts";

// Minimal realistic OCR text — a Walmart-style receipt.
const OCR_TEXT = `
WALMART STORE
123 MAIN ST
MILK 3.99
BREAD 2.49
SUBTOTAL 6.48
TAX 0.52
TOTAL 7.00
`;

describe("buildReceiptFromLabels — LLM cannot manipulate amounts directly", () => {
  it("HONEST LLM output: totals/items match OCR text", () => {
    const labels: LabelResult = {
      merchant: "Walmart",
      dateLabel: "",
      totalLabel: "TOTAL",
      summaryLabels: [{ label: "TAX", type: "tax" }],
      lineItems: [
        { productName: "Milk", quantity: 1, lineText: "MILK" },
        { productName: "Bread", quantity: 1, lineText: "BREAD" },
      ],
    };
    const r = buildReceiptFromLabels(labels, OCR_TEXT);
    expect(r.totalAmount).toBe(7.0);
    expect(r.lineItems?.length).toBe(2);
    expect(r.lineItems?.[0].lineItemTotalAmount).toBe(3.99);
    expect(r.lineItems?.[1].lineItemTotalAmount).toBe(2.49);
    expect(r.tax).toBe(0.52);
  });

  // ATTACK 1: LLM tries to inflate the total by emitting a totalLabel
  // that happens to point at a higher value in the text. Since the text
  // is the source of truth, the LLM can only move the pointer — and the
  // ONLY high-value number in our fixture is the actual total. So the
  // resulting receipt total can never exceed the highest dollar amount
  // present in the OCR text.
  it("ATTACK: LLM points totalLabel at SUBTOTAL — totalAmount becomes SUBTOTAL value (not arbitrary)", () => {
    const labels: LabelResult = {
      merchant: "Walmart",
      dateLabel: "",
      totalLabel: "SUBTOTAL",
      summaryLabels: [],
      lineItems: [
        { productName: "Milk", quantity: 1, lineText: "MILK" },
      ],
    };
    const r = buildReceiptFromLabels(labels, OCR_TEXT);
    // Total is whatever follows SUBTOTAL in the OCR text — i.e., 6.48.
    // Critically: it's NOT a value the LLM can pick out of thin air.
    expect(r.totalAmount).toBe(6.48);
  });

  // ATTACK 2: LLM tries to insert a fabricated $999.99 amount that's
  // NOT in the OCR text. Because findAmountByLabel scans the text, a
  // label that doesn't appear yields no result → totalAmount = 0.
  it("ATTACK: LLM hallucinates a label that's NOT in OCR text — totalAmount = 0", () => {
    const labels: LabelResult = {
      merchant: "Walmart",
      dateLabel: "",
      totalLabel: "FRAUDULENT GRAND TOTAL $999.99",
      summaryLabels: [],
      lineItems: [],
    };
    const r = buildReceiptFromLabels(labels, OCR_TEXT);
    // The label doesn't appear in the text, so no amount is extracted.
    expect(r.totalAmount).toBe(0);
  });

  // ATTACK 3: LLM tries to inflate a line item by reporting an inflated
  // quantity. The quantity multiplies the unit price — so a malicious
  // qty=99 on a $3.99 item would yield $395.01.
  //
  // Defense: the existing code has a subtotal-reconciliation step that
  // catches items exceeding the subtotal and re-extracts. Does this
  // defense fire here?
  //
  // We construct a fixture where the LLM says qty=99 on a $3.99 item,
  // and the subtotal in the text is $6.48. The item would be $395.01
  // which exceeds the subtotal — the code should drop or fix it.
  it("ATTACK: LLM reports qty=99 on a $3.99 item — reconciliation caps or drops it", () => {
    const labels: LabelResult = {
      merchant: "Walmart",
      dateLabel: "",
      totalLabel: "TOTAL",
      summaryLabels: [{ label: "TAX", type: "tax" }, { label: "SUBTOTAL", type: "subtotal" }],
      lineItems: [
        { productName: "Milk", quantity: 99, lineText: "MILK" },
      ],
    };
    const r = buildReceiptFromLabels(labels, OCR_TEXT);
    // The naive computation: 3.99 × 99 = $395.01. Subtotal in text = $6.48.
    // The item should be capped/dropped because it exceeds subtotal.
    // What we assert: the final line-item total is NOT $395.01.
    const lineTotal = r.lineItems?.[0]?.lineItemTotalAmount ?? 0;
    expect(lineTotal).toBeLessThanOrEqual(6.48);
  });

  // ATTACK 4: LLM tries to make the merchant name include a NUL byte
  // hoping it'll truncate downstream. Note: buildReceiptFromLabels
  // passes merchant through untouched — the scrub happens later in
  // importReceipt's scrubReceipt call. Pin: buildReceiptFromLabels
  // does NOT pre-scrub the merchant.
  it("LLM emits merchant with NUL: buildReceiptFromLabels does not pre-scrub (relies on scrubReceipt later)", () => {
    const labels: LabelResult = {
      merchant: "Walmart\x00Inc",
      dateLabel: "",
      totalLabel: "TOTAL",
      summaryLabels: [],
      lineItems: [],
    };
    const r = buildReceiptFromLabels(labels, OCR_TEXT);
    // The raw NUL is still there. The scrub happens at the API boundary,
    // not here. If you ever move the scrub to this function, this test
    // fails — at that point, delete this test and add the assertion
    // that the NUL is gone.
    expect(r.merchant).toContain("\x00");
  });
});

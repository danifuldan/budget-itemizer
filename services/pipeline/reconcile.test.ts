import { describe, it, expect, beforeEach, vi } from "vitest";
import { reconcileExtraction } from "./reconcile";
import type { LabelResult } from "../llm/prompts";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("reconcileExtraction", () => {
  it("warns when item exceeds total", () => {
    const warnSpy = vi.spyOn(console, "warn");
    const receipt = {
      merchant: "Store",
      transactionDate: "2024-01-01",
      memo: "",
      totalAmount: 10,
      category: "",
      lineItems: [
        { productName: "Widget", quantity: 1, lineItemTotalAmount: 50, category: "" },
      ],
      tax: 0,
      shipping: 0,
      discount: 0,
      refund: 0,
    };
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [{ productName: "Widget", quantity: 1, lineText: "Widget" }],
    };
    reconcileExtraction(receipt, labels, "Widget $5.00\nTotal $10.00", []);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("exceeds total"));
  });

  it("does not zero shipping when it legitimately equals tax", () => {
    const receipt = {
      merchant: "Store",
      transactionDate: "2024-01-01",
      memo: "",
      totalAmount: 20,
      category: "",
      lineItems: [],
      tax: 5.99,
      shipping: 5.99,
      discount: 0,
      refund: 0,
    };
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [],
    };
    reconcileExtraction(receipt, labels, "Total $20.00", []);
    expect(receipt.shipping).toBe(5.99);
  });

  it("adjusts qty via arithmetic inference using FM subtotal label", () => {
    // 2 items: Widget at $7 (qty 1), Gadget at $10 (qty 1). Subtotal = $27.
    // Gap = $27 - $17 = $10. Widget: 10/7 ≠ integer. Gadget: 10/10 = 1 → qty becomes 2.
    const receipt = {
      merchant: "Store",
      transactionDate: "2024-01-01",
      memo: "",
      totalAmount: 27,
      category: "",
      lineItems: [
        { productName: "Widget", quantity: 1, lineItemTotalAmount: 7, category: "" },
        { productName: "Gadget", quantity: 1, lineItemTotalAmount: 10, category: "" },
      ],
      tax: 0,
      shipping: 0,
      discount: 0,
      refund: 0,
    };
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [{ label: "Subtotal", type: "subtotal" }],
      lineItems: [
        { productName: "Widget", quantity: 1, lineText: "Widget" },
        { productName: "Gadget", quantity: 1, lineText: "Gadget" },
      ],
    };
    reconcileExtraction(receipt, labels, "Widget $7.00\nGadget $10.00\nSubtotal $27.00\nTotal $27.00", []);
    expect(receipt.lineItems![1].quantity).toBe(2);
    expect(receipt.lineItems![1].lineItemTotalAmount).toBe(20);
  });

  it("adjusts qty via text-scanned subtotal when FM has no subtotal label", () => {
    // FM didn't produce a subtotal label.
    // Text contains "Item(s) Subtotal: $27.00" which the fallback should find.
    // Cable $7 (qty 1), Charger $10 (qty 1). Gap = $27 - $17 = $10.
    // Cable: 10/7 ≠ integer. Charger: 10/10 = 1 → qty becomes 2.
    const receipt = {
      merchant: "Amazon",
      transactionDate: "2024-01-01",
      memo: "",
      totalAmount: 29,
      category: "",
      lineItems: [
        { productName: "Cable", quantity: 1, lineItemTotalAmount: 7, category: "" },
        { productName: "Charger", quantity: 1, lineItemTotalAmount: 10, category: "" },
      ],
      tax: 2,
      shipping: 0,
      discount: 0,
      refund: 0,
    };
    const labels: LabelResult = {
      merchant: "Amazon",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [], // no subtotal label from FM
      lineItems: [
        { productName: "Cable", quantity: 1, lineText: "Cable" },
        { productName: "Charger", quantity: 1, lineText: "Charger" },
      ],
    };
    const text = "Cable $7.00\nCharger $10.00\nItem(s) Subtotal: $27.00\nTax $2.00\nTotal $29.00";
    reconcileExtraction(receipt, labels, text, []);
    expect(receipt.lineItems![1].quantity).toBe(2);
    expect(receipt.lineItems![1].lineItemTotalAmount).toBe(20);
  });

  // #91-3: register-tape OCR slipped the TAX cell ($0.27 read as
  // $0.20). Items reconcile to the printed SUBTOTAL and TOTAL is clear,
  // so tax is derivable from those two anchors — no need to trust the
  // OCR'd tax digit. The whole $0.07 miss is exactly the tax error.
  it("derives tax from subtotal+total anchors when the OCR'd tax is wrong", () => {
    const warnSpy = vi.spyOn(console, "warn");
    const receipt = {
      merchant: "Walmart",
      transactionDate: "2026-02-03",
      memo: "",
      totalAmount: 24.96,
      category: "",
      lineItems: [
        { productName: "BAGUETTE", quantity: 1, lineItemTotalAmount: 1.97, category: "" },
        { productName: "ROSEMARY", quantity: 1, lineItemTotalAmount: 2.96, category: "" },
        { productName: "PROGRSO SOU", quantity: 2, lineItemTotalAmount: 5.36, category: "" },
        { productName: "PROGRSO SOU", quantity: 1, lineItemTotalAmount: 2.68, category: "" },
        { productName: "WLSW BLK LM", quantity: 1, lineItemTotalAmount: 4.17, category: "" },
        { productName: "WLSW SHR BR", quantity: 1, lineItemTotalAmount: 4.17, category: "" },
        { productName: "GLASSES", quantity: 1, lineItemTotalAmount: 3.38, category: "" },
      ],
      tax: 0.2, // OCR misread of 0.27
      shipping: 0,
      discount: 0,
      refund: 0,
    };
    const labels: LabelResult = {
      merchant: "Walmart",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [],
    };
    reconcileExtraction(receipt, labels, "Subtotal $24.69\nTax $0.20\nTotal $24.96", []);
    expect(receipt.tax).toBeCloseTo(0.27, 2);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("differs from extracted total"),
    );
  });

  // The disagreement / safety: a LARGE residual is a missing fee/line,
  // NOT a tax slip. Deriving tax here would mask a $5 delivery fee as
  // "tax" (the #91-2 Walmart case). It must NOT fire when the implied
  // tax rate is implausible — the failure must stay a failure.
  it("does NOT absorb a missing fee into tax (large residual is not a tax slip)", () => {
    const receipt = {
      merchant: "Walmart",
      transactionDate: "2026-02-03",
      memo: "",
      totalAmount: 39.93, // 33.74 items + $5 fee + $1.19 tax (fee+tax missed)
      category: "",
      lineItems: [
        { productName: "Item A", quantity: 1, lineItemTotalAmount: 33.74, category: "" },
      ],
      tax: 0,
      shipping: 0,
      discount: 0,
      refund: 0,
    };
    const labels: LabelResult = {
      merchant: "Walmart",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [],
    };
    reconcileExtraction(receipt, labels, "Subtotal $33.74\nTotal $39.93", []);
    // $6.19 / $33.74 ≈ 18% — implausible as tax; must not be fabricated.
    expect(receipt.tax).toBe(0);
  });

  // #91: Amazon "Grand Total" is the GROSS charge; a "Refund Total"
  // shown alongside it is a SEPARATE later credit, not a reduction of
  // that total. Import the gross (it matches the bank charge — we're in
  // the business of matching transactions). The refund must NOT be
  // deducted and must not survive as a -refund split.
  it("treats a gross total + separate refund as gross (refund zeroed, reconciles)", () => {
    const warnSpy = vi.spyOn(console, "warn");
    const receipt = {
      merchant: "Amazon",
      transactionDate: "2025-12-09",
      memo: "",
      totalAmount: 91.52, // Grand Total = items 84.35 + tax 7.17
      category: "",
      lineItems: [
        { productName: "Book A", quantity: 1, lineItemTotalAmount: 24.02, category: "" },
        { productName: "Book B", quantity: 1, lineItemTotalAmount: 14.75, category: "" },
        { productName: "Encasement", quantity: 2, lineItemTotalAmount: 45.58, category: "" },
      ],
      tax: 7.17,
      shipping: 0,
      discount: 0,
      refund: 16.0, // "Refund Total $16.00" — a separate later credit
    };
    const labels: LabelResult = {
      merchant: "Amazon",
      dateLabel: "",
      totalLabel: "Grand Total",
      summaryLabels: [],
      lineItems: [],
    };
    reconcileExtraction(receipt, labels, "Grand Total $91.52\nRefund Total $16.00", []);
    expect(receipt.refund).toBe(0);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("differs from extracted total"),
    );
  });

  // The other side of the disagreement: when the stated total IS
  // already net of the refund (reconciles WITH it deducted), the refund
  // is real and must be preserved — gross-detection must not fire.
  it("keeps a refund that the stated total is already net of", () => {
    const receipt = {
      merchant: "Shop",
      transactionDate: "2024-01-01",
      memo: "",
      totalAmount: 40, // already net: items 50 - refund 10
      category: "",
      lineItems: [
        { productName: "Thing", quantity: 1, lineItemTotalAmount: 50, category: "" },
      ],
      tax: 0,
      shipping: 0,
      discount: 0,
      refund: 10,
    };
    const labels: LabelResult = {
      merchant: "Shop",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [],
    };
    reconcileExtraction(receipt, labels, "Total $40.00", []);
    expect(receipt.refund).toBe(10);
  });
});

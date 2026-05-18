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

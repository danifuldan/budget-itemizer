import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildReceiptFromLabels } from "./build-receipt";
import type { LabelResult } from "../llm/prompts";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("buildReceiptFromLabels", () => {
  it("builds basic receipt with total + tax + one line item", () => {
    const labels: LabelResult = {
      merchant: "Test Store",
      dateLabel: "March 15, 2024",
      totalLabel: "Total",
      summaryLabels: [{ label: "Tax", type: "tax" }],
      lineItems: [
        { productName: "Milk", quantity: 1, lineText: "Milk 2%" },
      ],
    };
    const text = "March 15, 2024\nMilk 2% $3.99\nTax $0.35\nTotal $4.34";
    const receipt = buildReceiptFromLabels(labels, text);

    expect(receipt.merchant).toBe("Test Store");
    expect(receipt.totalAmount).toBe(4.34);
    expect(receipt.tax).toBe(0.35);
    expect(receipt.lineItems).toHaveLength(1);
    expect(receipt.lineItems![0].lineItemTotalAmount).toBe(3.99);
  });

  it("stores discount as positive (Math.abs)", () => {
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [{ label: "Savings", type: "discount" }],
      lineItems: [],
    };
    const text = "Savings -$5.00\nTotal $20.00";
    const receipt = buildReceiptFromLabels(labels, text);
    expect(receipt.discount).toBe(5);
  });

  it("separates shipping and fee", () => {
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [
        { label: "Shipping", type: "shipping" },
        { label: "Handling Fee", type: "fee" },
      ],
      lineItems: [],
    };
    const text = "Shipping $5.99\nHandling Fee $2.00\nTotal $27.99";
    const receipt = buildReceiptFromLabels(labels, text);
    expect(receipt.shipping).toBe(5.99);
    expect(receipt.fees).toBe(2);
  });

  it("returns empty lineItems array when none provided", () => {
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [],
    };
    const text = "Total $10.00";
    const receipt = buildReceiptFromLabels(labels, text);
    expect(receipt.lineItems).toEqual([]);
  });

  it("prevents double-counting with claimed ranges", () => {
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [{ label: "Tax", type: "tax" }],
      lineItems: [
        { productName: "Widget", quantity: 1, lineText: "Widget" },
      ],
    };
    // Tax and Widget are on different lines with distinct amounts
    const text = "Widget $10.00\nTax $0.85\nTotal $10.85";
    const receipt = buildReceiptFromLabels(labels, text);
    expect(receipt.totalAmount).toBe(10.85);
    expect(receipt.tax).toBe(0.85);
    expect(receipt.lineItems![0].lineItemTotalAmount).toBe(10);
  });

  it("multiplies per-unit price by quantity for line total", () => {
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [
        { productName: "Apple", quantity: 3, lineText: "Apple" },
      ],
    };
    const text = "Apple $1.50\nTotal $4.50";
    const receipt = buildReceiptFromLabels(labels, text);
    expect(receipt.lineItems![0].lineItemTotalAmount).toBe(4.5);
  });

  it("extracts date using LLM-identified dateLabel", () => {
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "Order date: January 15, 2024",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [],
    };
    const text = "Order date: January 15, 2024\nTotal $10.00";
    const receipt = buildReceiptFromLabels(labels, text);
    expect(receipt.transactionDate).toBe("2024-01-15");
  });

  it("returns totalAmount 0 when total label not found", () => {
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Grand Total",
      summaryLabels: [],
      lineItems: [],
    };
    const text = "Subtotal $10.00";
    const receipt = buildReceiptFromLabels(labels, text);
    expect(receipt.totalAmount).toBe(0);
  });

  it("sanitizes labels that contain dollar amounts", () => {
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total $16.25",
      summaryLabels: [{ label: "Tax $1.27", type: "tax" }],
      lineItems: [
        { productName: "Widget", quantity: 1, lineText: "Widget $9.99" },
      ],
    };
    const text = "Widget $9.99\nTax $1.27\nTotal $16.25";
    const receipt = buildReceiptFromLabels(labels, text);
    // Even though LLM included amounts in labels, sanitization should produce correct extraction
    expect(receipt.totalAmount).toBe(16.25);
    expect(receipt.tax).toBe(1.27);
    expect(receipt.lineItems![0].lineItemTotalAmount).toBe(9.99);
  });

  it("detects free shipping and returns 0", () => {
    const labels: LabelResult = {
      merchant: "Target",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [
        { label: "Subtotal", type: "subtotal" },
        { label: "Shipping", type: "shipping" },
        { label: "Tax", type: "tax" },
      ],
      lineItems: [
        { productName: "Aveeno Lotion", quantity: 1, lineText: "Aveeno Positively Radiant" },
      ],
    };
    const text = "Aveeno Positively Radiant $9.99\nSubtotal $9.99\nShipping Free\nTax $1.27\nTotal $11.26";
    const receipt = buildReceiptFromLabels(labels, text);
    expect(receipt.shipping).toBe(0);
    expect(receipt.tax).toBe(1.27);
    expect(receipt.totalAmount).toBe(11.26);
    expect(receipt.lineItems![0].lineItemTotalAmount).toBe(9.99);
  });

  it("zeros shipping when charge is followed by free shipping credit", () => {
    const labels: LabelResult = {
      merchant: "Amazon",
      dateLabel: "November 29, 2025",
      totalLabel: "Grand Total",
      summaryLabels: [
        { label: "Subtotal", type: "subtotal" },
        { label: "Shipping & Handling", type: "shipping" },
        { label: "Free Shipping", type: "shipping" },
        { label: "Your Coupon Savings", type: "discount" },
        { label: "Estimated tax", type: "tax" },
      ],
      lineItems: [
        { productName: "Foldable Trash Can", quantity: 1, lineText: "Foldable Trash Can" },
        { productName: "Don Francisco's Espresso", quantity: 1, lineText: "Don Francisco's Clasico Espresso" },
      ],
    };
    const text = `Order placed November 29, 2025
Foldable Trash Can $13.29
Don Francisco's Clasico Espresso $21.80
Item(s) Subtotal: $35.09
Shipping & Handling: $2.99
Free Shipping: -$2.99
Your Coupon Savings: -$5.00
Total before tax: $30.09
Estimated tax to be collected: $1.89
Grand Total: $31.98`;
    const receipt = buildReceiptFromLabels(labels, text);
    expect(receipt.shipping).toBe(0);
    expect(receipt.discount).toBe(5);
    expect(receipt.tax).toBe(1.89);
    expect(receipt.totalAmount).toBe(31.98);
  });

  // REGRESSION (STRUCTURE-1 split): pins the claimedRanges cross-file contract.
  // After splitting buildReceiptFromLabels (pipeline/build-receipt.ts) from
  // reconcileExtraction (pipeline/reconcile.ts), the claimedRanges array
  // crosses a module boundary. If the array is copied instead of shared, or
  // if its element shape drifts, re-extraction for an over-priced item
  // could silently grab an already-claimed duplicate amount.
  it("re-extraction excludes already-claimed duplicate amounts (claimedRanges contract)", () => {
    // Premium appears twice in the text (at $99.00 and at $5.00).
    // The first deterministic pass claims Premium $99.00 — over the subtotal
    // ceiling — which forces reconcileExtraction to re-extract Premium.
    // Basic has already claimed its own $5.00. The re-extract MUST find
    // the OTHER $5.00 (on the second Premium line), not the one already
    // claimed by Basic; if claimedRanges were copied or its shape drifted,
    // the re-extract could silently steal Basic's amount.
    const labels: LabelResult = {
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [{ label: "Subtotal", type: "subtotal" }],
      lineItems: [
        { productName: "Premium", quantity: 1, lineText: "Premium" },
        { productName: "Basic", quantity: 1, lineText: "Basic" },
      ],
    };
    const text = "Premium $99.00\nBasic $5.00\nPremium $5.00\nSubtotal $10.00\nTotal $10.00";
    const receipt = buildReceiptFromLabels(labels, text);
    // Both items should resolve to $5.00. Premium is re-extracted to the
    // unclaimed $5.00 on the third line — not the already-claimed one on
    // the Basic line.
    expect(receipt.lineItems).toHaveLength(2);
    expect(receipt.lineItems![0].lineItemTotalAmount).toBe(5);
    expect(receipt.lineItems![1].lineItemTotalAmount).toBe(5);
    expect(receipt.totalAmount).toBe(10);
  });

  it("Target receipt: correct amounts with two items", () => {
    const labels: LabelResult = {
      merchant: "Target",
      dateLabel: "Dec 14, 2025",
      totalLabel: "Total",
      summaryLabels: [
        { label: "Subtotal", type: "subtotal" },
        { label: "Shipping", type: "shipping" },
        { label: "Estimated Tax", type: "tax" },
      ],
      lineItems: [
        { productName: "Aveeno Positively Radiant Lotion", quantity: 1, lineText: "Aveeno Positively Radiant" },
        { productName: "Face Wash", quantity: 1, lineText: "Face Wash Cleanser" },
      ],
    };
    const text = `Order placed Dec 14, 2025
Aveeno Positively Radiant $9.99
Face Wash Cleanser $4.99
Subtotal $14.98
Shipping Free
Estimated Tax $1.27
Total $16.25`;
    const receipt = buildReceiptFromLabels(labels, text);
    expect(receipt.totalAmount).toBe(16.25);
    expect(receipt.tax).toBe(1.27);
    expect(receipt.shipping).toBe(0);
    expect(receipt.lineItems![0].lineItemTotalAmount).toBe(9.99);
    expect(receipt.lineItems![1].lineItemTotalAmount).toBe(4.99);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSplits, ReceiptImportError } from "./receipt";
import type { Receipt } from "./shared-types";

vi.mock("./config", () => ({
  getConfig: vi.fn(() => ({ discountMode: "distribute" })),
}));

import { getConfig } from "./config";
const mockedGetConfig = vi.mocked(getConfig);

describe("buildSplits", () => {
  beforeEach(() => {
    mockedGetConfig.mockReturnValue({ discountMode: "distribute" } as any);
  });

  it("returns splits for a normal receipt with line items", () => {
    const receipt: Receipt = {
      merchant: "Walmart",
      transactionDate: "2024-01-01",
      memo: "Groceries",
      totalAmount: 15.48,
      category: "Groceries",
      lineItems: [
        { productName: "Bread", lineItemTotalAmount: 3.99, quantity: 1, category: "Groceries" },
        { productName: "Milk", lineItemTotalAmount: 4.49, quantity: 1, category: "Groceries" },
        { productName: "Soap", lineItemTotalAmount: 5.99, quantity: 1, category: "Personal Care" },
      ],
    };
    const splits = buildSplits(receipt);
    expect(splits).toHaveLength(3);
    expect(splits![0]).toEqual({ category: "Groceries", amount: 3.99, memo: "Bread" });
    expect(splits![1]).toEqual({ category: "Groceries", amount: 4.49, memo: "Milk" });
    expect(splits![2]).toEqual({ category: "Personal Care", amount: 5.99, memo: "Soap" });
  });

  it("returns undefined for empty lineItems", () => {
    const receipt: Receipt = {
      merchant: "Store",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 10,
      category: "Other",
      lineItems: [],
    };
    expect(buildSplits(receipt)).toBeUndefined();
  });

  it("returns undefined when lineItems is undefined", () => {
    const receipt: Receipt = {
      merchant: "Store",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 10,
      category: "Other",
    };
    expect(buildSplits(receipt)).toBeUndefined();
  });

  it("handles single line item", () => {
    const receipt: Receipt = {
      merchant: "Store",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 5.99,
      category: "Other",
      lineItems: [
        { productName: "Widget", lineItemTotalAmount: 5.99, quantity: 1, category: "Gadgets" },
      ],
    };
    const splits = buildSplits(receipt);
    expect(splits).toHaveLength(1);
    expect(splits![0]).toEqual({ category: "Gadgets", amount: 5.99, memo: "Widget" });
  });

  it("maps fields correctly (category, amount, memo)", () => {
    const receipt: Receipt = {
      merchant: "Store",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 20,
      category: "Other",
      lineItems: [
        { productName: "USB Cable", lineItemTotalAmount: 12.99, quantity: 2, category: "Electronics" },
      ],
    };
    const splits = buildSplits(receipt);
    expect(splits![0].category).toBe("Electronics");
    expect(splits![0].amount).toBe(12.99);
    expect(splits![0].memo).toBe("USB Cable");
  });

  it("distributes discount proportionally across items", () => {
    // Amazon scenario: items $20 + $15.09, coupon $5, tax $1.89, total $31.98
    const receipt: Receipt = {
      merchant: "Amazon",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 31.98,
      category: "Other",
      discount: 5.0,
      lineItems: [
        { productName: "Item A", lineItemTotalAmount: 20.0, quantity: 1, category: "Cat A" },
        { productName: "Item B", lineItemTotalAmount: 15.09, quantity: 1, category: "Cat B" },
      ],
    };
    const splits = buildSplits(receipt);
    expect(splits).toHaveLength(2);

    // Each item's share: A = 20/35.09 * 5 ≈ 2.85, B = 15.09/35.09 * 5 ≈ 2.15
    // Adjusted: A ≈ 17.15, B ≈ 12.94
    const sum = splits!.reduce((s, sp) => s + sp.amount, 0);
    expect(Math.round(sum * 100) / 100).toBe(30.09); // subtotal - discount
    expect(splits![0].amount).toBeLessThan(20.0);
    expect(splits![1].amount).toBeLessThan(15.09);
  });

  it("handles rounding so splits sum exactly to subtotal - discount", () => {
    // Three items with a discount that causes tricky rounding
    const receipt: Receipt = {
      merchant: "Store",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 10.0,
      category: "Other",
      discount: 1.0,
      lineItems: [
        { productName: "A", lineItemTotalAmount: 3.33, quantity: 1, category: "X" },
        { productName: "B", lineItemTotalAmount: 3.33, quantity: 1, category: "X" },
        { productName: "C", lineItemTotalAmount: 3.34, quantity: 1, category: "X" },
      ],
    };
    const splits = buildSplits(receipt);
    expect(splits).toHaveLength(3);

    const sum = Math.round(splits!.reduce((s, sp) => s + sp.amount, 0) * 100) / 100;
    const subtotal = 3.33 + 3.33 + 3.34;
    expect(sum).toBe(Math.round((subtotal - 1.0) * 100) / 100);
  });

  it("does not modify amounts when discount is zero", () => {
    const receipt: Receipt = {
      merchant: "Store",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 15.0,
      category: "Other",
      discount: 0,
      lineItems: [
        { productName: "A", lineItemTotalAmount: 7.0, quantity: 1, category: "X" },
        { productName: "B", lineItemTotalAmount: 8.0, quantity: 1, category: "Y" },
      ],
    };
    const splits = buildSplits(receipt);
    expect(splits![0].amount).toBe(7.0);
    expect(splits![1].amount).toBe(8.0);
  });

  it("does not modify amounts when discount is undefined", () => {
    const receipt: Receipt = {
      merchant: "Store",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 15.0,
      category: "Other",
      lineItems: [
        { productName: "A", lineItemTotalAmount: 7.0, quantity: 1, category: "X" },
        { productName: "B", lineItemTotalAmount: 8.0, quantity: 1, category: "Y" },
      ],
    };
    const splits = buildSplits(receipt);
    expect(splits![0].amount).toBe(7.0);
    expect(splits![1].amount).toBe(8.0);
  });

  it("keeps items at original prices when discountMode is 'credit'", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "credit" } as any);
    const receipt: Receipt = {
      merchant: "Amazon",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 31.98,
      category: "Other",
      discount: 5.0,
      lineItems: [
        { productName: "Item A", lineItemTotalAmount: 20.0, quantity: 1, category: "Cat A" },
        { productName: "Item B", lineItemTotalAmount: 15.09, quantity: 1, category: "Cat B" },
      ],
    };
    const splits = buildSplits(receipt);
    // 2 items + 1 discount split
    expect(splits).toHaveLength(3);
    expect(splits![0].amount).toBe(20.0);
    expect(splits![1].amount).toBe(15.09);
    expect(splits![2]).toEqual({ category: "", amount: -5.0, memo: "Discount" });
  });

  it("distributes discount when discountMode is 'distribute'", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "distribute" } as any);
    const receipt: Receipt = {
      merchant: "Amazon",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 31.98,
      category: "Other",
      discount: 5.0,
      lineItems: [
        { productName: "Item A", lineItemTotalAmount: 20.0, quantity: 1, category: "Cat A" },
        { productName: "Item B", lineItemTotalAmount: 15.09, quantity: 1, category: "Cat B" },
      ],
    };
    const splits = buildSplits(receipt);
    expect(splits).toHaveLength(2);
    // Items should have reduced amounts (no separate discount split in distribute mode)
    expect(splits![0].amount).toBeLessThan(20.0);
    expect(splits![1].amount).toBeLessThan(15.09);
    const sum = Math.round(splits!.reduce((s, sp) => s + sp.amount, 0) * 100) / 100;
    expect(sum).toBe(30.09); // subtotal - discount
  });

  it("includes explicit tax and shipping splits", () => {
    const receipt: Receipt = {
      merchant: "Store",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 20.0,
      category: "Other",
      tax: 1.50,
      shipping: 3.00,
      lineItems: [
        { productName: "A", lineItemTotalAmount: 15.50, quantity: 1, category: "X" },
      ],
    };
    const splits = buildSplits(receipt);
    expect(splits).toHaveLength(3); // 1 item + tax + shipping
    expect(splits![0]).toEqual({ category: "X", amount: 15.50, memo: "A" });
    expect(splits![1]).toEqual({ category: "", amount: 1.50, memo: "Tax/fees" });
    expect(splits![2]).toEqual({ category: "", amount: 3.00, memo: "Shipping" });
  });

  it("includes separate tax and discount splits in credit mode", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "credit" } as any);
    const receipt: Receipt = {
      merchant: "Amazon",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 16.89,
      category: "Other",
      discount: 5.0,
      tax: 1.89,
      lineItems: [
        { productName: "Widget", lineItemTotalAmount: 20.0, quantity: 1, category: "Gadgets" },
      ],
    };
    const splits = buildSplits(receipt);
    expect(splits).toHaveLength(3); // 1 item + tax + discount
    expect(splits![0].amount).toBe(20.0);
    expect(splits![1]).toEqual({ category: "", amount: 1.89, memo: "Tax/fees" });
    expect(splits![2]).toEqual({ category: "", amount: -5.0, memo: "Discount" });
  });

  it("includes tax split alongside distributed discount", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "distribute" } as any);
    const receipt: Receipt = {
      merchant: "Amazon",
      transactionDate: "2024-01-01",
      memo: "test",
      totalAmount: 31.98,
      category: "Other",
      discount: 5.0,
      tax: 1.89,
      lineItems: [
        { productName: "Item A", lineItemTotalAmount: 20.0, quantity: 1, category: "Cat A" },
        { productName: "Item B", lineItemTotalAmount: 15.09, quantity: 1, category: "Cat B" },
      ],
    };
    const splits = buildSplits(receipt);
    expect(splits).toHaveLength(3); // 2 reduced items + tax
    expect(splits![0].amount).toBeLessThan(20.0);
    expect(splits![1].amount).toBeLessThan(15.09);
    expect(splits![2]).toEqual({ category: "", amount: 1.89, memo: "Tax/fees" });
    // Items + tax should sum to total
    const sum = Math.round(splits!.reduce((s, sp) => s + sp.amount, 0) * 100) / 100;
    expect(sum).toBe(31.98);
  });
});

// Regression (round 8): the HTTP /import handler returned 500 with the
// generic message "Failed to import the receipt" for actionable failures
// like a non-existent account or category. Underlying causes (e.g.
// "Account not found") were thrown inside the budget provider and wrapped
// in ReceiptImportError, whose hardcoded message always won at app.ts's
// `err.message || "An unknown error..."`. Users had no clue why an
// import failed. Now ReceiptImportError surfaces the cause's message.
describe("ReceiptImportError surfaces the underlying cause", () => {
  it("includes an Error cause's message", () => {
    const err = new ReceiptImportError({ cause: new Error("Account not found") });
    expect(err.message).toBe("Failed to import the receipt: Account not found");
  });

  it("includes a string cause", () => {
    const err = new ReceiptImportError({ cause: "Category not found" });
    expect(err.message).toBe("Failed to import the receipt: Category not found");
  });

  it("falls back to the generic message when there's no cause", () => {
    const err = new ReceiptImportError();
    expect(err.message).toBe("Failed to import the receipt");
  });

  it("preserves the cause on the error for code consumers", () => {
    const cause = new Error("Account not found");
    const err = new ReceiptImportError({ cause });
    expect(err.cause).toBe(cause);
  });
});

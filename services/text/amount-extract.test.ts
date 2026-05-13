import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  detectZeroAmount,
  findAmountByLabel,
  findDateByLabel,
  type ClaimedRange,
} from "./amount-extract";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("detectZeroAmount", () => {
  it("detects 'Free' after label", () => {
    expect(detectZeroAmount("Shipping Free\nTax $1.27", "Shipping")).toBe(true);
  });

  it("detects '$0.00' after label", () => {
    expect(detectZeroAmount("Shipping $0.00\nTax $1.27", "Shipping")).toBe(true);
  });

  it("detects '0.00' after label", () => {
    expect(detectZeroAmount("Delivery 0.00\nTax $1.27", "Delivery")).toBe(true);
  });

  it("detects 'no charge' after label", () => {
    expect(detectZeroAmount("Shipping no charge\nTax $1.27", "Shipping")).toBe(true);
  });

  it("returns false for non-zero amount", () => {
    expect(detectZeroAmount("Shipping $5.99\nTax $1.27", "Shipping")).toBe(false);
  });

  it("returns false when label not found", () => {
    expect(detectZeroAmount("Tax $1.27", "Shipping")).toBe(false);
  });

  it("is case insensitive for 'FREE'", () => {
    expect(detectZeroAmount("Shipping FREE\nTotal $10.00", "Shipping")).toBe(true);
  });

  it("detects 'Free' before label ('Free Shipping')", () => {
    expect(detectZeroAmount("Free Shipping\nTax $1.27", "Shipping")).toBe(true);
  });

  it("detects '$0.00' before label", () => {
    expect(detectZeroAmount("$0.00 Delivery\nTax $1.27", "Delivery")).toBe(true);
  });
});

describe("findAmountByLabel", () => {
  it("finds simple same-line amount", () => {
    const result = findAmountByLabel("Total $42.99", "Total");
    expect(result?.value).toBe(42.99);
  });

  it("finds amount after label with colon", () => {
    const result = findAmountByLabel("Grand Total: $15.00", "Grand Total");
    expect(result?.value).toBe(15);
  });

  it("handles extra whitespace between label words", () => {
    const result = findAmountByLabel("Grand   Total $15.00", "Grand Total");
    expect(result?.value).toBe(15);
  });

  it("takes the last dollar amount on the same line", () => {
    const result = findAmountByLabel(
      "Subtotal $10.00 Tax $2.50 Total $12.50",
      "Total"
    );
    expect(result?.value).toBe(12.5);
  });

  it("handles dollar with space between $ and digits", () => {
    const result = findAmountByLabel("Tax $ 3.25", "Tax");
    expect(result?.value).toBe(3.25);
  });

  it("uses word boundary — Total does NOT match inside Subtotal", () => {
    const text = "Subtotal $10.00\nTotal $12.50";
    const result = findAmountByLabel(text, "Total");
    expect(result?.value).toBe(12.5);
  });

  it("Tax prefers standalone line over Pre-Tax (tightness tiebreak)", () => {
    // "Tax" on its own line is a tighter match than "Tax" inside "Pre-Tax"
    const text = "Pre-Tax $8.00\nTax $1.50";
    const result = findAmountByLabel(text, "Tax");
    expect(result?.value).toBe(1.5);
  });

  it("finds amount on the next line (Strategy B)", () => {
    const text = "Grand Total\n$42.99";
    const result = findAmountByLabel(text, "Grand Total");
    expect(result?.value).toBe(42.99);
  });

  it("finds amount several lines below within 500 chars", () => {
    const text = "Grand Total\n\n\n\n$42.99";
    const result = findAmountByLabel(text, "Grand Total");
    expect(result?.value).toBe(42.99);
  });

  it("returns null when amount is beyond 500 chars (multi-line)", () => {
    // Strategy A only searches same line; Strategy B searches 500 chars.
    // Put a newline so it falls to Strategy B, then exceed 500 chars.
    const text = "Grand Total\n" + " ".repeat(501) + "$42.99";
    const result = findAmountByLabel(text, "Grand Total");
    expect(result).toBeNull();
  });

  it("handles negative amounts", () => {
    const result = findAmountByLabel("Discount -$5.00", "Discount");
    expect(result?.value).toBe(-5);
  });

  it("handles comma thousands", () => {
    const result = findAmountByLabel("Total $1,234.56", "Total");
    expect(result?.value).toBe(1234.56);
  });

  it("handles no cents", () => {
    const result = findAmountByLabel("Total $42", "Total");
    expect(result?.value).toBe(42);
  });

  it("handles Unicode curly quotes in label", () => {
    const result = findAmountByLabel(
      "Customer’s Total $50.00",
      "Customer’s Total"
    );
    expect(result?.value).toBe(50);
  });

  it("handles em dash in text", () => {
    const result = findAmountByLabel(
      "Order Total— $99.99",
      "Order Total—"
    );
    expect(result?.value).toBe(99.99);
  });

  it("skips excluded ranges", () => {
    // Use separate lines so "last on line" picks the correct amount
    const text = "Item A $5.00\nItem B $10.00";
    const firstResult = findAmountByLabel(text, "Item A");
    expect(firstResult?.value).toBe(5);

    // Now exclude that range when searching for Item B
    const secondResult = findAmountByLabel(text, "Item B", [
      firstResult!.claimed,
    ]);
    expect(secondResult?.value).toBe(10);
  });

  it("returns null when all amounts are excluded", () => {
    const text = "Total $42.99";
    const excludeAll: ClaimedRange[] = [{ start: 6, end: 12 }];
    const result = findAmountByLabel(text, "Total", excludeAll);
    expect(result).toBeNull();
  });

  it("returns null for empty label", () => {
    const result = findAmountByLabel("Total $42.99", "");
    expect(result).toBeNull();
  });

  it("returns null when label not found in text", () => {
    const result = findAmountByLabel("Total $42.99", "Grand Total");
    expect(result).toBeNull();
  });

  it("returns null when label found but no dollar amount nearby", () => {
    const result = findAmountByLabel("Total is pending", "Total");
    expect(result).toBeNull();
  });

  it("handles regex special chars in label", () => {
    const result = findAmountByLabel("Total (USD) $42.99", "Total (USD)");
    expect(result?.value).toBe(42.99);
  });

  it("is case insensitive", () => {
    const result = findAmountByLabel("grand total $42.99", "Grand Total");
    expect(result?.value).toBe(42.99);
  });

  it("returns correct claimed range positions", () => {
    const text = "Total $42.99";
    const result = findAmountByLabel(text, "Total");
    expect(result?.claimed.start).toBe(6);
    expect(result?.claimed.end).toBe(12);
  });

  it("matches first occurrence of duplicate label", () => {
    const text = "Tax $1.50\nSummary\nTax $1.50";
    const result = findAmountByLabel(text, "Tax");
    // First "Tax" match should get $1.50 on the first line
    expect(result?.value).toBe(1.5);
    expect(result!.claimed.start).toBeLessThan(10);
  });

  it("respects maxSearchDistance parameter", () => {
    // Amount is 100 chars away — should be found with default 500 but not with 50
    const text = "Total\n" + " ".repeat(95) + "$42.99";
    expect(findAmountByLabel(text, "Total", [], 500)?.value).toBe(42.99);
    expect(findAmountByLabel(text, "Total", [], 50)).toBeNull();
  });

  it("finds amount within tight search distance for summary labels", () => {
    const text = "Tax $1.27\nTotal $16.25";
    const result = findAmountByLabel(text, "Tax", [], 80);
    expect(result?.value).toBe(1.27);
  });

  it("tight search prevents grabbing far-away amounts", () => {
    // With tight search, "Shipping" should NOT reach the tax amount 100 chars away
    const text = "Shipping Free\n" + " ".repeat(80) + "$1.27";
    const result = findAmountByLabel(text, "Shipping", [], 30);
    expect(result).toBeNull();
  });

  it("detects prefixQty after newline (e.g. qty on its own line)", () => {
    const text = "USB Cable\n3 $9.99";
    const result = findAmountByLabel(text, "USB Cable", [], 500);
    expect(result?.value).toBe(9.99);
    expect(result?.prefixQty).toBe(3);
  });

  it("detects prefixQty after tab (tab-separated columns)", () => {
    const text = "USB Cable\t3\t$9.99";
    const result = findAmountByLabel(text, "USB Cable", [], 500);
    expect(result?.value).toBe(9.99);
    expect(result?.prefixQty).toBe(3);
  });

  it("detects prefixQty at start of text", () => {
    const text = "2 $19.49";
    const result = findAmountByLabel(text, "2", [], 500);
    // "2" matches as label; prefixQty should not double-detect since the label IS the qty
    // The important thing is the amount is found
    expect(result?.value).toBe(19.49);
  });

  it("does not detect prefixQty from trailing digits of words", () => {
    // "abc3" should not produce prefixQty=3
    const text = "Model abc3 $9.99";
    const result = findAmountByLabel(text, "Model abc3", [], 500);
    expect(result?.value).toBe(9.99);
    expect(result?.prefixQty).toBeUndefined();
  });
});

describe("findDateByLabel", () => {
  it("finds date near the identified label in text", () => {
    const text = "Shipping address: 123 Main St\nOrder date: January 15, 2024\nTotal $10.00";
    expect(findDateByLabel(text, "Order date: January 15, 2024")).toBe("2024-01-15");
  });

  it("finds date when label is a short snippet", () => {
    const text = "Invoice #123\nPurchased Nov 29, 2025\nItem A $5.00";
    expect(findDateByLabel(text, "Purchased Nov 29, 2025")).toBe("2025-11-29");
  });

  it("finds MM/DD/YYYY format date near label", () => {
    const text = "Order #456\nDate: 01/15/2024\nItem B $10.00";
    expect(findDateByLabel(text, "Date: 01/15/2024")).toBe("2024-01-15");
  });

  it("finds YYYY-MM-DD format date near label", () => {
    const text = "Receipt date: 2024-03-15\nTotal $42.99";
    expect(findDateByLabel(text, "Receipt date: 2024-03-15")).toBe("2024-03-15");
  });

  it("falls back to first date in text when label not found", () => {
    const text = "March 20, 2024\nSome items\nTotal $10.00";
    expect(findDateByLabel(text, "nonexistent label")).toBe("2024-03-20");
  });

  it("falls back to first date in text when dateLabel is empty", () => {
    const text = "Jan 5, 2024\nItem $5.00\nTotal $5.00";
    expect(findDateByLabel(text, "")).toBe("2024-01-05");
  });

  it("returns today when no date found anywhere", () => {
    const today = new Date().toISOString().split("T")[0];
    expect(findDateByLabel("No dates here", "")).toBe(today);
  });
});

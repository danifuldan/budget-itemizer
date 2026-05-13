import { describe, it, expect, beforeEach, vi } from "vitest";
import { findLabelPosition } from "./label-match";
import { normalizeText } from "./normalize";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("findLabelPosition", () => {
  it("finds exact multi-word match", () => {
    const text = "Items: Widget A $5.00\nGrand Total $42.99";
    const normText = normalizeText(text);
    const result = findLabelPosition(normText, normalizeText("Grand Total"));
    expect(result).not.toBeNull();
    expect(normText.substring(result!.index, result!.index + result!.length)).toBe("Grand Total");
  });

  it("handles abbreviation/truncation (Ultrac → Ultraclear)", () => {
    const text = "Degree Men Ultraclear $8.99";
    const normText = normalizeText(text);
    const result = findLabelPosition(normText, normalizeText("Degree Men Ultrac"));
    expect(result).not.toBeNull();
  });

  it("handles ellipsis difference (unicode … vs ASCII ...)", () => {
    const text = "Degree Men Ultrac... $8.99";
    const result = findLabelPosition(normalizeText(text), normalizeText("Degree Men Ultrac…"));
    expect(result).not.toBeNull();
  });

  it("Total does NOT match inside Subtotal", () => {
    const text = "Subtotal $10.00";
    const normText = normalizeText(text);
    const result = findLabelPosition(normText, normalizeText("Total"));
    // "Total" as a single token should NOT match "Subtotal" — "total" is not a prefix of "subtotal"
    // and "subtotal" is not a prefix of "total"
    expect(result).toBeNull();
  });

  it("Tax prefers standalone line over Pre-Tax (tightness tiebreak)", () => {
    const text = "Pre-Tax $8.00\nTax $1.50";
    const normText = normalizeText(text);
    const result = findLabelPosition(normText, normalizeText("Tax"));
    expect(result).not.toBeNull();
    // Should prefer "Tax" on its own line (tighter match) over "Pre-Tax"
    expect(result!.index).toBeGreaterThanOrEqual(normText.indexOf("\n"));
  });

  it("tolerates extra words between label words", () => {
    const text = "Sales and Use Tax $3.50";
    const normText = normalizeText(text);
    const result = findLabelPosition(normText, normalizeText("Sales Tax"));
    expect(result).not.toBeNull();
  });

  it("returns null for empty label", () => {
    const result = findLabelPosition("Total $42.99", "");
    expect(result).toBeNull();
  });

  it("returns null when no tokens match above threshold", () => {
    const result = findLabelPosition("Total $42.99", "Completely Unrelated Words");
    expect(result).toBeNull();
  });

  it("is case insensitive", () => {
    const text = "grand total $42.99";
    const result = findLabelPosition(normalizeText(text), normalizeText("Grand Total"));
    expect(result).not.toBeNull();
  });
});

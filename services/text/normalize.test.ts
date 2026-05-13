import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  normalizeText,
  sanitizeLabel,
  normalizeDate,
} from "./normalize";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("normalizeText", () => {
  it("converts curly single quotes to ASCII", () => {
    expect(normalizeText("‘hello’")).toBe("'hello'");
  });

  it("converts curly double quotes to ASCII", () => {
    expect(normalizeText("“hello”")).toBe('"hello"');
  });

  it("converts prime symbol to apostrophe", () => {
    expect(normalizeText("it′s")).toBe("it's");
  });

  it("converts en/em dashes to hyphen", () => {
    expect(normalizeText("a–b—c")).toBe("a-b-c");
  });

  it("leaves plain ASCII unchanged", () => {
    expect(normalizeText("hello world 123")).toBe("hello world 123");
  });
});

describe("sanitizeLabel", () => {
  it("strips dollar amount from label", () => {
    expect(sanitizeLabel("Total $16.25")).toBe("Total");
  });

  it("strips negative dollar amount", () => {
    expect(sanitizeLabel("Discount -$5.00")).toBe("Discount");
  });

  it("strips dollar amount with comma", () => {
    expect(sanitizeLabel("Grand Total $1,234.56")).toBe("Grand Total");
  });

  it("strips dollar amount with space after $", () => {
    expect(sanitizeLabel("Tax $ 3.25")).toBe("Tax");
  });

  it("leaves labels without amounts unchanged", () => {
    expect(sanitizeLabel("Shipping Free")).toBe("Shipping Free");
  });

  it("leaves plain label unchanged", () => {
    expect(sanitizeLabel("Grand Total")).toBe("Grand Total");
  });

  it("handles empty string", () => {
    expect(sanitizeLabel("")).toBe("");
  });

  it("strips multiple amounts", () => {
    expect(sanitizeLabel("Was $20.00 Now $15.00 Item")).toBe("Was Now Item");
  });
});

describe("normalizeDate", () => {
  it("passes through YYYY-MM-DD format", () => {
    expect(normalizeDate("2024-01-15")).toBe("2024-01-15");
  });

  it("trims whitespace from YYYY-MM-DD", () => {
    expect(normalizeDate("  2024-01-15  ")).toBe("2024-01-15");
  });

  it("parses 'January 15, 2024'", () => {
    expect(normalizeDate("January 15, 2024")).toBe("2024-01-15");
  });

  it("parses '01/15/2024'", () => {
    expect(normalizeDate("01/15/2024")).toBe("2024-01-15");
  });

  it("parses short month 'Jan 15, 2024'", () => {
    expect(normalizeDate("Jan 15, 2024")).toBe("2024-01-15");
  });

  it("returns raw string for year < 2000", () => {
    expect(normalizeDate("1999-12-31")).toBe("1999-12-31");
  });

  it("rejects dates too old for a receipt (e.g. 'November 30' → 2001)", () => {
    const today = new Date().toISOString().split("T")[0];
    expect(normalizeDate("November 30")).toBe(today);
  });

  it("returns today's date for unparseable input", () => {
    const today = new Date().toISOString().split("T")[0];
    expect(normalizeDate("not a date")).toBe(today);
  });

  it("returns today's date for empty string", () => {
    const today = new Date().toISOString().split("T")[0];
    expect(normalizeDate("")).toBe(today);
  });

  it("parses 2-digit year '01/15/25' as 2025", () => {
    expect(normalizeDate("01/15/25")).toBe("2025-01-15");
  });

  it("parses 2-digit year '12/31/26' as 2026", () => {
    expect(normalizeDate("12/31/26")).toBe("2026-12-31");
  });
});

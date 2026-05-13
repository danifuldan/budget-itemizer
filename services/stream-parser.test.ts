import { describe, it, expect, beforeEach, vi } from "vitest";
import { IncrementalLabelParser, type StreamParserCallbacks } from "./stream-parser";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

// A realistic label JSON to simulate streaming token-by-token
const sampleLabels = {
  merchant: "Costco Wholesale",
  dateLabel: "Jan 15, 2025",
  totalLabel: "Total",
  summaryLabels: [
    { label: "Subtotal", type: "subtotal" },
    { label: "Tax", type: "tax" },
  ],
  lineItems: [
    { productName: "Organic Bananas", quantity: 1, lineText: "Organic Bananas" },
    { productName: "Kirkland Paper Towels", quantity: 2, lineText: "KS Paper Towels" },
    { productName: "Rotisserie Chicken", quantity: 1, lineText: "Rotisserie Chicken" },
  ],
};

const sampleJson = JSON.stringify(sampleLabels);

/** Feed a JSON string to the parser one character at a time */
function feedCharByChar(parser: IncrementalLabelParser, json: string) {
  for (const ch of json) {
    parser.feed(ch);
  }
}

/** Feed a JSON string in chunks of a given size */
function feedInChunks(parser: IncrementalLabelParser, json: string, chunkSize: number) {
  for (let i = 0; i < json.length; i += chunkSize) {
    parser.feed(json.slice(i, i + chunkSize));
  }
}

// ============================================================
// Header detection
// ============================================================
describe("IncrementalLabelParser - header", () => {
  it("emits header once merchant is present", () => {
    const headers: { merchant: string; dateLabel: string }[] = [];
    const parser = new IncrementalLabelParser({
      onHeader: (h) => headers.push(h),
    });

    feedCharByChar(parser, sampleJson);
    parser.finish();

    expect(headers).toHaveLength(1);
    expect(headers[0].merchant).toBe("Costco Wholesale");
    expect(headers[0].dateLabel).toBe("Jan 15, 2025");
  });

  it("emits header before items when fed char-by-char", () => {
    const events: string[] = [];
    const parser = new IncrementalLabelParser({
      onHeader: () => events.push("header"),
      onItem: () => events.push("item"),
      onComplete: () => events.push("complete"),
    });

    feedCharByChar(parser, sampleJson);
    parser.finish();

    expect(events[0]).toBe("header");
    expect(events.indexOf("header")).toBeLessThan(events.indexOf("item"));
  });

  it("does not emit header if merchant string not yet closed", () => {
    const headers: unknown[] = [];
    const parser = new IncrementalLabelParser({
      onHeader: (h) => headers.push(h),
    });

    // Feed partial JSON with merchant value still open
    parser.feed('{"merchant": "Test St');
    expect(headers).toHaveLength(0);
  });
});

// ============================================================
// Item detection
// ============================================================
describe("IncrementalLabelParser - items", () => {
  it("emits each item as its JSON object closes", () => {
    const items: { productName: string; quantity: number; lineText: string; index: number }[] = [];
    const parser = new IncrementalLabelParser({
      onItem: (item, index) => items.push({ ...item, index }),
    });

    feedCharByChar(parser, sampleJson);
    parser.finish();

    expect(items).toHaveLength(3);
    expect(items[0].productName).toBe("Organic Bananas");
    expect(items[0].index).toBe(0);
    expect(items[1].productName).toBe("Kirkland Paper Towels");
    expect(items[1].quantity).toBe(2);
    expect(items[1].index).toBe(1);
    expect(items[2].productName).toBe("Rotisserie Chicken");
    expect(items[2].index).toBe(2);
  });

  it("emits items incrementally (not all at once)", () => {
    const itemTimes: number[] = [];
    let charsFed = 0;
    const parser = new IncrementalLabelParser({
      onItem: () => itemTimes.push(charsFed),
    });

    for (const ch of sampleJson) {
      parser.feed(ch);
      charsFed++;
    }
    parser.finish();

    // Items should arrive at different points in the stream
    expect(itemTimes).toHaveLength(3);
    expect(itemTimes[0]).toBeLessThan(itemTimes[1]);
    expect(itemTimes[1]).toBeLessThan(itemTimes[2]);
  });

  it("works with chunk-based feeding", () => {
    const items: { productName: string }[] = [];
    const parser = new IncrementalLabelParser({
      onItem: (item) => items.push({ productName: item.productName }),
    });

    feedInChunks(parser, sampleJson, 20);
    parser.finish();

    expect(items).toHaveLength(3);
    expect(items.map((i) => i.productName)).toEqual([
      "Organic Bananas",
      "Kirkland Paper Towels",
      "Rotisserie Chicken",
    ]);
  });

  it("handles items with escaped quotes in strings", () => {
    const json = JSON.stringify({
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [
        { productName: 'Item with "quotes"', quantity: 1, lineText: "Item with quotes" },
      ],
    });

    const items: { productName: string }[] = [];
    const parser = new IncrementalLabelParser({
      onItem: (item) => items.push({ productName: item.productName }),
    });

    feedCharByChar(parser, json);
    parser.finish();

    expect(items).toHaveLength(1);
    expect(items[0].productName).toBe('Item with "quotes"');
  });
});

// ============================================================
// Complete event
// ============================================================
describe("IncrementalLabelParser - complete", () => {
  it("emits complete with full LabelResult on finish", () => {
    let result: unknown = null;
    const parser = new IncrementalLabelParser({
      onComplete: (labels) => { result = labels; },
    });

    feedCharByChar(parser, sampleJson);
    parser.finish();

    expect(result).toEqual(sampleLabels);
  });

  it("emits error on malformed JSON", () => {
    let error: Error | null = null;
    const parser = new IncrementalLabelParser({
      onError: (err) => { error = err; },
    });

    parser.feed('{"merchant": "Test", broken');
    parser.finish();

    expect(error).not.toBeNull();
    expect(error!.message).toContain("Failed to parse");
  });

  it("emits complete after all items", () => {
    const events: string[] = [];
    const parser = new IncrementalLabelParser({
      onItem: () => events.push("item"),
      onComplete: () => events.push("complete"),
    });

    feedCharByChar(parser, sampleJson);
    parser.finish();

    const lastItemIdx = events.lastIndexOf("item");
    const completeIdx = events.indexOf("complete");
    expect(completeIdx).toBeGreaterThan(lastItemIdx);
  });
});

// ============================================================
// Edge cases
// ============================================================
describe("IncrementalLabelParser - edge cases", () => {
  it("handles empty lineItems array", () => {
    const json = JSON.stringify({
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [],
    });

    const items: unknown[] = [];
    let result: unknown = null;
    const parser = new IncrementalLabelParser({
      onItem: (item) => items.push(item),
      onComplete: (labels) => { result = labels; },
    });

    feedCharByChar(parser, json);
    parser.finish();

    expect(items).toHaveLength(0);
    expect(result).not.toBeNull();
  });

  it("handles single large chunk (whole JSON at once)", () => {
    const items: { productName: string }[] = [];
    let headerEmitted = false;
    let completed = false;

    const parser = new IncrementalLabelParser({
      onHeader: () => { headerEmitted = true; },
      onItem: (item) => items.push({ productName: item.productName }),
      onComplete: () => { completed = true; },
    });

    parser.feed(sampleJson);
    parser.finish();

    expect(headerEmitted).toBe(true);
    expect(items).toHaveLength(3);
    expect(completed).toBe(true);
  });

  it("handles nested braces in string values without miscounting", () => {
    const json = JSON.stringify({
      merchant: "Store {with braces}",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [
        { productName: "Item {1}", quantity: 1, lineText: "Item {1}" },
      ],
    });

    const items: { productName: string }[] = [];
    const parser = new IncrementalLabelParser({
      onItem: (item) => items.push({ productName: item.productName }),
    });

    feedCharByChar(parser, json);
    parser.finish();

    expect(items).toHaveLength(1);
    expect(items[0].productName).toBe("Item {1}");
  });

  it("defaults quantity to 1 when not present", () => {
    const json = JSON.stringify({
      merchant: "Store",
      dateLabel: "",
      totalLabel: "Total",
      summaryLabels: [],
      lineItems: [
        { productName: "Item A", lineText: "Item A" },
      ],
    });

    const items: { quantity: number }[] = [];
    const parser = new IncrementalLabelParser({
      onItem: (item) => items.push({ quantity: item.quantity }),
    });

    feedCharByChar(parser, json);
    parser.finish();

    expect(items[0].quantity).toBe(1);
  });
});

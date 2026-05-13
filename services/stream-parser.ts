// ============================================================
// Incremental JSON parser for label extraction streaming
// ============================================================
//
// Accumulates SSE content deltas from callLLMStream() and emits
// structured events as fields become available.
//
// Strategy:
// - Track accumulated JSON string
// - Use regex to detect when header fields (merchant, date, memo) complete
// - For lineItems, track brace depth within the array to detect each {…} closing
// - On stream end, parse the full JSON for the complete LabelResult

import type { LabelResult } from "./llm/prompts";

export interface StreamParserCallbacks {
  onHeader?: (header: { merchant: string; dateLabel: string }) => void;
  onItem?: (item: { productName: string; quantity: number; lineText: string }, index: number) => void;
  onComplete?: (labels: LabelResult) => void;
  onError?: (error: Error) => void;
}

export class IncrementalLabelParser {
  private buffer = "";
  private headerEmitted = false;
  private itemCount = 0;
  private callbacks: StreamParserCallbacks;

  // For tracking lineItems array parsing
  private lineItemsArrayStart = -1; // index of '[' after "lineItems"
  private itemScanPos = 0; // how far we've scanned for items
  private braceDepth = 0; // depth inside lineItems array
  private currentItemStart = -1; // index of '{' for current item

  constructor(callbacks: StreamParserCallbacks) {
    this.callbacks = callbacks;
  }

  feed(delta: string): void {
    this.buffer += delta;

    // Try to emit header
    if (!this.headerEmitted) {
      this.tryEmitHeader();
    }

    // Try to emit line items incrementally
    this.tryEmitItems();
  }

  finish(): void {
    try {
      const labels: LabelResult = JSON.parse(this.buffer);
      this.callbacks.onComplete?.(labels);
    } catch (err) {
      console.error(`[stream-parser] Failed to parse LLM response. Buffer (${this.buffer.length} chars):\n${this.buffer.slice(0, 2000)}`);
      this.callbacks.onError?.(new Error(`Failed to parse complete label JSON: ${err}`));
    }
  }

  private tryEmitHeader(): void {
    const merchant = this.extractStringField("merchant");
    const dateLabel = this.extractStringField("dateLabel");

    if (merchant !== null && dateLabel !== null) {
      this.headerEmitted = true;
      this.callbacks.onHeader?.({ merchant, dateLabel });
    }
  }

  private tryEmitItems(): void {
    // Find the start of the lineItems array if we haven't yet
    if (this.lineItemsArrayStart === -1) {
      const lineItemsKeyMatch = /"lineItems"\s*:\s*\[/.exec(this.buffer);
      if (!lineItemsKeyMatch) return;
      this.lineItemsArrayStart = lineItemsKeyMatch.index + lineItemsKeyMatch[0].length;
      this.itemScanPos = this.lineItemsArrayStart;
      this.braceDepth = 0;
    }

    // Scan forward from where we left off
    let i = this.itemScanPos;
    for (; i < this.buffer.length; i++) {
      const ch = this.buffer[i];

      // Skip characters inside strings to avoid counting braces in string values
      if (ch === '"') {
        const end = this.skipString(i);
        if (end >= this.buffer.length) {
          // String not yet closed — rewind to this quote and wait for more data
          this.itemScanPos = i;
          return;
        }
        i = end;
        continue;
      }

      if (ch === '{') {
        if (this.braceDepth === 0) {
          this.currentItemStart = i;
        }
        this.braceDepth++;
      } else if (ch === '}') {
        this.braceDepth--;
        if (this.braceDepth === 0 && this.currentItemStart !== -1) {
          // Complete item object found
          const itemJson = this.buffer.substring(this.currentItemStart, i + 1);
          try {
            const item = JSON.parse(itemJson);
            this.callbacks.onItem?.(
              {
                productName: item.productName || "",
                quantity: item.quantity ?? 1,
                lineText: item.lineText || "",
              },
              this.itemCount,
            );
            this.itemCount++;
          } catch {
            // Partial/malformed item, skip
          }
          this.currentItemStart = -1;
        }
      } else if (ch === ']' && this.braceDepth === 0) {
        // End of lineItems array — stop scanning
        this.itemScanPos = i + 1;
        return;
      }
    }

    this.itemScanPos = i;
  }

  /**
   * Skip past a JSON string starting at position i (the opening quote).
   * Returns the index of the closing quote.
   */
  private skipString(i: number): number {
    // i is at the opening "
    let j = i + 1;
    while (j < this.buffer.length) {
      if (this.buffer[j] === '\\') {
        j += 2; // skip escaped char
        continue;
      }
      if (this.buffer[j] === '"') {
        return j; // closing quote
      }
      j++;
    }
    // String not yet closed — return end of buffer
    return this.buffer.length;
  }

  /**
   * Extract a completed string field value from the accumulated buffer.
   * Returns null if the field hasn't been fully written yet.
   */
  private extractStringField(fieldName: string): string | null {
    // Match "fieldName" : "value" — handle escaped quotes inside the value
    const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"`);
    const match = pattern.exec(this.buffer);
    if (!match) return null;

    const valueStart = match.index + match[0].length;

    // Find the closing unescaped quote
    let i = valueStart;
    while (i < this.buffer.length) {
      if (this.buffer[i] === '\\') {
        i += 2;
        continue;
      }
      if (this.buffer[i] === '"') {
        // Found closing quote
        const raw = this.buffer.substring(valueStart, i);
        // Unescape JSON string escapes
        try {
          return JSON.parse(`"${raw}"`);
        } catch {
          return raw;
        }
      }
      i++;
    }

    return null; // string value not yet complete
  }
}

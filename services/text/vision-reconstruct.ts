import type { VisionResult } from "../swift-sidecar";

const AMOUNT_PATTERN = /(?:\$\s*)?\d{1,}[,\d]*\.\d{2}\b/;

/**
 * Trim lines to the region between first and last dollar amount,
 * with padding (5 lines before, 3 after) for merchant/date header.
 * Returns the original array if no amounts are found.
 */
function trimToAmountRegion(lines: string[]): string[] {
  let firstAmt = -1;
  let lastAmt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (AMOUNT_PATTERN.test(lines[i])) {
      if (firstAmt === -1) firstAmt = i;
      lastAmt = i;
    }
  }
  if (firstAmt === -1) return lines;
  const start = Math.max(0, firstAmt - 5);
  const end = Math.min(lines.length, lastAmt + 3);
  return lines.slice(start, end);
}

/**
 * Build spatially-reconstructed text from VNRecognizeTextRequest results.
 *
 * Groups lines at similar Y-coordinates into visual rows and sorts
 * left-to-right within each row so labels stay next to their amounts
 * even in multi-column receipt layouts. Only keeps pages that contain
 * dollar amounts; trims navigation/footer content to stay within the
 * 4096 token limit.
 */
export function buildTextFromVisionResult(result: VisionResult): string | null {
  type LineWithBbox = { text: string; x: number; y: number };
  const allLines: LineWithBbox[] = [];

  for (const page of result.pages) {
    const hasAmounts =
      (page.detectedAmounts && page.detectedAmounts.length > 0) ||
      AMOUNT_PATTERN.test(page.text);
    if (!hasAmounts) continue;

    for (const line of page.lines) {
      if (!line.text.trim()) continue;
      allLines.push({ text: line.text, x: line.bbox.x, y: line.bbox.y });
    }
  }

  if (allLines.length === 0) {
    // Fallback: use raw text from all non-empty pages
    const fallback = result.pages
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join("\n\n");
    return fallback.length > 100 ? fallback : null;
  }

  // Sort by Y descending (top of page first — Vision uses bottom-left origin)
  allLines.sort((a, b) => b.y - a.y);

  // Group lines into visual rows (Y within tolerance)
  const Y_TOLERANCE = 0.008; // ~0.8% of page height
  const rows: LineWithBbox[][] = [];
  let currentRow: LineWithBbox[] = [allLines[0]];

  for (let i = 1; i < allLines.length; i++) {
    const prevY = currentRow[0].y;
    if (Math.abs(allLines[i].y - prevY) <= Y_TOLERANCE) {
      currentRow.push(allLines[i]);
    } else {
      rows.push(currentRow);
      currentRow = [allLines[i]];
    }
  }
  rows.push(currentRow);

  // Sort each row left-to-right, then merge continuation lines.
  // A single-element row with no dollar amount at the same X as an
  // element in the previous row is a wrapped label (e.g. "collected:"
  // continuing "Estimated tax to be"). Merge it into the matching
  // element so the final line reads "Estimated tax to be collected: $7.08".
  const X_TOLERANCE = 0.02;

  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
  }

  // Merge continuations into previous rows before joining
  for (let i = rows.length - 1; i >= 1; i--) {
    const row = rows[i];
    if (row.length !== 1 || AMOUNT_PATTERN.test(row[0].text)) continue;

    const prevRow = rows[i - 1];
    const match = prevRow.find(
      (el) => Math.abs(el.x - row[0].x) < X_TOLERANCE,
    );
    if (match) {
      match.text += " " + row[0].text;
      rows.splice(i, 1);
    }
  }

  const textLines = rows.map((row) =>
    row.map((l) => l.text).join("\t"),
  );

  const trimmed = trimToAmountRegion(textLines).join("\n");

  return trimmed.length > 50 ? trimmed : null;
}

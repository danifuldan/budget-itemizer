import { normalizeText, normalizeDate } from "./normalize";
import { findLabelPosition } from "./label-match";

export interface ClaimedRange {
  start: number;
  end: number;
}

export interface AmountResult {
  value: number;
  claimed: ClaimedRange;
  /** Bare integer found immediately before the dollar amount (e.g. "3 $9.99" → 3) */
  prefixQty?: number;
}

/**
 * Detect if a label's nearby text indicates a zero/free amount.
 * Checks ~30 chars after the label for "Free", "$0.00", "0.00", "no charge".
 */
export const detectZeroAmount = (text: string, label: string): boolean => {
  const normText = normalizeText(text);
  const normLabel = normalizeText(label);

  // Check if "free" / "$0.00" / "no charge" appears in the label itself
  const zeroPattern = /\bfree\b|\$\s*0\.00\b|\b0\.00\b|\bno\s+charge\b/;
  if (zeroPattern.test(normLabel.toLowerCase())) return true;

  const labelMatch = findLabelPosition(normText, normLabel);
  if (!labelMatch) return false;

  // Restrict to same line as the label to avoid cross-line false positives
  const matchEnd = labelMatch.index + labelMatch.length;
  const lineStart = normText.lastIndexOf("\n", labelMatch.index) + 1;
  const lineEndIdx = normText.indexOf("\n", matchEnd);
  const after = normText.substring(matchEnd, lineEndIdx === -1 ? matchEnd + 30 : lineEndIdx).toLowerCase();
  const before = normText.substring(lineStart, labelMatch.index).toLowerCase();
  return zeroPattern.test(after) || zeroPattern.test(before);
};

export const findAmountByLabel = (
  text: string,
  label: string,
  excludeRanges: ClaimedRange[] = [],
  maxSearchDistance: number = 500,
): AmountResult | null => {
  if (!label) return null;

  // Normalize both text and label so curly quotes etc. don't prevent matching
  const normText = normalizeText(text);
  const normLabel = normalizeText(label);

  // Fuzzy token-based label matching
  const labelMatch = findLabelPosition(normText, normLabel);

  if (!labelMatch) {
    console.log(`  Label not found: "${label}"`);
    return null;
  }

  const matchEnd = labelMatch.index + labelMatch.length;
  const sameLineEnd = matchEnd + normText.substring(matchEnd).split("\n")[0].length;
  const scanEnd = matchEnd + maxSearchDistance;

  // Match dollar amounts with or without $ sign. Some receipts (e.g. Costco)
  // use bare amounts like "13.99" without a dollar sign.
  // With $: cents optional ($42 or $42.00). Without $: cents required (avoids matching item codes).
  const dollarPattern = /-?(?:\$\s*[\d,]+(?:\.\d{2})?|[\d,]+\.\d{2})/g;

  /** Check if a dollar amount at [start, start+len) overlaps any excluded range */
  const isExcluded = (absPos: number, len: number): boolean => {
    for (const ex of excludeRanges) {
      if (absPos < ex.end && absPos + len > ex.start) return true;
    }
    return false;
  };

  // Detect a bare integer (1-99) immediately before a dollar amount.
  // Amazon shows "3 $9.99" meaning qty 3 at $9.99 each.
  // The digit must follow a boundary (start of string, newline, or tab) to avoid
  // matching trailing digits of product codes or other numbers.
  const parsePrefixQty = (fullText: string, matchAbsPos: number): number | undefined => {
    const before = fullText.substring(Math.max(0, matchAbsPos - 5), matchAbsPos);
    const m = before.match(/(?:^|\n|\t)(\d{1,2})\s+$/);
    return m ? parseInt(m[1], 10) : undefined;
  };

  // One pass over the region [labelMatch.index, matchEnd + maxSearchDistance);
  // bucket each unclaimed dollar amount by its spatial tier. Replaces three
  // overlapping scans (same-line / wider-after / embedded-in-label) with a
  // single classification + ordered pick. The three tiers are non-overlapping
  // and the priority order matches the previous behavior exactly:
  //   1. sameLine → pick LAST (so the right-most amount on the label's row wins
  //      when receipts show "Tax  $1.27  Total $128.27")
  //   2. afterLine → pick FIRST (next dollar amount on a following row)
  //   3. embedded → pick FIRST (amount lands between label tokens when spatial
  //      reconstruction merges columns, e.g. "Estimated tax to be $7.08 collected")
  const scanText = normText.substring(labelMatch.index, scanEnd);
  type Candidate = { absPos: number; len: number; raw: string };
  const sameLine: Candidate[] = [];
  const afterLine: Candidate[] = [];
  const embedded: Candidate[] = [];
  for (const m of scanText.matchAll(dollarPattern)) {
    const absPos = labelMatch.index + m.index!;
    const len = m[0].length;
    if (isExcluded(absPos, len)) continue;
    const c: Candidate = { absPos, len, raw: m[0] };
    if (absPos < matchEnd) embedded.push(c);
    else if (absPos < sameLineEnd) sameLine.push(c);
    else afterLine.push(c);
  }

  const pick = sameLine.length > 0 ? sameLine[sameLine.length - 1]
             : afterLine.length > 0 ? afterLine[0]
             : embedded.length > 0 ? embedded[0]
             : null;

  if (!pick) {
    console.log(`  "${label}" found but no dollar amount nearby`);
    return null;
  }

  const val = parseFloat(pick.raw.replace(/[$,\s]/g, ""));
  const prefixQty = parsePrefixQty(normText, pick.absPos);
  const tier = sameLine.length > 0 ? "same-line" : afterLine.length > 0 ? "after-line" : "embedded";
  console.log(`  "${label}" → ${pick.raw} (${val})${prefixQty ? ` [prefixQty=${prefixQty}]` : ""} [${tier}]`);
  return { value: val, claimed: { start: pick.absPos, end: pick.absPos + pick.len }, prefixQty };
};

/**
 * Find a date near an LLM-identified label snippet in the receipt text.
 * The LLM identifies WHERE the date is; this function extracts it precisely.
 * Falls back to scanning the full text if the label isn't found.
 */
export const findDateByLabel = (text: string, dateLabel: string): string => {
  const datePattern = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/gi;

  // Strategy 1: Extract date from the dateLabel or nearby text
  if (dateLabel) {
    // First check the label itself — it often contains the date directly
    datePattern.lastIndex = 0;
    const labelDate = datePattern.exec(dateLabel);
    if (labelDate) {
      return normalizeDate(labelDate[0]);
    }

    // If label doesn't contain a date, search near where the label appears in text
    const normText = normalizeText(text);
    const normLabel = normalizeText(dateLabel);
    const labelMatch = findLabelPosition(normText, normLabel);

    if (labelMatch) {
      // Search from the label position forward (not before, to avoid page timestamps)
      const start = labelMatch.index;
      const end = Math.min(normText.length, labelMatch.index + labelMatch.length + 100);
      const vicinity = normText.substring(start, end);

      datePattern.lastIndex = 0;
      const dateMatch = datePattern.exec(vicinity);
      if (dateMatch) {
        return normalizeDate(dateMatch[0]);
      }
    }
  }

  // Strategy 2: Fallback — find the first date in the full text
  datePattern.lastIndex = 0;
  const fallback = datePattern.exec(text);
  if (fallback) {
    return normalizeDate(fallback[0]);
  }

  return new Date().toISOString().split("T")[0];
};

export const normalizeText = (s: string): string =>
  s.replace(/[‘’′]/g, "'")   // curly single quotes → ASCII
   .replace(/[“”]/g, '"')          // curly double quotes → ASCII
   .replace(/[–—]/g, "-")          // en/em dash → hyphen
   .replace(/…/g, "...");               // ellipsis → three periods

/**
 * Strip dollar amounts and trailing tax/flag codes from a label string.
 * e.g. "Total $16.25" → "Total", "BURRITO BOWL 13.99" → "BURRITO BOWL"
 *      "RUSTIC ITALN 5.99 Y" → "RUSTIC ITALN"
 * Strips $-prefixed amounts, bare decimal amounts, and trailing single-char codes
 * (warehouse tax indicators like Y, 3, X, etc.).
 */
export const sanitizeLabel = (label: string): string =>
  label
    .replace(/-?(?:\$\s*[\d,]+(?:\.\d{2})?|[\d,]+\.\d{2})/g, "")
    // Trailing single-char strip targets warehouse tax indicators (Y, X, N, etc.
    // on Costco/Sam's Club receipts). Could theoretically strip a legitimate
    // trailing letter (e.g. "Size S"), but false positive rate on real receipt
    // labels is very low.
    .replace(/\s+[A-Z0-9]\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

export const extractUrl = (text: string): string | null => {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
};

/**
 * Strip browser print timestamp from OCR text.
 * Web-printed PDFs have a timestamp like "2/9/26, 11:23 PM" as the
 * first line which confuses FM date extraction.
 * Only strips if there's another date elsewhere in the text —
 * for in-store receipts, the print date IS the purchase date.
 */
export const stripPrintTimestamp = (text: string): string => {
  const timestampPattern = /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM)?\s*\t?/gim;
  const matches = [...text.matchAll(timestampPattern)];
  if (matches.length === 0) return text;
  // Check if there's a real date elsewhere in the text
  const stripped = text.replace(timestampPattern, "");
  const hasOtherDate = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}[,.]?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}/i.test(stripped);
  return hasOtherDate ? stripped : text;
};

export const stripDeliveryDates = (text: string): string =>
  text.replace(/^(?:Delivered|Shipped|Arriving)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}\s*$/gim, "");

/**
 * Normalize a date string to YYYY-MM-DD format.
 */
export const normalizeDate = (dateStr: string): string => {
  if (!dateStr) return new Date().toISOString().split("T")[0];

  const cleaned = dateStr.trim();
  const currentYear = new Date().getUTCFullYear();
  const minYear = currentYear - 2; // receipts older than 2 years are suspect

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return cleaned;

  // Try native Date parsing on the raw string
  const parsed = new Date(cleaned);
  if (!isNaN(parsed.getTime())) {
    const y = parsed.getUTCFullYear();
    const m = String(parsed.getUTCMonth() + 1).padStart(2, "0");
    const d = String(parsed.getUTCDate()).padStart(2, "0");
    if (y >= minYear && y <= currentYear + 1) return `${y}-${m}-${d}`;
  }

  // Try extracting a date pattern from messy strings (e.g. "Dec 14, 2025 order")
  const datePattern = /(?:(\w{3,9})\s+(\d{1,2}),?\s+(\d{4}))|(?:(\d{1,2})\/(\d{1,2})\/(\d{2,4}))/;
  const match = datePattern.exec(cleaned);
  if (match) {
    let candidate: string;
    if (match[1]) {
      candidate = `${match[1]} ${match[2]}, ${match[3]}`;   // "Dec 14, 2025"
    } else {
      let year = match[6];
      if (year.length === 2) {
        year = `20${year}`;  // "25" → "2025"
      }
      candidate = `${match[4]}/${match[5]}/${year}`;         // "12/14/2025"
    }
    const retried = new Date(candidate);
    if (!isNaN(retried.getTime())) {
      const y = retried.getUTCFullYear();
      const m = String(retried.getUTCMonth() + 1).padStart(2, "0");
      const d = String(retried.getUTCDate()).padStart(2, "0");
      if (y >= minYear && y <= currentYear + 1) return `${y}-${m}-${d}`;
    }
  }

  console.log(`  Warning: could not normalize date "${dateStr}", using today`);
  return new Date().toISOString().split("T")[0];
};

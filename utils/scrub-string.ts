/** Sanitize an LLM-emitted string before it flows to an external API
 *  (YNAB, Actual) or back into the UI on the review screen.
 *
 *  The LLM is partially attacker-influenced: the input PDF is selected
 *  by whoever can deliver a receipt to the user's inbox. A prompt-injected
 *  PDF can cause the LLM to emit control characters, embedded NULs, or
 *  very long strings that confuse downstream APIs or distort UI rendering.
 *
 *  This is a minimal, deterministic scrub:
 *  - Strip C0 control characters (0x00–0x1F) except common whitespace
 *    (tab 0x09, LF 0x0A, CR 0x0D).
 *  - Strip DEL (0x7F).
 *  - Trim leading / trailing whitespace.
 *  - Cap length to the supplied max — silently truncates rather than
 *    erroring, because partial data through is better than blocking
 *    an entire import on one weird field.
 *
 *  Intentionally does NOT strip Unicode bidi, format chars, or zero-width
 *  spaces — those can appear legitimately in non-Latin scripts and
 *  emoji-bearing merchant names. The threat model accepts the tradeoff:
 *  worst case is a confusing review-screen render, mitigated by the
 *  user-review-before-import flow. */
export function scrubLlmString(s: string | undefined, maxLen: number): string {
  if (!s) return "";
  // Strip C0 control chars except \t (0x09), \n (0x0A), \r (0x0D); plus DEL (0x7F).
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  const trimmed = cleaned.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/** Field-specific length budgets. YNAB's API caps memos at 200 chars
 *  (silently truncates above that); we cap below to leave room for the
 *  user's own edits. Merchant / category are user-visible row labels;
 *  long strings deform the UI. */
export const SCRUB_LIMITS = {
  merchant: 100,
  category: 100,
  memo: 200,
  productName: 200,
} as const;

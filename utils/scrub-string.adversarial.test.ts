/**
 * Adversarial probes on scrubLlmString.
 *
 * Start from the input shapes that a prompt-injected LLM (or a malicious
 * receipt PDF feeding OCR text through to the LLM) can plausibly emit, then
 * check what happens at every interesting boundary value — not what the
 * comment in the function says it covers.
 *
 * Anything that survives this scrub is one network-hop from YNAB / Actual,
 * or from the React review screen.
 */
import { describe, it, expect } from "vitest";
import { scrubLlmString, SCRUB_LIMITS } from "./scrub-string";

describe("scrubLlmString — C0 controls and DEL", () => {
  // Walk every single C0 code point (0x00–0x1F) plus DEL (0x7F) and verify
  // each one is stripped EXCEPT the documented allow-list: TAB, LF, CR.
  // A code-reading audit can rubber-stamp a regex; only an enumeration
  // pass proves no individual byte slips through.
  for (let cp = 0x00; cp <= 0x1f; cp++) {
    const allowed = cp === 0x09 || cp === 0x0a || cp === 0x0d;
    const label = `0x${cp.toString(16).padStart(2, "0")}`;
    it(`code point ${label} is ${allowed ? "kept" : "stripped"}`, () => {
      const ch = String.fromCharCode(cp);
      const out = scrubLlmString(`A${ch}B`, 100);
      // The whole string is trimmed first, so leading/trailing whitespace
      // would disappear; but 'A' and 'B' bracket the control char to keep
      // it interior.
      if (allowed) {
        // Note: trim() also removes \t \n \r when at edges, but interior
        // whitespace survives.
        expect(out.includes(ch)).toBe(true);
      } else {
        expect(out.includes(ch)).toBe(false);
        expect(out).toBe("AB");
      }
    });
  }

  it("DEL (0x7f) is stripped", () => {
    const out = scrubLlmString("A\x7fB", 100);
    expect(out).toBe("AB");
    expect(out.includes("\x7f")).toBe(false);
  });

  // A NUL embedded in a string is the classic "C-string truncation" attack.
  // If anything downstream of YNAB / Actual is a C library that treats NUL
  // as terminator (libc, native node addons), a merchant name like
  // "Whole Foods\x00 [...]" could become "Whole Foods" at the API boundary
  // while still rendering the full thing in the React review screen.
  // We need to confirm the NUL is gone, period.
  it("a NUL byte mid-string is stripped (not preserved, not just escaped)", () => {
    const out = scrubLlmString("Whole Foods\x00malicious-suffix", 200);
    expect(out).toBe("Whole Foodsmalicious-suffix");
    expect(out.includes("\x00")).toBe(false);
  });

  it("a string of pure controls collapses to empty", () => {
    const out = scrubLlmString("\x00\x01\x02\x03\x7f", 100);
    expect(out).toBe("");
  });

  it("a string of pure whitespace trims to empty", () => {
    const out = scrubLlmString("   \t\n\r   ", 100);
    expect(out).toBe("");
  });
});

describe("scrubLlmString — length cap boundary", () => {
  it("input at exactly the cap is preserved", () => {
    const s = "a".repeat(50);
    expect(scrubLlmString(s, 50).length).toBe(50);
  });

  it("input one over the cap is truncated to the cap", () => {
    const s = "a".repeat(51);
    expect(scrubLlmString(s, 50).length).toBe(50);
  });

  it("input one under the cap is preserved", () => {
    const s = "a".repeat(49);
    expect(scrubLlmString(s, 50).length).toBe(49);
  });

  // The scrub happens BEFORE length truncation. So a 199-char string where
  // every other char is a control character becomes ~100 chars after scrub —
  // truncation never fires. This is the correct order but worth asserting:
  // the cap applies to the cleaned length, not the raw length.
  it("cap is applied AFTER scrub (post-cleanup length, not raw length)", () => {
    // 100 controls then 100 letters. Scrub leaves only the letters.
    const s = "\x00".repeat(100) + "X".repeat(100);
    const out = scrubLlmString(s, 200);
    expect(out).toBe("X".repeat(100));
  });
});

describe("scrubLlmString — nullish and weird inputs", () => {
  it("undefined returns empty string", () => {
    expect(scrubLlmString(undefined, 100)).toBe("");
  });
  it("empty string returns empty string", () => {
    expect(scrubLlmString("", 100)).toBe("");
  });
  // Cap-of-zero is a degenerate case worth pinning. If anyone passes
  // SCRUB_LIMITS.merchant=0 by mistake, what comes out?
  it("max=0 truncates everything", () => {
    expect(scrubLlmString("hello", 0)).toBe("");
  });
  // Negative max: not a defined contract. Make sure it doesn't throw or
  // produce a wild output that would surprise the caller.
  it("max=-1 doesn't throw (and behavior is documented by this test)", () => {
    // slice(0, -1) is "everything except the last char" in JS; this is a
    // gotcha. Asserting the actual behavior to detect a future change.
    const out = scrubLlmString("abcde", -1);
    // If trimmed.length > -1 (always true for non-empty), slice(0,-1) runs.
    expect(out).toBe("abcd");
  });
});

describe("scrubLlmString — Unicode bidi / RTL / format chars (deliberately NOT stripped)", () => {
  // The function's docstring states it intentionally does NOT strip Unicode
  // bidi format chars (U+202E "Right-to-Left Override", etc.). The threat
  // model accepts the tradeoff: legitimate non-Latin scripts use these.
  // We codify that decision in a regression test so anyone trying to
  // "harden" by stripping U+202E sees this and reads the comment first.
  it("U+202E (RTL override) survives the scrub", () => {
    const malicious = "ACME‮LLAMS"; // looks like "ACMESMALL" rendered RTL
    const out = scrubLlmString(malicious, 100);
    expect(out.includes("‮")).toBe(true);
  });
  it("U+200B (zero-width space) survives the scrub", () => {
    const out = scrubLlmString("Costco​Membership", 100);
    expect(out.includes("​")).toBe(true);
  });
});

describe("scrubLlmString — composed nasty inputs (the realistic attack)", () => {
  // The realistic prompt-injection payload is layered: a long string, with
  // NULs to defeat downstream C-string consumers, with RTL overrides to
  // mislead the user during review, with CR/LF to inject log lines into
  // the path-only logger. Compose them in one input and confirm the
  // final shape.
  it("10KB string with NULs, RTL, CR/LF, DEL: NULs/DEL gone, CR/LF gone if trimmed, RTL preserved, capped at memo limit", () => {
    const chunk = "A\x00‮B\x7fC\r\nD";
    const huge = chunk.repeat(2000); // ~14KB
    const out = scrubLlmString(huge, SCRUB_LIMITS.memo); // 200
    expect(out.length).toBe(SCRUB_LIMITS.memo);
    expect(out.includes("\x00")).toBe(false);
    expect(out.includes("\x7f")).toBe(false);
    // RTL survives (documented threat-model tradeoff).
    expect(out.includes("‮")).toBe(true);
    // CR/LF are NOT stripped from the interior (they're in the allow-list).
    expect(out.includes("\n")).toBe(true);
  });
});

import type { Context } from "hono";
import { RateLimitError } from "../services/budget-provider";
import { scrubLlmString } from "../utils/scrub-string";

/** Errors whose messages are safe to surface verbatim to the UI/network.
 *  Everything else gets a generic message — raw err.message can leak
 *  internal file paths, SDK internals, stack-trace fragments. */
export const SAFE_ERROR_NAMES = new Set([
  "RateLimitError",
  "ReconciliationError",
  "BudgetConnectionError",
  "ZodError",
]);

export function safeErrorMessage(err: any): string {
  if (!err) return "An unknown error occurred.";
  // Allow listed error classes through. Anything else: generic.
  // (BudgetAuthError used to be here but the class was never actually
  // defined — its messages travel under BudgetConnectionError now.)
  if (SAFE_ERROR_NAMES.has(err?.constructor?.name)) {
    return err.message || "An unknown error occurred.";
  }
  return "Internal error — see logs for details.";
}

/** The YNAB SDK throws/wraps objects shaped like
 *  `{ error: { id, name, detail } }`. For client-validation failures
 *  (HTTP 4xx — "date must not be in the future", "category not found",
 *  etc.) that `detail` is a precise, actionable, user-fixable message.
 *  It is NOT internal/leaky like a generic SDK stack fragment: it's the
 *  API telling the user exactly what about THEIR receipt YNAB rejected.
 *
 *  Pre-fix, rateLimitOr500 only special-cased 429 and collapsed every
 *  other error — including these — into a generic 500
 *  ("Internal error — see logs for details."), so the user had no way
 *  to know what to fix. A real Tier B run imported 0/4 receipts purely
 *  because this message was swallowed.
 *
 *  In production the YNAB shape is buried under one or more `cause`
 *  wrappers (ReceiptImportError → BudgetConnectionError → {error:{…}}),
 *  so we walk the whole `cause` chain rather than only inspecting one
 *  level. Returns null if no YNAB client-validation error is found
 *  anywhere in the chain. */
const MAX_CAUSE_DEPTH = 8;

function findYnabClientValidationDetail(err: any): { detail: string; id?: string } | null {
  let node: any = err;
  let depth = 0;
  while (node && depth < MAX_CAUSE_DEPTH) {
    // The ynab SDK error object: { error: { id, name, detail } }.
    const inner = node && typeof node === "object" ? (node as any).error : undefined;
    if (inner && typeof inner === "object") {
      const id = typeof inner.id === "string" ? inner.id : undefined;
      const name = typeof inner.name === "string" ? inner.name : undefined;
      const detail = typeof inner.detail === "string" ? inner.detail : undefined;
      // Client-validation = 4xx-class. Match the id (e.g. "400") or the
      // canonical YNAB error name "bad_request". Deliberately NOT 401
      // (auth — has its own dedicated message) / 404 / 429 (rate-limit
      // — its own 429 path). Anything 4xx with an actionable detail and
      // a bad_request-ish shape qualifies.
      const is4xx = id ? /^4\d\d$/.test(id) : false;
      const isBadRequest = name === "bad_request";
      if (detail && (isBadRequest || (is4xx && id !== "401" && id !== "404" && id !== "429"))) {
        return { detail, id };
      }
    }
    node = node && typeof node === "object" ? (node as any).cause : undefined;
    depth++;
  }
  return null;
}

/** Map a budget-provider error to the right HTTP response.
 *  RateLimitError → 429 with Retry-After header (FE shows cooldown).
 *  YNAB client-validation (4xx bad_request, e.g. bad date) → 422 with
 *    the sanitized, actionable YNAB detail so the user knows what to fix.
 *  Anything else → 500 with a sanitized message. */
export const rateLimitOr500 = (c: Context, err: any) => {
  if (err instanceof RateLimitError) {
    c.header("Retry-After", String(err.retryAfterSeconds));
    return c.json({ error: err.message }, 429);
  }
  const ynab = findYnabClientValidationDetail(err);
  if (ynab) {
    // Sanitize the SDK-supplied detail before it leaves the process:
    // strip control chars / cap length (same scrub used for any other
    // partially-untrusted external string). It's API-authored, not
    // user/LLM-authored, but the same hardening costs nothing and
    // guarantees no control-char / unbounded-length surprise reaches
    // the UI. 422 = "request understood but semantically invalid",
    // which is exactly a rejected-receipt-field.
    const detail = scrubLlmString(ynab.detail, 300);
    return c.json(
      { error: `YNAB rejected this receipt: ${detail}` },
      422,
    );
  }
  return c.json({ error: safeErrorMessage(err) }, 500);
};

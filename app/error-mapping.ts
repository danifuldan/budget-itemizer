import type { Context } from "hono";
import { RateLimitError } from "../services/budget-provider";

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

/** Map a budget-provider error to the right HTTP response.
 *  RateLimitError → 429 with Retry-After header (FE shows cooldown).
 *  Anything else → 500 with a sanitized message. */
export const rateLimitOr500 = (c: Context, err: any) => {
  if (err instanceof RateLimitError) {
    c.header("Retry-After", String(err.retryAfterSeconds));
    return c.json({ error: err.message }, 429);
  }
  return c.json({ error: safeErrorMessage(err) }, 500);
};

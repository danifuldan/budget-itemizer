import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch, ApiError } from "../api/client";

const BASE_DELAY_MS = 3_000;
const MAX_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 8;

interface RetryableFetchOptions {
  enabled?: boolean;
  /** When set, schedule a re-fetch this many ms after each successful response.
   *  Lets callers replace a separate setInterval loop. Reactive — the in-flight
   *  timer cancels and reschedules when the value changes. */
  intervalMs?: number;
}

interface RetryableFetchResult<T> {
  data: T;
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  /** Local optimistic update — for save flows that don't want a re-fetch round trip. */
  mutate: (updater: (prev: T) => T) => void;
}

/**
 * Fetches an endpoint with exponential backoff and a max-attempts cap.
 *
 * Why the cap matters: without it, a misconfigured token or upstream rate-limit
 * causes an infinite 3s retry loop, which on YNAB burns the 200/hr quota in
 * minutes and locks the user out for the rest of the hour. After MAX_ATTEMPTS
 * we stop and surface the empty state — UI can prompt the user to fix their
 * config rather than hammering the API.
 *
 * On 429 we honor `Retry-After` if the server provides one.
 *
 * For polling: callers manage their own setInterval calling `refresh()`.
 * That keeps this hook focused on the retry/backoff problem and avoids
 * having to bake polling cadence into the API.
 */
export function useRetryableFetch<T>(
  path: string,
  fallback: T,
  options: RetryableFetchOptions = {},
): RetryableFetchResult<T> {
  const { enabled = true, intervalMs } = options;
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState<boolean>(enabled);
  const [error, setError] = useState<Error | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const attempts = useRef(0);
  // Ref so run()'s success branch reads the latest intervalMs without
  // having to be re-created on every change (which would also re-mount).
  const intervalMsRef = useRef(intervalMs);
  intervalMsRef.current = intervalMs;

  const run = useCallback(() => {
    apiFetch<T>(path)
      .then((value) => {
        attempts.current = 0;
        setData(value);
        setError(null);
        setLoading(false);
        // Replaces caller-side setInterval. If both enabled and configured,
        // schedule the next poll. The retry path below intentionally uses
        // a different timer (backoff), and they never coexist because
        // success clears `error` and failure leaves `data` untouched.
        if (intervalMsRef.current !== undefined) {
          timer.current = setTimeout(run, intervalMsRef.current);
        }
      })
      .catch((err: Error) => {
        attempts.current += 1;
        setError(err);
        if (attempts.current >= MAX_ATTEMPTS) {
          setLoading(false);
          return;
        }

        let delay = Math.min(BASE_DELAY_MS * 2 ** (attempts.current - 1), MAX_DELAY_MS);
        if (err instanceof ApiError && err.retryAfterSeconds !== null) {
          delay = Math.max(delay, err.retryAfterSeconds * 1000);
        }
        timer.current = setTimeout(run, delay);
      });
  }, [path]);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    attempts.current = 0;
    setLoading(true);
    run();
  }, [run]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    attempts.current = 0;
    setLoading(true);
    run();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [run, enabled]);

  // Reactive interval: if the caller changes intervalMs between renders
  // (e.g., useStatus flips from fast 3s polling to slow 30s once llmReady),
  // cancel the pending interval timer and reschedule at the new cadence.
  // Don't restart fetches — just adjust when the next one fires.
  useEffect(() => {
    if (!enabled || intervalMs === undefined || loading || error) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(run, intervalMs);
  }, [intervalMs, enabled, loading, error, run]);

  const mutate = useCallback((updater: (prev: T) => T) => {
    setData(updater);
  }, []);

  return { data, loading, error, refresh, mutate };
}

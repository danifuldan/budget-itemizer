import { useEffect, useRef } from "react";

/**
 * Calls `refresh` when the app regains focus or its tab becomes visible,
 * but at most once per `throttleMs`. Mount time seeds the last-refresh
 * clock (the caller's mount fetch just ran), so an immediate refocus
 * inside the window is a no-op — this is the "pulled the app back up"
 * resync without hammering YNAB on rapid alt-tabbing.
 *
 * `refresh` is read through a ref so the listeners are attached once and
 * an unstable callback identity doesn't re-bind them every render.
 */
export function useFocusRefresh(refresh: () => void, throttleMs: number): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const lastRunRef = useRef(Date.now());

  useEffect(() => {
    const maybeRefresh = () => {
      const now = Date.now();
      if (now - lastRunRef.current < throttleMs) return;
      lastRunRef.current = now;
      refreshRef.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") maybeRefresh();
    };
    window.addEventListener("focus", maybeRefresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", maybeRefresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [throttleMs]);
}

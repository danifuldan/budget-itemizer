import { useCallback } from "react";
import { apiDelete } from "../api/client";
import type { ImportRecord } from "../api/types";
import { useRetryableFetch } from "./useRetryableFetch";

export function useHistory() {
  const { data: history, loading, refresh, mutate } = useRetryableFetch<ImportRecord[]>("/history?limit=10", []);

  const remove = useCallback((id: string) => {
    // Snapshot the displayed list synchronously at click time. The previous
    // version reverted via refresh() on apiDelete failure, but refresh()
    // under the shared hook keeps stale data on persistent failure rather
    // than blanking the list — so a 500 left the row visually deleted while
    // the server still had it. Capturing the pre-click state here means we
    // can write it back exactly on failure, no refetch required.
    const snapshot = history;
    mutate((prev) => prev.filter((r) => r.id !== id));
    apiDelete(`/history/${id}`).catch(() => {
      mutate(() => snapshot);
    });
  }, [history, mutate]);

  return { history, loading, refresh, remove };
}

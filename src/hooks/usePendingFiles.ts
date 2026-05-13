import { useCallback } from "react";
import { apiFetch } from "../api/client";
import type { PendingFileInfo } from "./useWatcherEvents";

export function usePendingFiles(
  setPendingFiles: React.Dispatch<React.SetStateAction<PendingFileInfo[]>>,
  removePendingLocal: (filename: string) => void,
  pruneStaleBuffers?: (validFilenames: string[]) => void,
) {
  const fetchPending = useCallback(async () => {
    try {
      const files = await apiFetch<PendingFileInfo[]>("/watcher/pending");
      setPendingFiles(files);
      // Sweep buffer entries the server no longer knows about (e.g.
      // after a sidecar restart). Pruning is tied to this server-state
      // refresh — not to every pendingFiles change — so an optimistic
      // Discard followed by a 409 still has its buffered events when
      // the entry is restored.
      pruneStaleBuffers?.(files.map((f) => f.filename));
    } catch {
      // server not reachable
    }
  }, [setPendingFiles, pruneStaleBuffers]);

  const skipFile = useCallback(async (filename: string, detectedAt?: string) => {
    // Optimistically remove from UI — user clicked discard, they want it gone
    removePendingLocal(filename);
    // Pass detectedAt as a version token so the server can refuse the
    // delete if a concurrent re-upload changed the entry. On 409, refetch
    // to re-surface the (now-newer) entry instead of leaving the FE state
    // out of sync with the server.
    const qs = detectedAt ? `?detectedAt=${encodeURIComponent(detectedAt)}` : "";
    try {
      await apiFetch(`/watcher/pending/${encodeURIComponent(filename)}${qs}`, { method: "DELETE" });
    } catch (err: any) {
      const status = typeof err?.status === "number" ? err.status : undefined;
      if (status === 409) {
        await fetchPending();
        return;
      }
      console.warn(`Failed to delete pending file on server: ${err}`);
    }
  }, [removePendingLocal, fetchPending]);

  return { fetchPending, skipFile };
}

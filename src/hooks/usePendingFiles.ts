import { useCallback } from "react";
import { apiFetch, ApiError } from "../api/client";
import { sendNotification } from "./useWatcherNotifications";
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
        // Concurrent re-upload — refresh to show the new entry.
        await fetchPending();
        return;
      }
      // Any other failure (422 = no processed folder; 500 = dispose
      // failed; network = server unreachable) → roll back the optimistic
      // remove by refetching, and surface the server-provided reason.
      // Without this, the entry silently ghost-resurrects on the next
      // poll with no clue why the discard didn't stick.
      let reason = "Could not discard the receipt";
      if (err instanceof ApiError) {
        try {
          const parsed = JSON.parse(err.body) as { error?: string };
          if (parsed.error) reason = parsed.error;
        } catch {
          if (err.body) reason = err.body;
        }
      } else if (err?.message) {
        reason = err.message;
      }
      console.warn(`Failed to delete pending file on server: ${err}`);
      void sendNotification("Couldn't discard receipt", reason);
      await fetchPending();
    }
  }, [removePendingLocal, fetchPending]);

  return { fetchPending, skipFile };
}

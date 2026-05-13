import { useState, useEffect, useRef, useCallback } from "react";
import { API_BASE, apiFetch } from "../api/client";
import type { Receipt } from "../api/types";

export interface ParseProgressEvent {
  filename: string;
  event: "status" | "header" | "item" | "total" | "categories";
  data: unknown;
}

export interface PendingFileInfo {
  filename: string;
  filePath: string;
  detectedAt: string;
  status: "parsing" | "ready" | "error";
  receipt?: Receipt;
  parseError?: string;
}

interface FileProcessedInfo {
  filename: string;
  merchant: string;
  totalAmount: number;
  success: boolean;
}

export function useWatcherEvents(
  onProcessed?: () => void,
  onReconnect?: () => void,
  onParseProgress?: (e: ParseProgressEvent) => void,
  onCategoriesRevalidated?: (affected: string[]) => void,
) {
  const [pendingFiles, setPendingFiles] = useState<PendingFileInfo[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onProcessedRef = useRef(onProcessed);
  onProcessedRef.current = onProcessed;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;
  const onParseProgressRef = useRef(onParseProgress);
  onParseProgressRef.current = onParseProgress;
  const onCategoriesRevalidatedRef = useRef(onCategoriesRevalidated);
  onCategoriesRevalidatedRef.current = onCategoriesRevalidated;

  // Buffer progress events per-file so nothing is lost before the user clicks to view
  const progressBufferRef = useRef<Map<string, ParseProgressEvent[]>>(new Map());

  // Track approximate parse progress (0–1) per file for the progress bar
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnecting = false;

    // EventSource can't carry an Authorization header, so we exchange our
    // basic-auth credentials for a short-lived SSE token first.
    apiFetch<{ token: string }>("/auth/sse-token")
      .then(({ token }) => {
        if (cancelled) return;
        es = new EventSource(`${API_BASE}/watcher/events?token=${encodeURIComponent(token)}`);
        eventSourceRef.current = es;
        attachListeners(es);
      })
      .catch(() => {
        // No token, no stream. The watcher panel will be empty until the
        // user re-authenticates; surfacing a UI error here is left to the
        // caller via onReconnect's absence.
      });

    function attachListeners(es: EventSource) {

    const maybeResync = () => {
      if (reconnecting) {
        reconnecting = false;
        onReconnectRef.current?.();
      }
    };

    es.addEventListener("file-queued", (e) => {
      maybeResync();
      try {
        const data: PendingFileInfo = JSON.parse(e.data);
        setPendingFiles((prev) => {
          if (prev.some((f) => f.filename === data.filename)) return prev;
          return [...prev, data];
        });
        setProgressMap((prev) => ({ ...prev, [data.filename]: 0.05 }));
      } catch {}
    });

    es.addEventListener("file-parsed", (e) => {
      maybeResync();
      try {
        const data = JSON.parse(e.data);
        // Clean up buffer for this file
        progressBufferRef.current.delete(data.filename);
        setPendingFiles((prev) =>
          prev.map((f) =>
            f.filename === data.filename
              ? {
                  ...f,
                  status: data.error ? "error" as const : "ready" as const,
                  receipt: data.receipt,
                  parseError: data.error,
                }
              : f
          )
        );
        setProgressMap((prev) => {
          const next = { ...prev };
          if (data.error) { delete next[data.filename]; } else { next[data.filename] = 1; }
          return next;
        });
      } catch {}
    });

    es.addEventListener("file-parse-progress", (e) => {
      maybeResync();
      try {
        const data: ParseProgressEvent = JSON.parse(e.data);
        // Buffer it
        if (!progressBufferRef.current.has(data.filename)) {
          progressBufferRef.current.set(data.filename, []);
        }
        progressBufferRef.current.get(data.filename)!.push(data);
        // Forward live
        onParseProgressRef.current?.(data);
        // Update progress estimate
        setProgressMap((prev) => {
          const cur = prev[data.filename] || 0;
          let next = cur;
          switch (data.event) {
            case "status": next = Math.max(cur, 0.08); break;
            case "header": next = Math.max(cur, 0.25); break;
            case "item": {
              const idx = (data.data as { index: number }).index ?? 0;
              next = Math.max(cur, 0.30 + Math.min(0.35, (idx + 1) * 0.04));
              break;
            }
            case "total": next = Math.max(cur, 0.75); break;
            case "categories": next = Math.max(cur, 0.92); break;
          }
          return next !== cur ? { ...prev, [data.filename]: next } : prev;
        });
      } catch {}
    });

    es.addEventListener("file-processed", (e) => {
      maybeResync();
      try {
        const data: FileProcessedInfo = JSON.parse(e.data);
        progressBufferRef.current.delete(data.filename);
        setPendingFiles((prev) => prev.filter((f) => f.filename !== data.filename));
        setProgressMap((prev) => {
          const next = { ...prev };
          delete next[data.filename];
          return next;
        });
        onProcessedRef.current?.();
      } catch {}
    });

    es.addEventListener("ping", () => {
      maybeResync();
    });

    // Fired by the backend after YNAB reconnects following an offline
    // period — receipts whose categories no longer exist upstream had
    // those assignments cleared. The component-level callback decides
    // how to surface this (toast, notification, in-app banner, etc.).
    es.addEventListener("categories-revalidated", (e) => {
      maybeResync();
      try {
        const data = JSON.parse(e.data) as { affected: string[] };
        if (data.affected?.length > 0) {
          onCategoriesRevalidatedRef.current?.(data.affected);
        }
      } catch {}
    });

    es.onerror = () => {
      reconnecting = true;
    };
    } // end attachListeners

    return () => {
      cancelled = true;
      es?.close();
      eventSourceRef.current = null;
    };
  }, []);

  // Prune buffer entries that the server no longer knows about. Used
  // by fetchPending after a sidecar-restart resync — pre-fix, a useEffect
  // pruned on *every* pendingFiles change, including the optimistic
  // remove during a Discard click; if the DELETE then 409'd and the
  // entry was restored, the user's review screen would replay nothing
  // because the early parse-progress events had already been swept.
  // Tying prune to fetchPending keeps the post-reconnect cleanup
  // without firing during transient optimistic state.
  const pruneStaleBuffers = useCallback((validFilenames: string[]) => {
    const valid = new Set(validFilenames);
    for (const key of progressBufferRef.current.keys()) {
      if (!valid.has(key)) progressBufferRef.current.delete(key);
    }
  }, []);

  const removePendingLocal = useCallback((filename: string) => {
    // Intentionally does NOT delete progressBufferRef[filename]. If the
    // DELETE round-trip 409s and the entry is restored via fetchPending,
    // we still have the buffered parse-progress events to replay on the
    // review screen. Backend events (file-parsed, file-processed) and
    // pruneStaleBuffers handle the real cleanup.
    setPendingFiles((prev) => prev.filter((f) => f.filename !== filename));
    setProgressMap((prev) => {
      const next = { ...prev };
      delete next[filename];
      return next;
    });
  }, []);

  const getBufferedProgress = useCallback((filename: string): ParseProgressEvent[] => {
    return progressBufferRef.current.get(filename) || [];
  }, []);

  return { pendingFiles, setPendingFiles, removePendingLocal, getBufferedProgress, progressMap, pruneStaleBuffers };
}

import { useState, useEffect, useRef } from "react";
import { apiFetch, apiPost, streamSSEPost } from "../api/client";

export interface AvailableModel {
  id: string;
  name: string;
  size: string;
  downloaded: boolean;
}

export interface ModelDownloadState {
  downloading: boolean;
  /** 0–100; survives across pause so resume doesn't snap to 0 before the
   *  first SSE event lands. */
  percent: number;
  error: string;
  /** True only after the model file is on disk AND post-activate +
   *  onActivated callback have succeeded. Wizard's Next button is gated
   *  on this; gating on file-on-disk alone would let the user advance
   *  while activation is still in flight (or failed). */
  done: boolean;
  confirmDeleteOpen: boolean;
}

export interface UseModelDownloadOptions {
  modelId: string;
  /** Called after `/models/activate` succeeds. If this throws, `done`
   *  stays false and `state.error` is populated. Wizard uses this to
   *  call `saveSetup({ embeddedModel })`. */
  onActivated?: () => Promise<void> | void;
  /** Called after `/models/delete` succeeds. Used by settings/wizard to
   *  refresh derived state outside the hook (e.g. availableModels list). */
  onDeleted?: () => Promise<void> | void;
  /** If supplied, used to determine `installed` instead of re-fetching
   *  /models/available on every mount. Settings owns its own model list
   *  for the UI (download progress + delete button live next to it). */
  embeddedModelInConfig?: string;
}

export interface UseModelDownloadReturn {
  state: ModelDownloadState;
  /** True iff the model file is on disk per the latest /models/available
   *  fetch. Distinct from `state.done` — `done` also requires activation
   *  + onActivated to have completed. */
  installed: boolean;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  requestDelete: () => void;
  cancelDelete: () => void;
  performDelete: () => Promise<void>;
  primaryLabel: string;
  /** True when the user has a partial download but isn't currently
   *  fetching. `start()` from this state resumes (does NOT zero percent). */
  isPaused: boolean;
  deleteConfirmMessage: string;
}

/**
 * Manages the entire download/activate/delete lifecycle for a builtin model.
 *
 * Used by SettingsView (Settings → AI Model) and SetupWizard (step 1).
 * Both screens previously hand-rolled this state machine and drifted
 * (wizard checked `percent > 0 && !done` for resume; settings checked
 * `percent > 0`). The hook locks down a single behavior — wizard's,
 * which is the safer of the two.
 */
export function useModelDownload(options: UseModelDownloadOptions): UseModelDownloadReturn {
  const { modelId, onActivated, onDeleted, embeddedModelInConfig } = options;

  const [downloading, setDownloading] = useState(false);
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const [available, setAvailable] = useState<AvailableModel[]>([]);

  // Held across renders so `pause()` and `performDelete()` can tear down
  // the in-flight SSE reader synchronously. Allocated once (ref), mutated
  // inside `start()` — never realloc'd, never read in render.
  const abortRef = useRef<AbortController | null>(null);

  const installed = available.find((m) => m.id === modelId)?.downloaded ?? false;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const models = await apiFetch<AvailableModel[]>("/models/available");
        if (cancelled) return;
        setAvailable(models);
        // Seed `done = true` only when the model is installed AND the
        // currently-active model in config matches this id. Settings
        // omits embeddedModelInConfig (it doesn't gate Next on done) and
        // gets installed-only semantics, which matches the old behavior.
        const isInstalled = models.find((m) => m.id === modelId)?.downloaded;
        if (isInstalled && (!embeddedModelInConfig || embeddedModelInConfig === modelId)) {
          setDone(true);
        }
      } catch {
        // Silent — UI surfaces "no model installed" by default, which is
        // the right initial state if /models/available is unreachable.
      }
    })();
    return () => { cancelled = true; };
    // Intentional: mount-once. The modelId is fixed per-hook-instance in
    // practice, and re-running on identity changes would clobber an
    // in-flight download. If a caller ever needs to swap modelId at
    // runtime, this guard becomes the bug — but no caller does today.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    // If resuming, keep the existing percent so the progress bar doesn't
    // snap back to 0 before the first SSE event lands. Wizard's original
    // form (`percent > 0 && !done`) is the canonical one — settings's
    // simpler `percent > 0` over-counted (it considered a freshly-installed
    // model as "resuming"), but in practice that was unobservable because
    // settings hid the button after install. Use the safer form here.
    const isResuming = percent > 0 && !done;
    setDownloading(true);
    setError("");
    if (!isResuming) setPercent(0);
    setDone(false);

    const abort = new AbortController();
    abortRef.current = abort;

    await streamSSEPost(
      "/models/download",
      { modelId },
      (event, data: any) => {
        if (event === "progress") {
          if (data.percent != null) setPercent(data.percent);
          if (data.done) {
            // Activate llama-server and invoke onActivated BEFORE flipping
            // `done = true`. Next button is gated on `done`, so flipping
            // early would let the user advance while activation is still
            // in flight (or has failed). Fire-and-forget the chain so we
            // don't block the SSE reader; only set done on full success.
            void (async () => {
              try {
                await apiPost("/models/activate", { modelId });
              } catch (err: any) {
                setError(`Model downloaded but failed to activate: ${err?.message ?? "unknown"}. Try restarting the app.`);
                return;
              }
              try {
                await onActivated?.();
              } catch (err: any) {
                setError(`Model downloaded but failed to save settings: ${err?.message ?? "unknown"}. Try restarting the app.`);
                return;
              }
              // Refresh local mirror so `installed` flips and the X button
              // re-labels itself ("Delete partial download" → "Delete model").
              setAvailable((prev) => prev.map((m) => m.id === modelId ? { ...m, downloaded: true } : m));
              setDone(true);
            })();
          }
          // `error: "cancelled"` is the user-initiated stop sentinel — quiet.
        } else if (event === "error" && data?.error) {
          setError(data.error);
        }
      },
      (err) => setError(err.message),
      abort.signal,
    );

    setDownloading(false);
    if (abortRef.current === abort) abortRef.current = null;
  };

  const pause = async () => {
    // Abort the FE reader first so the UI updates instantly, then tell
    // the server to stop writing to disk.
    abortRef.current?.abort();
    try {
      await apiPost("/models/cancel-download", {});
    } catch {
      // Best-effort. Even if the server doesn't get the cancel, the FE
      // reader is dead and the partial file stays on disk for resume.
    }
  };

  const requestDelete = () => {
    // While the confirm dialog is open, the download is paused — otherwise
    // the percent keeps climbing in the background, visually inconsistent
    // with a dialog the user is reading about deletion.
    if (downloading) void pause();
    setConfirmDeleteOpen(true);
  };

  const cancelDelete = () => setConfirmDeleteOpen(false);

  const performDelete = async () => {
    setConfirmDeleteOpen(false);
    // Tear down the in-flight SSE reader synchronously so `start()` can
    // finish unwinding before /models/delete fires.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    try {
      await apiPost("/models/cancel-download", {}).catch(() => {});
      await apiPost("/models/delete", { modelId });
      setAvailable((prev) => prev.map((m) => m.id === modelId ? { ...m, downloaded: false } : m));
      setDone(false);
      setPercent(0);
      setError("");
      setDownloading(false);
      try {
        await onDeleted?.();
      } catch {
        // Best-effort — the model is deleted regardless.
      }
    } catch (err: any) {
      setError(`Delete failed: ${err?.message ?? "unknown"}`);
    }
  };

  const isPaused = !downloading && !done && !installed && percent > 0;

  const primaryLabel = downloading
    ? `Pause download (${percent}%)`
    : isPaused
      ? `Resume download (${percent}%)`
      : "Download Model";

  const deleteConfirmMessage = downloading
    ? "Delete the partial download? You'll lose your progress and need to start over from 0%."
    : installed
      ? "Delete the model? You'll need to re-download about 4.9 GB to use Budget Itemizer again."
      : "Delete the partial download? You'll start over from 0%.";

  return {
    state: { downloading, percent, error, done, confirmDeleteOpen },
    installed,
    start,
    pause,
    requestDelete,
    cancelDelete,
    performDelete,
    primaryLabel,
    isPaused,
    deleteConfirmMessage,
  };
}

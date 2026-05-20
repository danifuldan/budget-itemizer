import { useEffect, useState } from "react";
import { useRetryableFetch } from "./useRetryableFetch";

interface StatusResponse {
  watcher?: { running?: boolean; inboxPath?: string; processedPath?: string; inboxExists?: boolean };
  setup?: boolean;
  llmReady?: boolean;
  llmStartError?: string | null;
}

interface StatusData {
  watcherRunning: boolean;
  watcherPath: string;
  /** True iff the configured inbox directory exists on disk. When this is
   *  false (or running is false despite setup being complete), the UI
   *  should surface the problem so the user knows why files aren't
   *  being detected. */
  watcherInboxExists: boolean;
  setupComplete: boolean;
  llmReady: boolean;
  /** Set when the builtin llama-server failed its most recent start
   *  attempt. The FE uses this to render a recoverable error UI
   *  instead of leaving the user stuck on a "Loading AI model…" splash
   *  forever. */
  llmStartError: string | null;
}

const NORMAL_INTERVAL_MS = 30_000;
const FAST_INTERVAL_MS = 3_000;

export function useStatus() {
  // Two passes through the data: read llmReady out first to drive the
  // polling cadence, then re-read for the rest of the shape. Single
  // hook call — useRetryableFetch reacts to intervalMs changes.
  const [llmReadyForCadence, setLlmReadyForCadence] = useState(false);

  // When the window is hidden (red close-button on macOS hides it but
  // keeps the webview alive) the FE has no user to update, so pause
  // /status polling. The server-side watcher + parse pipeline run
  // independently of this hook — they keep working. Polling resumes on
  // visibilitychange when the window returns. `intervalMs: undefined`
  // tells useRetryableFetch not to schedule the next tick.
  const [visible, setVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  const intervalMs = !visible
    ? undefined
    : llmReadyForCadence
      ? NORMAL_INTERVAL_MS
      : FAST_INTERVAL_MS;

  const { data: raw, loading, refresh } = useRetryableFetch<StatusResponse>(
    "/status",
    {},
    { intervalMs },
  );

  // Sticky "have we ever loaded" flag. App.tsx uses this to gate splash vs.
  // real UI; if it flipped back to false on every poll's brief loading=true
  // window, the splash would re-mount and reset child component state
  // (notably SetupWizard's `step`).
  const [hasLoaded, setHasLoaded] = useState(false);
  useEffect(() => {
    if (!loading && !hasLoaded) setHasLoaded(true);
  }, [loading, hasLoaded]);

  const status: StatusData = {
    watcherRunning: raw.watcher?.running ?? false,
    watcherPath: raw.watcher?.inboxPath ?? "",
    watcherInboxExists: raw.watcher?.inboxExists ?? true,
    setupComplete: raw.setup ?? false,
    llmReady: raw.llmReady ?? false,
    llmStartError: raw.llmStartError ?? null,
  };

  // Mirror llmReady into the cadence flag so the next render's intervalMs
  // reflects the new steady state. useRetryableFetch's reactive useEffect
  // re-schedules the next tick at the new interval automatically.
  useEffect(() => {
    if (status.llmReady !== llmReadyForCadence) setLlmReadyForCadence(status.llmReady);
  }, [status.llmReady, llmReadyForCadence]);

  return { ...status, loaded: hasLoaded, refresh };
}

import type { UseModelDownloadReturn } from "../hooks/useModelDownload";

interface ModelDownloadCardProps {
  download: UseModelDownloadReturn;
  /** Settings always shows "Model installed" status when downloaded;
   *  wizard shows "Model ready". Default true (both screens currently
   *  show their success row). */
  showInstalledRow?: boolean;
  variant: "wizard" | "settings";
  /** Wizard supplies this so the AI-Setup status text has a stable
   *  aria-describedby target for the primary button. */
  statusAnnouncerId?: string;
}

/**
 * Shared model-download UI used by SetupWizard step 1 and the AI Model
 * row in SettingsView. Pure presentational — all state and side-effects
 * live in `useModelDownload` (the `download` prop).
 *
 * Variants differ in two small ways:
 * - wizard: full-width primary button + aria-live status announcer
 *   (screen readers track the percent without focus-stealing).
 * - settings: small button, no announcer, "Model installed" success row.
 *
 * The X (delete) button's aria-label switches between "Delete model" and
 * "Delete partial download" — both strings are load-bearing for
 * e2e/download-delete.spec.ts.
 *
 * The ConfirmDialog itself lives at the route level (SettingsView /
 * SetupWizard) instead of inside this component so focus + z-index work
 * correctly across the page chrome.
 */
export default function ModelDownloadCard({
  download,
  showInstalledRow = true,
  variant,
  statusAnnouncerId,
}: ModelDownloadCardProps) {
  const {
    state: { downloading, percent, error, done },
    installed,
    start,
    pause,
    requestDelete,
    primaryLabel,
    isPaused,
  } = download;

  const primaryAction = downloading ? pause : start;
  // "Delete model" must match e2e/download-delete.spec.ts exactly when
  // the model file is on disk. "Delete partial download" otherwise.
  const deleteLabel = installed ? "Delete model" : "Delete partial download";

  // Settings: the success state is rendered as a span (no button); the
  // primary button is hidden because there's nothing left to do.
  // Wizard: the success state shows beneath the button, and the button
  // disappears when `done` is set.
  if (variant === "wizard") {
    return (
      <>
        {!done && (
          <button
            className="btn btn-primary btn-full"
            onClick={primaryAction}
            aria-describedby={statusAnnouncerId}
          >
            {primaryLabel === "Download Model" ? "Download Llama 3.1 8B" : primaryLabel}
          </button>
        )}
        {statusAnnouncerId && (
          <div id={statusAnnouncerId} aria-live="polite" className="visually-hidden">
            {downloading ? `Download in progress: ${percent} percent` : error ? `Download failed: ${error}` : ""}
          </div>
        )}

        {(downloading || isPaused) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <div
              className="progress-bar"
              style={{ flex: 1 }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-label="Model download progress"
            >
              <div className="progress-fill" style={{ width: `${percent}%` }} />
            </div>
            <button
              className="btn-icon"
              onClick={requestDelete}
              aria-label="Delete partial download"
              title="Delete partial download"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          </div>
        )}

        {error && <div className="test-result error" style={{ marginTop: 8 }} role="alert">{error}</div>}

        {showInstalledRow && done && (
          <div style={{ marginTop: 8, display: "flex", justifyContent: "center", alignItems: "center", gap: 8 }}>
            <span className="test-result success" style={{ margin: 0 }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M4.5 7L6.5 9L9.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Model ready
            </span>
            <button
              className="btn-icon"
              onClick={requestDelete}
              aria-label="Delete model"
              title="Delete model"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          </div>
        )}
      </>
    );
  }

  // settings variant
  const showDelete = installed || downloading || isPaused;
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}>
        {installed ? (
          showInstalledRow ? (
            <span className="test-result success" style={{ margin: 0 }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
                <path d="M4.5 7L6.5 9L9.5 5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Model installed
            </span>
          ) : null
        ) : (
          <button className="btn btn-sm btn-primary" onClick={primaryAction}>
            {primaryLabel}
          </button>
        )}
        {showDelete && (
          <button
            className="btn-icon"
            onClick={requestDelete}
            aria-label={deleteLabel}
            title={deleteLabel}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" />
            </svg>
          </button>
        )}
      </div>
      {(downloading || isPaused) && (
        <div className="progress-bar" style={{ marginTop: 8 }}>
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
      {error && <div className="test-result error" style={{ marginTop: 8 }}>{error}</div>}
    </>
  );
}

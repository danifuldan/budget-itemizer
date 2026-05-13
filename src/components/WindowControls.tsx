import { getCurrentWindow } from "@tauri-apps/api/window";

/** Custom window controls for Windows/Linux (no native decorations). */
export default function WindowControls() {
  // Only render inside Tauri
  if (!(window as any).__TAURI_INTERNALS__) return null;

  const win = getCurrentWindow();

  return (
    <div className="window-controls">
      <button
        className="window-control-btn"
        onClick={() => win.minimize()}
        aria-label="Minimize"
      >
        <svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true">
          <rect width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        className="window-control-btn"
        onClick={() => win.toggleMaximize()}
        aria-label="Maximize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        className="window-control-btn window-control-close"
        onClick={() => win.close()}
        aria-label="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

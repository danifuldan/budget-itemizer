import TitlebarRegion from "./TitlebarRegion";

interface LlmStartErrorScreenProps {
  error: string;
  onOpenSettings: () => void;
}

/** Shown when the builtin llama-server failed its most recent start
 *  attempt. Replaces the "Loading AI model…" splash so the user has a
 *  clear path forward (Settings) instead of being stranded on a screen
 *  that suggests the wait will eventually end. */
export default function LlmStartErrorScreen({ error, onOpenSettings }: LlmStartErrorScreenProps) {
  return (
    <div className="splash-screen">
      <TitlebarRegion />
      <div className="splash-content" role="alert" aria-atomic="true">
        <div className="splash-mark splash-mark-error" aria-hidden="true">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="24" cy="24" r="18" />
            <line x1="24" y1="16" x2="24" y2="26" />
            <circle cx="24" cy="32" r="1.2" fill="currentColor" />
          </svg>
        </div>
        <div className="splash-name">AI model didn't start</div>
        <div className="splash-primary">{error}</div>
        <div className="splash-secondary">
          Open Settings to choose a different model or check the logs.
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onOpenSettings}
          style={{ marginTop: "1rem" }}
        >
          Open Settings
        </button>
      </div>
    </div>
  );
}

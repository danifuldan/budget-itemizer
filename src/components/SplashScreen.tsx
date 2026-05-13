import TitlebarRegion from "./TitlebarRegion";

export type SplashPhase = "connecting" | "starting-ai" | "init-failed";

interface SplashScreenProps {
  phase: SplashPhase;
  errorMessage?: string;
}

const MESSAGES: Record<SplashPhase, { primary: string; secondary?: string }> = {
  connecting: {
    primary: "Starting up…",
    secondary: "Connecting to the local server.",
  },
  "starting-ai": {
    primary: "Loading local AI model…",
    secondary: "This can take a minute at launch.",
  },
  "init-failed": {
    primary: "Couldn't reach the local server.",
    secondary: "Quit the app and relaunch. If this keeps happening, reveal logs from Settings.",
  },
};

export default function SplashScreen({ phase, errorMessage }: SplashScreenProps) {
  const { primary, secondary } = MESSAGES[phase];
  const secondaryText = errorMessage ?? secondary;
  return (
    <div className="splash-screen">
      <TitlebarRegion />
      <div className="splash-content" role="status" aria-live="polite" aria-atomic="true">
        <div className="splash-mark" aria-hidden="true">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="11" y="6" width="26" height="36" rx="4" />
            <line x1="17" y1="16" x2="31" y2="16" />
            <line x1="17" y1="22" x2="31" y2="22" />
            <line x1="17" y1="28" x2="25" y2="28" />
          </svg>
        </div>
        <div className="splash-name">Budget Itemizer</div>
        {phase !== "init-failed" && (
          <div className="splash-progress" aria-hidden="true">
            <div className="splash-progress-bar" />
          </div>
        )}
        <div className="splash-primary">{primary}</div>
        {secondaryText && <div className="splash-secondary">{secondaryText}</div>}
      </div>
    </div>
  );
}

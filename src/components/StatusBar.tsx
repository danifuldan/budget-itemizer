import type { ReactNode } from "react";

type ThemePreference = "system" | "light" | "dark";

interface StatusBarProps {
  watcherRunning: boolean;
  watcherPath: string;
  watcherInboxExists: boolean;
  setupComplete: boolean;
  llmReady: boolean;
  themePreference: ThemePreference;
  onThemeChange: (pref: ThemePreference) => void;
  onSettingsClick: () => void;
}

const sunIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="5"/>
    <path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
  </svg>
);

const moonIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
  </svg>
);

const systemIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"/>
    <path d="M12 3 A9 9 0 0 1 12 21 Z" fill="currentColor" stroke="none"/>
  </svg>
);

function getVisualIcon(pref: ThemePreference): ReactNode {
  if (pref === "light") return sunIcon;
  if (pref === "dark") return moonIcon;
  return systemIcon;
}

const nextTheme: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const themeLabel: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "Auto",
};

export default function StatusBar({ watcherRunning, watcherPath, watcherInboxExists, setupComplete, llmReady, themePreference, onThemeChange, onSettingsClick }: StatusBarProps) {
  // Three watcher states the user might see:
  //   - Running and reachable: green dot, "Watching <path>"
  //   - Setup not done yet: neutral, "Watcher idle" (expected)
  //   - Setup done but watcher couldn't bind: red dot, "Inbox not found —
  //     check Settings" (covers missing path, permission denied, ejected
  //     external drive, etc.)
  const watcherBroken = setupComplete && !watcherRunning;
  const watcherDotColor = watcherRunning ? "green" : watcherBroken ? "red" : null;
  const watcherBrokenLabel = watcherInboxExists
    ? "Can't read inbox folder — check Settings"
    : "Inbox folder not found — check Settings";
  const aiLabel = !setupComplete
    ? "Setup needed"
    : llmReady
      ? "AI Ready"
      : "LLM loading\u2026";
  const aiDotColor = !setupComplete
    ? "yellow"
    : llmReady
      ? "green"
      : "yellow";

  return (
    <div className="statusbar" role="status" aria-live="polite">
      <div className="status-group">
        {watcherDotColor && <span className={`status-dot ${watcherDotColor}`} aria-hidden="true" />}
        {watcherRunning ? (
          <button className="status-link" onClick={onSettingsClick} aria-label={`Watching ${watcherPath || "inbox"}. Open settings to change.`}>
            Watching {watcherPath || "inbox"}
          </button>
        ) : watcherBroken ? (
          <button className="status-link" onClick={onSettingsClick} aria-label={`${watcherBrokenLabel}. Open settings.`}>
            {watcherBrokenLabel}
          </button>
        ) : (
          <span>Watcher idle</span>
        )}
      </div>
      <div className="status-group">
        <span className={`status-dot ${aiDotColor}`} aria-hidden="true" />
        <button className="status-link" onClick={onSettingsClick} aria-label={`${aiLabel}. Open settings.`}>
          {aiLabel}
        </button>
        <button
          className="gear-btn"
          aria-label={`Theme: ${themeLabel[themePreference]}. Click to change.`}
          onClick={() => onThemeChange(nextTheme[themePreference])}
          type="button"
        >
          {getVisualIcon(themePreference)}
        </button>
      </div>
    </div>
  );
}

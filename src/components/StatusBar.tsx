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
  onSettingsClick: (section?: string) => void;
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

export type WatcherView = {
  dot: "green" | "red" | null;
  label: string;
  kind: "watching" | "alert" | "idle";
};

/** Pure: the user-facing watcher state. `running` means "the fs.watch
 *  handle exists" — NOT that the inbox is reachable. A running watcher
 *  whose inbox vanished (ejected drive / dropped mount) must NOT read as
 *  "Watching"; surface the truth via inboxExists, which /status already
 *  reports. (Recovery — actually re-arming fs.watch when the path
 *  returns — is the watcher-side half of this fix.) */
export function watcherStatusView(s: {
  setupComplete: boolean;
  running: boolean;
  inboxExists: boolean;
  path: string;
}): WatcherView {
  if (s.running && s.inboxExists) {
    return { dot: "green", label: `Watching ${s.path || "inbox"}`, kind: "watching" };
  }
  if (s.running && !s.inboxExists) {
    return {
      dot: "red",
      label: "Inbox unreachable — reconnect the drive or check Settings",
      kind: "alert",
    };
  }
  if (s.setupComplete && !s.running) {
    return {
      dot: "red",
      label: s.inboxExists
        ? "Can't read inbox folder — check Settings"
        : "Inbox folder not found — check Settings",
      kind: "alert",
    };
  }
  return { dot: null, label: "Watcher idle", kind: "idle" };
}

export default function StatusBar({ watcherRunning, watcherPath, watcherInboxExists, setupComplete, llmReady, themePreference, onThemeChange, onSettingsClick }: StatusBarProps) {
  const watcher = watcherStatusView({
    setupComplete,
    running: watcherRunning,
    inboxExists: watcherInboxExists,
    path: watcherPath,
  });
  const aiLabel = !setupComplete
    ? "Setup needed"
    : llmReady
      ? "AI ready"
      : "Loading AI model\u2026";
  const aiDotColor = !setupComplete
    ? "yellow"
    : llmReady
      ? "green"
      : "yellow";

  return (
    <div className="statusbar" role="status" aria-live="polite">
      <div className="status-group">
        {watcher.dot && <span className={`status-dot ${watcher.dot}`} aria-hidden="true" />}
        {watcher.kind === "idle" ? (
          <span>{watcher.label}</span>
        ) : (
          <button
            className="status-link"
            onClick={() => onSettingsClick("folder-watcher")}
            aria-label={`${watcher.label}. Open settings${watcher.kind === "watching" ? " to change" : ""}.`}
          >
            {watcher.label}
          </button>
        )}
      </div>
      <div className="status-group">
        <span className={`status-dot ${aiDotColor}`} aria-hidden="true" />
        <button className="status-link" onClick={() => onSettingsClick("ai-model")} aria-label={`${aiLabel}. Open settings.`}>
          {aiLabel}
        </button>
        {setupComplete && !llmReady && (
          <svg className="ai-spinner" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.25" />
            <path d="M21 12 a9 9 0 0 1 -9 9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
          </svg>
        )}
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

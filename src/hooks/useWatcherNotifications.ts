import { useEffect, useRef } from "react";
import { isPermissionGranted, requestPermission, sendNotification as tauriSendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PendingFileInfo } from "./useWatcherEvents";
import type { ConfigData } from "./useConfig";

// Tauri's runtime is detected via window.__TAURI_INTERNALS__. Static imports
// of the API modules are safe in any environment — the modules just load JS,
// the actual platform calls only fire when invoked. WindowControls.tsx imports
// from the same module statically; doing it here too lets Vite chunk-split.
const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Request notification permission eagerly at startup so the first real
// notification isn't swallowed by a permission prompt.
const initPermission = (async () => {
  if (!inTauri()) return;
  try {
    if (!(await isPermissionGranted())) await requestPermission();
  } catch {
    // ignore
  }
})();

export async function sendNotification(title: string, body: string) {
  await initPermission;
  if (!inTauri()) return;
  try {
    if (await isPermissionGranted()) tauriSendNotification({ title, body });
  } catch {
    // silently ignore
  }
}

async function focusWindow() {
  if (!inTauri()) return;
  try {
    await getCurrentWindow().setFocus();
  } catch {
    // silently ignore
  }
}

export function useWatcherNotifications(
  pendingFiles: PendingFileInfo[],
  config: ConfigData,
) {
  const prevCountRef = useRef(pendingFiles.length);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    const newCount = pendingFiles.length;
    prevCountRef.current = newCount;

    // Only act when new files are added
    if (newCount <= prevCount) return;

    const newest = pendingFiles[pendingFiles.length - 1];
    if (!newest) return;

    if (config.watcherNotify) {
      sendNotification("New receipt", newest.filename);
    }

    if (config.watcherFocusApp) {
      focusWindow();
    }
  }, [pendingFiles, config.watcherNotify, config.watcherFocusApp]);
}

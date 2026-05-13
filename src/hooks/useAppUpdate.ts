import { useEffect, useState, useCallback } from "react";

/** Auto-update integration via `tauri-plugin-updater`.
 *
 *  Call this hook ONCE at the app root (App.tsx) so the boot-time check
 *  fires when the app launches, not when a particular screen mounts.
 *  Pass the returned state down to wherever the UI needs to render it.
 *
 *  Failure-mode UX: auto-checks (on mount) that fail are logged to the
 *  console but NOT surfaced as an error in the UI — there's no actionable
 *  user fix for "GitHub returned 404 because no manifest is published"
 *  or "user is offline." Manual checks (`check()` called from a button)
 *  DO surface their errors so the user knows their click did something.
 *
 *  Security: all signature work happens in the Tauri plugin. It verifies
 *  the manifest signature against the bundled public key before any
 *  download, and `downloadAndInstall` won't apply an unauth'd update.
 *  The frontend only orchestrates the UX.
 */
export interface UpdateInfo {
  version: string;
  notes?: string;
}

export function useAppUpdate() {
  const [available, setAvailable] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Shared check logic. `surfaceErrors` controls whether failures land
   *  in the UI — true for user-initiated checks (manual retry), false
   *  for the silent on-mount check. */
  const runCheck = useCallback(async (surfaceErrors: boolean): Promise<UpdateInfo | null> => {
    if (surfaceErrors) setError(null);
    setChecking(true);
    try {
      const { check: updaterCheck } = await import("@tauri-apps/plugin-updater");
      const update = await updaterCheck();
      if (update?.available) {
        const info: UpdateInfo = {
          version: update.version ?? "unknown",
          notes: update.body ?? undefined,
        };
        setAvailable(info);
        return info;
      }
      setAvailable(null);
      return null;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // Not-in-Tauri-context (dev mode) is never an error to surface.
      const isDevModeNotImplemented = msg.toLowerCase().includes("not implemented");
      if (surfaceErrors && !isDevModeNotImplemented) {
        setError(msg);
      } else {
        // Log to console so a debugging user can see what happened,
        // but don't show a scary message in the UI.
        console.debug("[updater] check failed silently:", msg);
      }
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  /** User-initiated check (Settings button). Surfaces errors in the UI. */
  const check = useCallback(() => runCheck(true), [runCheck]);

  const installAndRestart = useCallback(async () => {
    setError(null);
    setInstalling(true);
    try {
      const { check: updaterCheck } = await import("@tauri-apps/plugin-updater");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      const update = await updaterCheck();
      if (!update?.available) {
        setAvailable(null);
        return;
      }
      await update.downloadAndInstall();
      await relaunch();
    } catch (err: any) {
      setError(err?.message ?? "Update failed");
    } finally {
      setInstalling(false);
    }
  }, []);

  // Boot-time check, silent on failure. Fires once when this hook mounts.
  // Mount this hook in App.tsx so this runs at app launch.
  useEffect(() => {
    void runCheck(false);
  }, [runCheck]);

  return { available, checking, installing, error, check, installAndRestart };
}

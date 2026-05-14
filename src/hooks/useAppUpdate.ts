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
      const lower = msg.toLowerCase();
      // Not-in-Tauri-context (dev mode) is never an error to surface.
      if (lower.includes("not implemented")) {
        console.debug("[updater] not in Tauri context");
        return null;
      }
      // 404 / no-manifest case: a missing latest.json means the publisher
      // hasn't cut a release yet. To the user this is identical to "you're
      // up to date" — no version newer than what you have exists. Don't
      // surface as an error.
      const isNoManifest = ["release json", "404", "not found", "could not fetch"].some((s) => lower.includes(s));
      if (isNoManifest) {
        setAvailable(null);
        return null;
      }
      // Network-class errors are recoverable on the user's side (turn on
      // wifi, reconnect, try again). Distinguish from real failures so
      // the UI message can be reassuring instead of alarming.
      const isUnreachable = ["connect", "timeout", "dns", "network", "fetch failed", "send request"].some((s) => lower.includes(s));
      if (surfaceErrors) {
        setError(isUnreachable ? "Couldn't reach update server" : "Update check failed");
      } else {
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

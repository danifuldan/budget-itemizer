import { useEffect, useState, useCallback } from "react";

/** Auto-update integration via `tauri-plugin-updater`.
 *
 *  Call this hook ONCE at the app root (App.tsx) so the boot-time check
 *  fires when the app launches, not when a particular screen mounts.
 *
 *  Observability (added 0.3.2): every check records a TRUTHFUL, distinct
 *  `lastCheck` outcome, persisted to localStorage so it survives relaunch
 *  and is diagnosable without a terminal. The old code mapped
 *  "could not fetch" / 404 / "not found" to the SAME observable state as
 *  a successful "you're on the latest" — a broken auto-update was
 *  indistinguishable from success. It no longer is: "up-to-date" means
 *  the server was reached and reported nothing newer; every failure mode
 *  is its own outcome.
 *
 *  Security: all signature work happens in the Tauri plugin. It verifies
 *  the manifest signature against the bundled public key before any
 *  download, and `downloadAndInstall` won't apply an unauth'd update.
 */
export interface UpdateInfo {
  version: string;
  notes?: string;
}

export type UpdateOutcome =
  | "up-to-date" // server reached, no newer version
  | "available" // a newer version exists
  | "no-manifest" // server reached but no/!parseable release manifest (no release cut, or a fetch/parse failure)
  | "unreachable" // network-class failure (offline, DNS, timeout)
  | "error"; // anything else

export interface LastCheck {
  at: number; // epoch ms
  outcome: UpdateOutcome;
  detail?: string; // raw error message (for diagnosis)
  version?: string; // set when outcome === "available"
}

export const STORAGE_KEY = "bi.updater.lastCheck";

/** Pure: outcome for a (possibly absent) updater result. A reachable
 *  check that reports nothing newer is the ONLY "up-to-date". */
export function outcomeForCheck(
  update: { available?: boolean; version?: string } | null | undefined,
): { outcome: UpdateOutcome; version?: string } {
  if (update?.available) return { outcome: "available", version: update.version ?? "unknown" };
  return { outcome: "up-to-date" };
}

export function loadPersisted(): LastCheck | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && typeof v.at === "number" && typeof v.outcome === "string") return v as LastCheck;
  } catch {
    /* corrupt / unavailable — treat as no prior check */
  }
  return null;
}

export function persist(lc: LastCheck): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lc));
  } catch {
    /* storage full / unavailable — non-fatal, in-memory state still set */
  }
}

export function classifyError(message: string): { outcome: Exclude<UpdateOutcome, "up-to-date" | "available">; surface: boolean } {
  const m = message.toLowerCase();
  // No published manifest, or a fetch/parse failure that yields one.
  // Distinct from up-to-date so a broken check is never invisible.
  if (["release json", "404", "not found", "could not fetch"].some((s) => m.includes(s))) {
    return { outcome: "no-manifest", surface: false };
  }
  // Recoverable on the user's side (turn on wifi, reconnect).
  if (["connect", "timeout", "dns", "network", "fetch failed", "send request"].some((s) => m.includes(s))) {
    return { outcome: "unreachable", surface: true };
  }
  return { outcome: "error", surface: true };
}

export function useAppUpdate() {
  const [available, setAvailable] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rehydrate synchronously so a fresh mount shows the prior outcome
  // before the boot check resolves (and even if it never does).
  const [lastCheck, setLastCheck] = useState<LastCheck | null>(loadPersisted);

  const record = useCallback((lc: LastCheck) => {
    setLastCheck(lc);
    persist(lc);
  }, []);

  const runCheck = useCallback(
    async (surfaceErrors: boolean): Promise<UpdateInfo | null> => {
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
          record({ at: Date.now(), outcome: "available", version: info.version });
          return info;
        }
        setAvailable(null);
        record({ at: Date.now(), outcome: "up-to-date" });
        return null;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        // Not-in-Tauri-context (dev mode in a browser) is not a real
        // check — don't record a misleading outcome.
        if (msg.toLowerCase().includes("not implemented")) {
          console.debug("[updater] not in Tauri context");
          return null;
        }
        const { outcome, surface } = classifyError(msg);
        record({ at: Date.now(), outcome, detail: msg });
        if (surfaceErrors && surface) {
          setError(outcome === "unreachable" ? "Couldn't reach update server" : "Update check failed");
        } else {
          console.debug(`[updater] ${outcome}:`, msg);
        }
        return null;
      } finally {
        setChecking(false);
      }
    },
    [record],
  );

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

  // Boot-time check, silent on failure (no scary banner). Still records
  // lastCheck so the outcome is always diagnosable.
  useEffect(() => {
    void runCheck(false);
  }, [runCheck]);

  return { available, checking, installing, error, lastCheck, check, installAndRestart };
}

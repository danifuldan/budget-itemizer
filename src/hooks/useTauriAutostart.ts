let isTauri = false;
let autostartModule: typeof import("@tauri-apps/plugin-autostart") | null = null;

const initTauri = (async () => {
  try {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      autostartModule = await import("@tauri-apps/plugin-autostart");
      isTauri = true;
    }
  } catch {
    // not in Tauri — fine
  }
})();

export async function getAutostart(): Promise<boolean> {
  await initTauri;
  if (!isTauri || !autostartModule) return false;
  try {
    return await autostartModule.isEnabled();
  } catch {
    return false;
  }
}

export async function setAutostart(enabled: boolean): Promise<void> {
  await initTauri;
  if (!isTauri || !autostartModule) return;
  try {
    if (enabled) {
      await autostartModule.enable();
    } else {
      await autostartModule.disable();
    }
  } catch {
    // silently ignore
  }
}

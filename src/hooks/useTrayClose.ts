import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ConfigData } from "./useConfig";

export function useTrayClose(config: ConfigData) {
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;

    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const appWindow = getCurrentWindow();
        unlisten = await appWindow.onCloseRequested(async (event) => {
          if (configRef.current.minimizeToTray) {
            event.preventDefault();
            await appWindow.hide();
          }
        });
      } catch {
        // not in Tauri — fine
      }
    })();

    return () => {
      unlisten?.();
    };
  }, []);
}

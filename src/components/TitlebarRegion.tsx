import type { ReactNode } from "react";
import { usePlatform } from "../hooks/usePlatform";
import WindowControls from "./WindowControls";

interface TitlebarRegionProps {
  children?: ReactNode;
}

/**
 * Shared drag-region wrapper for the top of every view.
 * - macOS: 70px left spacer for native traffic lights, content pushed right
 * - Windows/Linux: custom WindowControls on the right
 * - data-tauri-drag-region enables window dragging
 */
export default function TitlebarRegion({ children }: TitlebarRegionProps) {
  const platform = usePlatform();
  const isMac = platform === "macos";

  return (
    <div
      className={`titlebar-region ${isMac ? "titlebar-mac" : "titlebar-win"}`}
      data-tauri-drag-region
    >
      {isMac && <div className="titlebar-traffic-light-spacer" data-tauri-drag-region />}
      <div className="titlebar-content" data-tauri-drag-region>
        {children}
      </div>
      {!isMac && <WindowControls />}
    </div>
  );
}

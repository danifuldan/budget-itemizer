/** Synchronous platform detection — no async, no flash of wrong UI. */
export type Platform = "macos" | "windows" | "linux";

export function usePlatform(): Platform {
  const p = navigator.platform.toLowerCase();
  if (p.includes("mac")) return "macos";
  if (p.includes("win")) return "windows";
  return "linux";
}

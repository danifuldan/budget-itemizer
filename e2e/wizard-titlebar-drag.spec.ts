/**
 * Regression: the Setup Wizard ("Welcome") window must be draggable. Its title
 * bar (the only real drag region, data-tauri-drag-region) has to sit FLUSH at
 * the top of the window like every other view. It regressed once when .wizard
 * padding pushed the bar 32px down, leaving the top strip on the dead
 * -webkit-app-region path (no macOSPrivateApi) — so the Welcome screen couldn't
 * be dragged at all.
 *
 * Measures geometry (native window dragging itself isn't testable via the DOM).
 */
import { test, expect } from "@playwright/test";
import { mockBackend } from "./helpers";

test("wizard: title bar is a flush, full-width drag region at the top", async ({ page }) => {
  await mockBackend(page); // default state → Setup Wizard is shown
  await page.goto("/");
  await page.waitForSelector(".wizard", { timeout: 10_000 });

  const geo = await page.evaluate(() => {
    const tb = document.querySelector(".titlebar-region") as HTMLElement | null;
    const rect = tb?.getBoundingClientRect();
    const midX = Math.round(window.innerWidth / 2);
    const topEl = document.elementFromPoint(midX, 5) as HTMLElement | null;
    return {
      x: rect ? Math.round(rect.x) : null,
      y: rect ? Math.round(rect.y) : null,
      w: rect ? Math.round(rect.width) : null,
      winW: window.innerWidth,
      hasDragAttr: tb?.hasAttribute("data-tauri-drag-region") ?? false,
      topStripInDrag: !!topEl?.closest("[data-tauri-drag-region]"),
    };
  });

  // Flush at the very top, spanning the full window width.
  expect(geo.y).toBe(0);
  expect(geo.x).toBe(0);
  expect(geo.w).toBe(geo.winW);
  expect(geo.hasDragAttr).toBe(true);
  // The strip you actually grab (top of the window) is a real drag region.
  expect(geo.topStripInDrag).toBe(true);
});

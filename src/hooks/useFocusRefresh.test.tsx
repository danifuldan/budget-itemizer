// @vitest-environment happy-dom
// Phase 5: returning to the app should resync the account list, but a
// user alt-tabbing rapidly must not spam YNAB. useFocusRefresh calls
// `refresh` on window focus / tab-visible — but at most once per
// throttle window. Mount time counts as the last refresh (the mount
// fetch just ran), so an immediate refocus inside the window is a no-op.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFocusRefresh } from "./useFocusRefresh";

describe("useFocusRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT refresh on a focus inside the throttle window after mount", () => {
    const refresh = vi.fn();
    renderHook(() => useFocusRefresh(refresh, 30_000));

    vi.setSystemTime(new Date("2026-05-18T00:00:20Z")); // +20s, < 30s
    window.dispatchEvent(new Event("focus"));

    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes on a focus after the throttle window elapsed", () => {
    const refresh = vi.fn();
    renderHook(() => useFocusRefresh(refresh, 30_000));

    vi.setSystemTime(new Date("2026-05-18T00:00:31Z")); // +31s, > 30s
    window.dispatchEvent(new Event("focus"));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("throttles a rapid second focus after a refresh", () => {
    const refresh = vi.fn();
    renderHook(() => useFocusRefresh(refresh, 30_000));

    vi.setSystemTime(new Date("2026-05-18T00:00:31Z"));
    window.dispatchEvent(new Event("focus")); // fires (count 1)

    vi.setSystemTime(new Date("2026-05-18T00:00:45Z")); // +14s since last refresh
    window.dispatchEvent(new Event("focus")); // suppressed

    expect(refresh).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-05-18T00:01:05Z")); // +34s since last refresh
    window.dispatchEvent(new Event("focus")); // fires (count 2)

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("also responds to document visibilitychange → visible", () => {
    const refresh = vi.fn();
    renderHook(() => useFocusRefresh(refresh, 30_000));

    vi.setSystemTime(new Date("2026-05-18T00:00:40Z"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops listening after unmount", () => {
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useFocusRefresh(refresh, 30_000));
    unmount();

    vi.setSystemTime(new Date("2026-05-18T00:01:00Z"));
    window.dispatchEvent(new Event("focus"));

    expect(refresh).not.toHaveBeenCalled();
  });
});

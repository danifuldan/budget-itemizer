import { describe, it, expect, vi } from "vitest";
import { watcherReconcileDecision, reconcileTick } from "./watcher";

// (b) recovery: a reachability heartbeat must re-arm fs.watch + rescan
// ONLY on the unreachable→reachable transition (drive came back).
// The disagreement that matters:
//  - false→true  → re-arm (else "Watching" is a lie: handle is dead)
//  - true →true  → do NOT re-arm (re-creating fs.watch + re-running
//                   processInbox every tick = churn + duplicate enqueue)
//  - true →false → do NOT re-arm (disconnect; status layer shows the
//                   truth, there's nothing to watch)
//  - false→false → do NOT re-arm (still gone)
describe("watcherReconcileDecision", () => {
  it("re-arms on unreachable → reachable (drive reconnected)", () => {
    expect(watcherReconcileDecision(false, true)).toEqual({ rearm: true });
  });

  it("does NOT re-arm while continuously reachable (no churn / no double-enqueue)", () => {
    expect(watcherReconcileDecision(true, true)).toEqual({ rearm: false });
  });

  it("does NOT re-arm on reachable → unreachable (disconnect)", () => {
    expect(watcherReconcileDecision(true, false)).toEqual({ rearm: false });
  });

  it("does NOT re-arm while continuously unreachable", () => {
    expect(watcherReconcileDecision(false, false)).toEqual({ rearm: false });
  });
});

// Premortem Bug 1: the heartbeat must latch "reachable" ONLY after a
// successful re-arm. The old code set lastInboxExists = now before
// attempting armWatch, so a single transient re-arm failure (flapping
// mount) consumed the false→true transition forever → permanent
// false-green with no retry.
describe("reconcileTick (latch only on a successful re-arm)", () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    exists: vi.fn(() => true),
    closeWatch: vi.fn(),
    armWatch: vi.fn(),
    rescan: vi.fn(),
    ...over,
  });

  it("unreachable→reachable, re-arm SUCCEEDS → latches reachable + rescans", () => {
    const d = deps();
    const r = reconcileTick(false, "/inbox", d);
    expect(d.closeWatch).toHaveBeenCalled();
    expect(d.armWatch).toHaveBeenCalledWith("/inbox");
    expect(d.rescan).toHaveBeenCalledWith("/inbox");
    expect(r).toEqual({ nextExists: true });
  });

  it("unreachable→reachable, re-arm THROWS → does NOT latch (retries next tick)", () => {
    const d = deps({
      armWatch: vi.fn(() => {
        throw new Error("EPERM: mount not ready");
      }),
    });
    const r = reconcileTick(false, "/inbox", d);
    expect(d.armWatch).toHaveBeenCalled();
    expect(d.rescan).not.toHaveBeenCalled();
    expect(r).toEqual({ nextExists: false });
  });

  it("continuously reachable → no churn (no close/arm/rescan)", () => {
    const d = deps();
    const r = reconcileTick(true, "/inbox", d);
    expect(d.closeWatch).not.toHaveBeenCalled();
    expect(d.armWatch).not.toHaveBeenCalled();
    expect(d.rescan).not.toHaveBeenCalled();
    expect(r).toEqual({ nextExists: true });
  });

  it("reachable→unreachable → no re-arm, reports unreachable", () => {
    const d = deps({ exists: vi.fn(() => false) });
    const r = reconcileTick(true, "/inbox", d);
    expect(d.armWatch).not.toHaveBeenCalled();
    expect(r).toEqual({ nextExists: false });
  });

  it("empty inbox path → unreachable, exists() not even probed", () => {
    const d = deps();
    const r = reconcileTick(false, "", d);
    expect(d.exists).not.toHaveBeenCalled();
    expect(d.armWatch).not.toHaveBeenCalled();
    expect(r).toEqual({ nextExists: false });
  });
});

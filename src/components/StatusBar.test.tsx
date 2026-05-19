import { describe, it, expect } from "vitest";
import { watcherStatusView } from "./StatusBar";

// Bug (runtime-unplug twin of the boot false-status): `running` is
// derived purely from "fs.watch handle exists & never closed", not from
// "inbox reachable now". Eject the drive after a good start and /status
// reports running:true, inboxExists:false — StatusBar showed green
// "Watching…" forever because its only watcher state was keyed on
// !running. The disagreement: running && !inboxExists must NOT read as
// green/Watching; the inboxExists signal is already plumbed in.
describe("watcherStatusView", () => {
  it("running + inbox reachable → green Watching <path>", () => {
    const v = watcherStatusView({ setupComplete: true, running: true, inboxExists: true, path: "/Receipts/inbox" });
    expect(v.dot).toBe("green");
    expect(v.label).toBe("Watching /Receipts/inbox");
    expect(v.kind).toBe("watching");
  });

  it("running but inbox UNREACHABLE (drive unplugged) → NOT green, alerts unreachable", () => {
    const v = watcherStatusView({ setupComplete: true, running: true, inboxExists: false, path: "/Volumes/SSD/inbox" });
    expect(v.dot).not.toBe("green");
    expect(v.kind).toBe("alert");
    expect(v.label.toLowerCase()).toContain("unreachable");
    expect(v.label.toLowerCase()).not.toContain("watching");
  });

  it("setup done, watcher not running, path missing → red not-found", () => {
    const v = watcherStatusView({ setupComplete: true, running: false, inboxExists: false, path: "" });
    expect(v.dot).toBe("red");
    expect(v.kind).toBe("alert");
    expect(v.label).toBe("Inbox folder not found — check Settings");
  });

  it("setup not complete, not running → neutral idle (no dot)", () => {
    const v = watcherStatusView({ setupComplete: false, running: false, inboxExists: false, path: "" });
    expect(v.dot).toBeNull();
    expect(v.kind).toBe("idle");
    expect(v.label).toBe("Watcher idle");
  });
});

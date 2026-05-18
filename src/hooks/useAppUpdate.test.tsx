// @vitest-environment happy-dom
// The bug this locks down: the updater hook mapped "could not fetch" /
// 404 / "not found" errors to the SAME observable state as a successful
// "you're on the latest version" — no error, nothing persisted. A
// broken auto-update was indistinguishable from success. The policy is
// now pure + exported so it's deterministically testable without the
// Tauri runtime; the hook is thin glue over these.
import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyError,
  outcomeForCheck,
  persist,
  loadPersisted,
  STORAGE_KEY,
  type LastCheck,
} from "./useAppUpdate";

beforeEach(() => localStorage.clear());

describe("classifyError", () => {
  // The disagreement: a fetch/parse failure must NOT be up-to-date.
  it("a 'could not fetch release JSON' failure → 'no-manifest', never up-to-date", () => {
    const r = classifyError("Could not fetch a valid release JSON from the remote");
    expect(r.outcome).toBe("no-manifest");
    expect(r.outcome).not.toBe("up-to-date");
  });

  it("404 / not found → 'no-manifest'", () => {
    expect(classifyError("server returned 404 Not Found").outcome).toBe("no-manifest");
  });

  it("network-class failures → 'unreachable' and are surfaced", () => {
    for (const m of [
      "error sending request for url: dns error",
      "connection timed out",
      "network is unreachable",
      "fetch failed",
    ]) {
      const r = classifyError(m);
      expect(r.outcome).toBe("unreachable");
      expect(r.surface).toBe(true);
    }
  });

  it("anything else → 'error' and is surfaced", () => {
    const r = classifyError("signature verification failed");
    expect(r.outcome).toBe("error");
    expect(r.surface).toBe(true);
  });

  it("no-manifest is NOT surfaced as an alarming banner (but is still recorded)", () => {
    expect(classifyError("could not fetch").surface).toBe(false);
  });
});

describe("outcomeForCheck", () => {
  it("a reachable check reporting nothing newer is the ONLY up-to-date", () => {
    expect(outcomeForCheck({ available: false }).outcome).toBe("up-to-date");
    expect(outcomeForCheck(null).outcome).toBe("up-to-date");
    expect(outcomeForCheck(undefined).outcome).toBe("up-to-date");
  });

  it("an available update carries the version", () => {
    expect(outcomeForCheck({ available: true, version: "0.3.2" })).toEqual({
      outcome: "available",
      version: "0.3.2",
    });
  });
});

describe("persistence (survives relaunch)", () => {
  it("round-trips the last check through localStorage", () => {
    const lc: LastCheck = { at: 1779119048374, outcome: "no-manifest", detail: "could not fetch" };
    persist(lc);
    expect(loadPersisted()).toEqual(lc);
  });

  it("no prior check → null", () => {
    expect(loadPersisted()).toBeNull();
  });

  it("corrupt storage → null, not a throw", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadPersisted()).toBeNull();
  });
});

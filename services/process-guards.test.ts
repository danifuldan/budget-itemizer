import { describe, it, expect, vi } from "vitest";
import { makeRejectionHandler, installProcessGuards } from "./process-guards";

// Regression guard for the 2026-05-29 crash: pointing the app at an Actual
// Sync ID that doesn't exist on the server made @actual-app/api's detached
// _fullSync reject OFF the awaited chain. With no process-level handler, Node
// promoted it to a fatal uncaughtException and the whole sidecar exited (code
// 1) — killing the LLM, watcher, and every endpoint because the app was merely
// pointed at a missing budget. The fix is a process guard that logs and keeps
// the sidecar alive; the UI still shows the clean "check your Sync ID" 500.
describe("process guards (Actual bad-syncId crash safety net)", () => {
  it("logs the rejection reason and never rethrows", () => {
    const logger = { error: vi.fn() };
    const handler = makeRejectionHandler(logger);
    expect(() => handler(new Error("PostError: file-not-found"))).not.toThrow();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(String(logger.error.mock.calls[0]?.[0] ?? "")).toContain("file-not-found");
  });

  it("registers an unhandledRejection listener (so Node won't fatally promote a detached rejection)", () => {
    const before = process.listenerCount("unhandledRejection");
    const uninstall = installProcessGuards({ error: vi.fn() });
    try {
      expect(process.listenerCount("unhandledRejection")).toBe(before + 1);
    } finally {
      uninstall();
    }
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});

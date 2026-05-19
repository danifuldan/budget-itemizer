// The index.ts boot wiring used to gate startWatcher() behind
// `await llmReady`, so the watcher didn't run during model warmup —
// producing a false "Inbox folder not found" status and no pending
// entry for receipts dropped while loading. The queue consumer
// (queueFile) ALREADY waits for llama-server, so the watcher start has
// no real LLM dependency. startWatcherOnBoot makes that explicit: it
// takes no LLM signal at all, so it structurally cannot be gated on it.
import { describe, it, expect, vi } from "vitest";
import { startWatcherOnBoot, type WatcherStatus } from "./watcher";

const running: WatcherStatus = {
  running: true,
  inboxPath: "/inbox",
  processedPath: "/processed",
  inboxExists: true,
};

describe("startWatcherOnBoot", () => {
  it("starts the watcher when setup is complete and the watcher is enabled — with no LLM signal in scope", () => {
    const startWatcher = vi.fn<() => WatcherStatus>(() => running);
    const status = startWatcherOnBoot({
      isSetupComplete: () => true,
      getConfig: () => ({ watcherEnabled: true }) as any,
      startWatcher,
    });
    expect(startWatcher).toHaveBeenCalledOnce();
    expect(status).toEqual(running);
  });

  it("does not start the watcher when setup is incomplete", () => {
    const startWatcher = vi.fn<() => WatcherStatus>(() => running);
    const status = startWatcherOnBoot({
      isSetupComplete: () => false,
      getConfig: () => ({ watcherEnabled: true }) as any,
      startWatcher,
    });
    expect(startWatcher).not.toHaveBeenCalled();
    expect(status).toBeNull();
  });

  it("does not start the watcher when disabled in config", () => {
    const startWatcher = vi.fn<() => WatcherStatus>(() => running);
    startWatcherOnBoot({
      isSetupComplete: () => true,
      getConfig: () => ({ watcherEnabled: false }) as any,
      startWatcher,
    });
    expect(startWatcher).not.toHaveBeenCalled();
  });

  it("does not propagate a startWatcher() throw — unreachable inbox at launch must not crash boot", () => {
    // Premortem Bug 1: startWatcher() runs ensureDirs()/processInbox()
    // BEFORE its own fs.watch try/catch, so an unreachable inbox
    // (unplugged drive at launch) throws. startWatcherOnBoot runs on the
    // serve-bind path immediately before runStartupAccountMigration; an
    // escaped throw rejects the bind callback and skips the migration.
    // Must fail closed (return null) — same never-throws-at-boot contract
    // runStartupAccountMigration already has.
    const startWatcher = vi.fn<() => WatcherStatus>(() => {
      throw new Error("ENOENT: ensureDirs failed (inbox on unplugged volume)");
    });
    let status: WatcherStatus | null = running;
    expect(() => {
      status = startWatcherOnBoot({
        isSetupComplete: () => true,
        getConfig: () => ({ watcherEnabled: true }) as any,
        startWatcher,
      });
    }).not.toThrow();
    expect(status).toBeNull();
  });
});

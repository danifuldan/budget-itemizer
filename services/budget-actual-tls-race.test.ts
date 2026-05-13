// Regression test for TLS handling in services/budget-actual.ts.
// The original implementation set NODE_TLS_REJECT_UNAUTHORIZED process-wide
// during init, with a save/restore that could interleave between two
// concurrent callers and permanently leave it "0". The current
// implementation uses a per-host undici dispatcher swap. This test verifies
// (a) the env var is never touched and (b) the global dispatcher is
// restored after init settles — under two concurrent callers, the
// singleton init promise must serialize so the dispatcher swap-back
// runs exactly once.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getGlobalDispatcher } from "undici";

vi.mock("./config", () => ({
  getConfig: vi.fn(() => ({
    actualServerUrl: "https://actual.local",
    actualPassword: "pw",
  })),
}));

// The Actual API takes time to init; that delay is the window where the race
// happens. We mock a 50ms init so the test can race two concurrent callers.
const initSpy = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 50));
});
vi.mock("@actual-app/api", () => ({
  init: initSpy,
  default: { init: initSpy },
}));

describe("budget-actual ensureServer", () => {
  let originalTlsReject: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    initSpy.mockClear();
    originalTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  });

  afterEach(() => {
    if (originalTlsReject === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsReject;
    }
  });

  it("two concurrent first-init calls don't leak TLS relaxation after settle", async () => {
    const originalDispatcher = getGlobalDispatcher();
    const mod = await import("./budget-actual");
    const provider = new mod.ActualBudgetProvider();

    // Race two callers. Without the singleton lock, the dispatcher swap
    // and swap-back interleave and the scoped dispatcher leaks past init.
    await Promise.all([
      provider.getAllBudgets().catch(() => {}),
      provider.getAllBudgets().catch(() => {}),
    ]);

    // Env var was never touched by the new implementation.
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    // Global dispatcher restored to what we started with.
    expect(getGlobalDispatcher()).toBe(originalDispatcher);
    // api.init should only have been called once across both attempts.
    expect(initSpy).toHaveBeenCalledTimes(1);
  });
});

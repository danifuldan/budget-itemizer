// TLS-handling tests for services/budget-actual.ts.
//
// The original implementation set NODE_TLS_REJECT_UNAUTHORIZED process-wide
// during init (a save/restore that could interleave between concurrent
// callers and leak "0"). That was replaced with a per-host undici
// dispatcher swap. A later bug: the swap was restored *immediately after
// init*, so every post-login call (list-user-files, /sync, accounts) ran
// with strict TLS and silently failed against a self-signed or
// hostname-mismatched cert — the budget list came back empty. The fix
// keeps the scoped dispatcher installed for the whole session and restores
// it on shutdown(). These tests pin: (a) env var never touched, (b) the
// singleton init lock, (c) scoped dispatcher persists until shutdown, and
// (d) the scoping only relaxes TLS for the Actual origin.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

vi.mock("./config", () => ({
  getConfig: vi.fn(() => ({
    actualServerUrl: "https://actual.local",
    actualPassword: "pw",
  })),
}));

// The Actual API takes time to init; that delay is the window where the race
// happens. Mock a 50ms init so the test can race two concurrent callers.
const initSpy = vi.fn(async () => {
  await new Promise((r) => setTimeout(r, 50));
});
const apiMock = {
  init: initSpy,
  getBudgets: vi.fn(async () => []),
  shutdown: vi.fn(async () => {}),
};
vi.mock("@actual-app/api", () => ({ ...apiMock, default: apiMock }));

const FILE_ORIGINAL_DISPATCHER = getGlobalDispatcher();

describe("budget-actual TLS dispatcher scoping", () => {
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
    // Safety: never let a scoped dispatcher leak between tests.
    setGlobalDispatcher(FILE_ORIGINAL_DISPATCHER);
  });

  it("inits once across concurrent callers, never touches the env var, keeps the scoped dispatcher until shutdown", async () => {
    const originalDispatcher = getGlobalDispatcher();
    const mod = await import("./budget-actual");
    const provider = new mod.ActualBudgetProvider();

    // Race two callers. The singleton lock must serialize them.
    await Promise.all([
      provider.getAllBudgets().catch(() => {}),
      provider.getAllBudgets().catch(() => {}),
    ]);

    // Env var was never touched by the dispatcher-based implementation.
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    // Singleton lock: init ran exactly once across both callers.
    expect(initSpy).toHaveBeenCalledTimes(1);
    // THE FIX: scoped dispatcher stays installed after init (so post-login
    // calls reach the self-signed origin). The old code restored strict TLS
    // here, which is exactly what broke list-user-files → empty budgets.
    expect(getGlobalDispatcher()).not.toBe(originalDispatcher);

    // Disconnect restores strict TLS.
    await provider.shutdown();
    expect(getGlobalDispatcher()).toBe(originalDispatcher);
  });

  it("relaxes TLS ONLY for the Actual origin; every other host keeps full validation", async () => {
    const mod = await import("./budget-actual");
    const insecure = { dispatch: vi.fn(() => true), close: vi.fn(), destroy: vi.fn() };
    const fallback = { dispatch: vi.fn(() => true), close: vi.fn(), destroy: vi.fn() };
    const scoped = mod.makeScopedDispatcher(
      "https://actual.local",
      insecure as never,
      fallback as never,
    );
    const handler = {} as never;

    // Request to the user's Actual origin → insecure agent (self-signed OK).
    scoped.dispatch({ origin: "https://actual.local", path: "/list-user-files" } as never, handler);
    expect(insecure.dispatch).toHaveBeenCalledTimes(1);
    expect(fallback.dispatch).not.toHaveBeenCalled();

    // Any other origin (e.g. YNAB) → fallback dispatcher = full cert +
    // hostname validation. This is the security invariant the swap-back
    // used to provide; the scoped router provides it without breaking the
    // Actual calls.
    scoped.dispatch({ origin: "https://api.ynab.com", path: "/v1/budgets" } as never, handler);
    expect(fallback.dispatch).toHaveBeenCalledTimes(1);
    expect(insecure.dispatch).toHaveBeenCalledTimes(1); // still just the one
  });
});

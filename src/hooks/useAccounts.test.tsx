// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("./useRetryableFetch", () => ({
  useRetryableFetch: vi.fn(() => ({ data: [], refresh: vi.fn(), loading: false })),
}));
import { useRetryableFetch } from "./useRetryableFetch";
import { useAccounts } from "./useAccounts";

const mock = vi.mocked(useRetryableFetch);

describe("useAccounts", () => {
  beforeEach(() => mock.mockClear());

  // Opt-in escape hatch for callers that must target a SPECIFIC provider
  // regardless of the server's config-active flag. The main view uses the bare
  // form below (server config-active is authoritative); this param exists for
  // provider-explicit callers in the same class as the Settings loader.
  it("fetches the given provider's accounts explicitly", () => {
    renderHook(() => useAccounts(true, "actual"));
    expect(mock).toHaveBeenCalledWith("/accounts?provider=actual", [], { enabled: true });
  });

  it("still works with no provider (falls back to bare /accounts)", () => {
    renderHook(() => useAccounts(true));
    expect(mock).toHaveBeenCalledWith("/accounts", [], { enabled: true });
  });
});

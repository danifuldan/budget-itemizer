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

  // Same class as the Settings loader bug: the main-view import dropdown must
  // read a SPECIFIC provider's accounts, not rely on the server guessing its
  // config-active flag.
  it("fetches the given provider's accounts explicitly", () => {
    renderHook(() => useAccounts(true, "actual"));
    expect(mock).toHaveBeenCalledWith("/accounts?provider=actual", [], { enabled: true });
  });

  it("still works with no provider (falls back to bare /accounts)", () => {
    renderHook(() => useAccounts(true));
    expect(mock).toHaveBeenCalledWith("/accounts", [], { enabled: true });
  });
});

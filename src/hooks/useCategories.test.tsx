// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("./useRetryableFetch", () => ({
  useRetryableFetch: vi.fn(() => ({ data: [], refresh: vi.fn(), loading: false })),
}));
import { useRetryableFetch } from "./useRetryableFetch";
import { useCategories } from "./useCategories";

const mock = vi.mocked(useRetryableFetch);

describe("useCategories", () => {
  beforeEach(() => mock.mockClear());

  // Categories are provider-specific (YNAB categories vs Actual envelopes);
  // same class as the account reads — state the provider, don't let the server
  // guess its config-active flag.
  it("fetches the given provider's categories explicitly", () => {
    renderHook(() => useCategories(true, "actual"));
    expect(mock).toHaveBeenCalledWith("/categories?provider=actual", [], { enabled: true });
  });

  it("still works with no provider (falls back to bare /categories)", () => {
    renderHook(() => useCategories(true));
    expect(mock).toHaveBeenCalledWith("/categories", [], { enabled: true });
  });
});

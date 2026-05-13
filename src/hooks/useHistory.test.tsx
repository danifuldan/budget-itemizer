// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHistory } from "./useHistory";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  apiDelete: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: string, public retryAfterSeconds: number | null) {
      super(`API ${status}: ${body}`);
    }
  },
}));

import { apiFetch, apiDelete } from "../api/client";
const mockApiFetch = vi.mocked(apiFetch);
const mockApiDelete = vi.mocked(apiDelete);

const flushPromises = () => act(() => Promise.resolve());

const sample = [
  { id: "a", merchant: "X", totalAmount: 1, transactionDate: "2026-01-01" } as any,
  { id: "b", merchant: "Y", totalAmount: 2, transactionDate: "2026-01-02" } as any,
];

describe("useHistory.remove", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiDelete.mockReset();
    mockApiFetch.mockResolvedValue(sample);
  });

  it("optimistically removes a record on success", async () => {
    mockApiDelete.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useHistory());
    await flushPromises();
    expect(result.current.history).toEqual(sample);

    await act(async () => {
      result.current.remove("a");
      await Promise.resolve();
    });

    expect(result.current.history.map(r => r.id)).toEqual(["b"]);
  });

  // Regression: previously, on apiDelete failure, remove() called refresh().
  // Under the consolidated useRetryableFetch, refresh() preserves stale data
  // on persistent failure, so the optimistic delete was never reverted —
  // server still had the row but UI showed it gone.
  it("reverts the optimistic delete when the server delete fails", async () => {
    mockApiDelete.mockRejectedValueOnce(new Error("500"));

    const { result } = renderHook(() => useHistory());
    await flushPromises();
    expect(result.current.history.map(r => r.id)).toEqual(["a", "b"]);

    await act(async () => {
      result.current.remove("a");
      // Wait for the apiDelete rejection AND the .catch handler to fire.
      // Multiple microtask flushes because the state update from the catch
      // is itself queued, plus React state-update flush.
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });

    expect(result.current.history.map(r => r.id)).toEqual(["a", "b"]);
  });
});

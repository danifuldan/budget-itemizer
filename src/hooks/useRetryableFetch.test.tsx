// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRetryableFetch } from "./useRetryableFetch";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: string, public retryAfterSeconds: number | null) {
      super(`API ${status}: ${body}`);
      this.name = "ApiError";
    }
  },
}));

import { apiFetch } from "../api/client";
const mockApiFetch = vi.mocked(apiFetch);

// Resolve queued microtasks (promise .then callbacks) without advancing
// any setTimeout. Necessary because `waitFor` from testing-library polls
// via setInterval, which fake timers freeze.
const flushPromises = () => act(() => Promise.resolve());

describe("useRetryableFetch", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns data and clears loading on first success", async () => {
    mockApiFetch.mockResolvedValueOnce(["a", "b"]);

    const { result } = renderHook(() => useRetryableFetch<string[]>("/things", []));

    expect(result.current.loading).toBe(true);
    expect(result.current.data).toEqual([]);

    await flushPromises();

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual(["a", "b"]);
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it("caps retries at MAX_ATTEMPTS (8) on persistent failure", async () => {
    vi.useFakeTimers();
    mockApiFetch.mockRejectedValue(new Error("boom"));

    renderHook(() => useRetryableFetch<string[]>("/things", []));

    // Backoff schedule is 3s → 6s → 12s → 24s → 48s → 60s (cap) × 3.
    // Total < 4 minutes. Drive past that to ensure no further retries.
    for (let i = 0; i < 30; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    }

    expect(mockApiFetch).toHaveBeenCalledTimes(8);
  });

  // useConfig.save() uses mutate() to apply an optimistic local update
  // without a network round-trip. If mutate didn't trigger a re-render,
  // saved settings would only show after a manual refresh.
  it("mutate() updates returned data immediately for optimistic flows", async () => {
    mockApiFetch.mockResolvedValueOnce({ name: "initial" });

    const { result } = renderHook(() =>
      useRetryableFetch<{ name: string }>("/thing", { name: "" })
    );
    await flushPromises();
    expect(result.current.data).toEqual({ name: "initial" });

    act(() => {
      result.current.mutate((prev) => ({ ...prev, name: "edited" }));
    });

    expect(result.current.data).toEqual({ name: "edited" });
  });

  it("clears the failure state when the next call succeeds", async () => {
    vi.useFakeTimers();
    mockApiFetch
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(["recovered"]);

    const { result } = renderHook(() => useRetryableFetch<string[]>("/things", []));

    // First attempt fails synchronously.
    await act(async () => { await Promise.resolve(); });
    expect(result.current.error).toBeTruthy();

    // Advance past the first retry's 3s backoff.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });

    expect(result.current.data).toEqual(["recovered"]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("polls at intervalMs after each success when configured", async () => {
    vi.useFakeTimers();
    mockApiFetch
      .mockResolvedValueOnce(["first"])
      .mockResolvedValueOnce(["second"])
      .mockResolvedValueOnce(["third"]);

    const { result } = renderHook(() =>
      useRetryableFetch<string[]>("/things", [], { intervalMs: 5_000 }),
    );

    // First success.
    await act(async () => { await Promise.resolve(); });
    expect(result.current.data).toEqual(["first"]);
    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    // Second poll fires at intervalMs.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.data).toEqual(["second"]);
    expect(mockApiFetch).toHaveBeenCalledTimes(2);

    // Third poll fires intervalMs later.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.data).toEqual(["third"]);
    expect(mockApiFetch).toHaveBeenCalledTimes(3);
  });

  it("resumes interval polling after recovering from error backoff", async () => {
    vi.useFakeTimers();
    mockApiFetch
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(["recovered"])
      .mockResolvedValueOnce(["next-tick"]);

    const { result } = renderHook(() =>
      useRetryableFetch<string[]>("/things", [], { intervalMs: 10_000 }),
    );

    // First call fails.
    await act(async () => { await Promise.resolve(); });
    expect(result.current.error).toBeTruthy();

    // Retry fires at 3s backoff and succeeds.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });
    expect(result.current.data).toEqual(["recovered"]);
    expect(result.current.error).toBeNull();
    expect(mockApiFetch).toHaveBeenCalledTimes(2);

    // After recovery the interval schedule takes over — next call fires at
    // intervalMs (10s), not at another backoff. If we were still in the
    // backoff path, the next call would fire at 6s (the 2nd backoff slot).
    // Advance 6s — must NOT fire yet.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(mockApiFetch).toHaveBeenCalledTimes(2);

    // Advance to 10s total since success — interval poll fires.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_500); });
    expect(result.current.data).toEqual(["next-tick"]);
    expect(mockApiFetch).toHaveBeenCalledTimes(3);
  });
});

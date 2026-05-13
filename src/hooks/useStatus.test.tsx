// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStatus } from "./useStatus";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: string, public retryAfterSeconds: number | null) {
      super(`API ${status}: ${body}`);
    }
  },
}));

import { apiFetch } from "../api/client";
const mockApiFetch = vi.mocked(apiFetch);

const flushPromises = () => act(() => Promise.resolve());

describe("useStatus", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Regression test: previously `loaded` was derived from `!loading`, so
  // every poll's brief `loading=true` window flipped `loaded=false`. App.tsx
  // unmounts the wizard on `!loaded`, which reset SetupWizard's `step`
  // useState back to 0 every 3 seconds.
  it("loaded stays true across subsequent polls", async () => {
    mockApiFetch.mockResolvedValue({ setup: false, llmReady: false });
    vi.useFakeTimers();

    const { result } = renderHook(() => useStatus());

    // Initial fetch resolves.
    await flushPromises();
    expect(result.current.loaded).toBe(true);

    // Advance past the 3s fast-poll interval. `refresh` fires and toggles
    // the underlying `loading` flag; `loaded` must NOT regress.
    await act(async () => { await vi.advanceTimersByTimeAsync(3_500); });
    expect(result.current.loaded).toBe(true);

    // Several more polls.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current.loaded).toBe(true);

    expect(mockApiFetch.mock.calls.length).toBeGreaterThan(1);
  });
});

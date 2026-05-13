// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useYnabTest } from "./useYnabTest";

vi.mock("../api/client", () => ({
  apiPost: vi.fn(),
}));

import { apiPost } from "../api/client";
const mockApiPost = vi.mocked(apiPost);

describe("useYnabTest", () => {
  beforeEach(() => {
    mockApiPost.mockReset();
  });

  it("setApiKey updates state", () => {
    const { result } = renderHook(() => useYnabTest());
    expect(result.current.state.apiKey).toBe("");
    act(() => { result.current.setApiKey("foo"); });
    expect(result.current.state.apiKey).toBe("foo");
  });

  it("initialApiKey seeds the field", () => {
    const { result } = renderHook(() => useYnabTest({ initialApiKey: "abc" }));
    expect(result.current.state.apiKey).toBe("abc");
  });

  it("test() POSTs /setup/save then /setup/test-ynab when apiKey is set", async () => {
    mockApiPost
      .mockResolvedValueOnce({}) // /setup/save
      .mockResolvedValueOnce({ success: true, budgets: [{ id: "b1", name: "Main" }] }); // /setup/test-ynab
    const { result } = renderHook(() => useYnabTest({ initialApiKey: "tok" }));

    let testOutcome: any;
    await act(async () => { testOutcome = await result.current.test(); });

    expect(mockApiPost).toHaveBeenNthCalledWith(1, "/setup/save", { ynabApiKey: "tok" });
    expect(mockApiPost).toHaveBeenNthCalledWith(2, "/setup/test-ynab", {});
    expect(testOutcome.success).toBe(true);
    expect(result.current.state.result?.success).toBe(true);
  });

  // Settings clicks Test Connection without re-typing the saved token.
  // Hook must skip /setup/save in that case so it doesn't blank the
  // stored credential.
  it("test() does NOT POST /setup/save when apiKey is empty", async () => {
    mockApiPost.mockResolvedValueOnce({ success: true });
    const { result } = renderHook(() => useYnabTest());

    await act(async () => { await result.current.test(); });

    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith("/setup/test-ynab", {});
  });

  it("test() calls onTested with the result", async () => {
    mockApiPost.mockResolvedValueOnce({ success: true, budgets: [] });
    const onTested = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useYnabTest({ onTested }));

    await act(async () => { await result.current.test(); });

    expect(onTested).toHaveBeenCalledWith({ success: true, budgets: [] });
  });

  it("test() returns 'Could not reach server' on apiPost throw", async () => {
    mockApiPost.mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useYnabTest());

    let testOutcome: any;
    await act(async () => { testOutcome = await result.current.test(); });

    expect(testOutcome).toEqual({ success: false, error: "Could not reach server" });
    expect(result.current.state.result).toEqual({ success: false, error: "Could not reach server" });
  });

  it("toggles `testing` while in flight", async () => {
    let resolveTest: (v: any) => void = () => {};
    mockApiPost.mockReturnValueOnce(new Promise((r) => { resolveTest = r; }));
    const { result } = renderHook(() => useYnabTest());

    let testPromise: Promise<any>;
    act(() => { testPromise = result.current.test(); });
    expect(result.current.state.testing).toBe(true);

    await act(async () => {
      resolveTest({ success: true });
      await testPromise!;
    });
    expect(result.current.state.testing).toBe(false);
  });
});

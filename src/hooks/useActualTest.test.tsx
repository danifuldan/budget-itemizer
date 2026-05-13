// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useActualTest } from "./useActualTest";

vi.mock("../api/client", () => ({
  apiPost: vi.fn(),
}));

import { apiPost } from "../api/client";
const mockApiPost = vi.mocked(apiPost);

describe("useActualTest", () => {
  beforeEach(() => {
    mockApiPost.mockReset();
  });

  it("setServerUrl updates state", () => {
    const { result } = renderHook(() => useActualTest());
    act(() => { result.current.setServerUrl("https://example.com"); });
    expect(result.current.state.serverUrl).toBe("https://example.com");
  });

  it("setPassword sets the value AND flips passwordChanged=true", () => {
    const { result } = renderHook(() => useActualTest({ initialPasswordPlaceholder: "••••" }));
    expect(result.current.state.passwordChanged).toBe(false);

    act(() => { result.current.setPassword("real-password"); });

    expect(result.current.state.password).toBe("real-password");
    expect(result.current.state.passwordChanged).toBe(true);
  });

  // Regression: settings shows "••••" as a placeholder for a saved password.
  // If `actualPasswordChanged` isn't gated, that masked string gets sent
  // back to /config as the new password — bricking the connection.
  it("test() omits actualPassword when passwordChanged is false", async () => {
    mockApiPost
      .mockResolvedValueOnce({}) // /config
      .mockResolvedValueOnce({ success: true, budgets: [] }); // /setup/test-actual
    const { result } = renderHook(() => useActualTest({
      initialServerUrl: "http://localhost:5006",
      initialPasswordPlaceholder: "••••",
    }));

    await act(async () => { await result.current.test(); });

    expect(mockApiPost).toHaveBeenNthCalledWith(1, "/config", { actualServerUrl: "http://localhost:5006" });
  });

  it("test() includes actualPassword when passwordChanged is true", async () => {
    mockApiPost
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ success: true, budgets: [] });
    const { result } = renderHook(() => useActualTest());

    act(() => { result.current.setPassword("hunter2"); });
    await act(async () => { await result.current.test(); });

    expect(mockApiPost).toHaveBeenNthCalledWith(1, "/config", {
      actualServerUrl: "http://localhost:5006",
      actualPassword: "hunter2",
    });
  });

  it("test() sets result and budgets on success", async () => {
    mockApiPost
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ success: true, budgets: [{ id: "b1", name: "Main" }] });
    const { result } = renderHook(() => useActualTest());

    await act(async () => { await result.current.test(); });

    expect(result.current.state.result).toEqual({ success: true });
    expect(result.current.state.budgets).toEqual([{ id: "b1", name: "Main" }]);
  });

  it("test() sets failure result when backend returns success=false", async () => {
    mockApiPost
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ success: false, error: "bad password" });
    const { result } = renderHook(() => useActualTest());

    await act(async () => { await result.current.test(); });

    expect(result.current.state.result).toEqual({ success: false, error: "bad password" });
    expect(result.current.state.budgets).toEqual([]);
  });

  it("test() calls onTested with result and budgets", async () => {
    mockApiPost
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ success: true, budgets: [{ id: "b1", name: "B" }] });
    const onTested = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useActualTest({ onTested }));

    await act(async () => { await result.current.test(); });

    expect(onTested).toHaveBeenCalledWith({ success: true }, [{ id: "b1", name: "B" }]);
  });

  it("test() returns 'Could not reach server' on /setup/test-actual throw", async () => {
    mockApiPost
      .mockResolvedValueOnce({}) // /config ok
      .mockRejectedValueOnce(new Error("net")); // /setup/test-actual throws
    const { result } = renderHook(() => useActualTest());

    await act(async () => { await result.current.test(); });

    expect(result.current.state.result?.success).toBe(false);
    expect(result.current.state.result?.error).toMatch(/net|Could not reach/);
  });
});

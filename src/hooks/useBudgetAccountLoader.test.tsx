// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBudgetAccountLoader } from "./useBudgetAccountLoader";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiFetch, apiPost } from "../api/client";
const mockApiFetch = vi.mocked(apiFetch);
const mockApiPost = vi.mocked(apiPost);

describe("useBudgetAccountLoader", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiPost.mockReset();
  });

  it("selectBudget POSTs /config with the right field name (ynabBudgetId)", async () => {
    mockApiPost.mockResolvedValueOnce({});
    mockApiFetch.mockResolvedValueOnce(["Checking", "Savings"]);

    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "ynabBudgetId" }));
    await act(async () => { await result.current.selectBudget("budget-1"); });

    expect(mockApiPost).toHaveBeenCalledWith("/config", { ynabBudgetId: "budget-1" });
  });

  it("selectBudget POSTs /config with actualSyncId for the Actual provider", async () => {
    mockApiPost.mockResolvedValueOnce({});
    mockApiFetch.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "actualSyncId" }));
    await act(async () => { await result.current.selectBudget("sync-xyz"); });

    expect(mockApiPost).toHaveBeenCalledWith("/config", { actualSyncId: "sync-xyz" });
  });

  it("selectBudget fetches /accounts and auto-selects the first one", async () => {
    mockApiPost.mockResolvedValueOnce({});
    mockApiFetch.mockResolvedValueOnce(["Checking", "Savings"]);

    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "ynabBudgetId" }));
    await act(async () => { await result.current.selectBudget("budget-1"); });

    expect(result.current.state.accounts).toEqual(["Checking", "Savings"]);
    expect(result.current.state.selectedAccount).toBe("Checking");
  });

  it("loadAllAccounts=true triggers a second /accounts?all=true fetch", async () => {
    mockApiPost.mockResolvedValueOnce({});
    mockApiFetch
      .mockResolvedValueOnce(["Checking"])
      .mockResolvedValueOnce(["Checking", "Hidden"]);

    const { result } = renderHook(() => useBudgetAccountLoader({
      budgetIdField: "ynabBudgetId",
      loadAllAccounts: true,
    }));
    await act(async () => { await result.current.selectBudget("budget-1"); });

    expect(mockApiFetch).toHaveBeenNthCalledWith(1, "/accounts");
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, "/accounts?all=true");
    expect(result.current.state.allAccounts).toEqual(["Checking", "Hidden"]);
  });

  it("loadAllAccounts=false skips the all=true fetch (wizard case)", async () => {
    mockApiPost.mockResolvedValueOnce({});
    mockApiFetch.mockResolvedValueOnce(["Checking"]);

    const { result } = renderHook(() => useBudgetAccountLoader({
      budgetIdField: "ynabBudgetId",
      loadAllAccounts: false,
    }));
    await act(async () => { await result.current.selectBudget("budget-1"); });

    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(result.current.state.allAccounts).toEqual([]);
  });

  // Regression / hardening: previously, rapid back-to-back selectBudget
  // calls could race — a slow first /accounts response would clobber the
  // newer one. Hook guards via inflightRef.
  //
  // Test shape: hold apiPost open for the first selectBudget so its
  // fetchAccountsFor never fires until *after* the second selectBudget
  // has bumped the inflight token. The first call's late-arriving
  // /accounts response should be dropped, leaving the second's accounts
  // as the committed state.
  it("rapid double-call resolves with the second's accounts (last-write-wins)", async () => {
    let resolveFirstPost: (v: any) => void = () => {};
    mockApiPost
      .mockImplementationOnce(() => new Promise((r) => { resolveFirstPost = r; })) // first /config — hold
      .mockResolvedValue({}); // second /config — resolves immediately
    // apiFetch ordering: the second selectBudget reaches /accounts FIRST
    // (because its apiPost resolves immediately), then the stalled first
    // selectBudget eventually reaches /accounts. So the first mock = NEW
    // (second call wins), second mock = OLD (first call's stale response).
    mockApiFetch
      .mockResolvedValueOnce(["NEW"])
      .mockResolvedValueOnce(["OLD"]);

    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "ynabBudgetId" }));

    let firstPromise: Promise<void> = Promise.resolve();
    let secondPromise: Promise<void> = Promise.resolve();

    // Fire first call; it stalls on apiPost.
    await act(async () => {
      firstPromise = result.current.selectBudget("b1");
      await Promise.resolve();
    });

    // Fire second call while first is mid-flight. Second's apiPost
    // resolves immediately so it reaches fetchAccountsFor first.
    await act(async () => {
      secondPromise = result.current.selectBudget("b2");
      await secondPromise;
    });

    expect(result.current.state.accounts).toEqual(["NEW"]);

    // Now unblock the stale first call's apiPost. Its fetchAccountsFor
    // returns ["OLD"], but the token check must drop it.
    await act(async () => {
      resolveFirstPost({});
      await firstPromise;
    });

    expect(result.current.state.accounts).toEqual(["NEW"]);
  });

  it("refreshAccounts re-fetches without changing the budget id", async () => {
    mockApiFetch.mockResolvedValueOnce(["A", "B"]);
    const { result } = renderHook(() => useBudgetAccountLoader({
      budgetIdField: "ynabBudgetId",
      initialSelectedBudgetId: "budget-x",
    }));

    await act(async () => { await result.current.refreshAccounts(); });

    expect(result.current.state.selectedBudgetId).toBe("budget-x");
    expect(result.current.state.accounts).toEqual(["A", "B"]);
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it("failed /accounts surfaces 'Connected, but failed to load accounts' in state.error", async () => {
    mockApiPost.mockResolvedValueOnce({});
    mockApiFetch.mockRejectedValueOnce(new Error("500"));

    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "ynabBudgetId" }));
    await act(async () => { await result.current.selectBudget("b1"); });

    expect(result.current.state.error).toBe("Connected, but failed to load accounts");
  });

  it("setBudgets and setSelectedAccount update state directly", () => {
    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "ynabBudgetId" }));
    act(() => {
      result.current.setBudgets([{ id: "x", name: "X" }]);
      result.current.setSelectedAccount("Checking");
    });
    expect(result.current.state.budgets).toEqual([{ id: "x", name: "X" }]);
    expect(result.current.state.selectedAccount).toBe("Checking");
  });

  // Regression: settings's provider-switch flow needs to restore the
  // new provider's saved budget id without firing /config. Without
  // setSelectedBudgetId, selectBudget would POST the YNAB id under
  // actualSyncId (or vice versa) before the provider switch landed.
  it("setSelectedBudgetId updates local state without POSTing /config", () => {
    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "ynabBudgetId" }));
    act(() => { result.current.setSelectedBudgetId("restored-id"); });
    expect(result.current.state.selectedBudgetId).toBe("restored-id");
    expect(mockApiPost).not.toHaveBeenCalled();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

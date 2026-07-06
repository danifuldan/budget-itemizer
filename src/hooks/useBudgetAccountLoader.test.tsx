// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBudgetAccountLoader } from "./useBudgetAccountLoader";
import type { AccountRef } from "../api/types";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiFetch, apiPost } from "../api/client";
const mockApiFetch = vi.mocked(apiFetch);
const mockApiPost = vi.mocked(apiPost);

const refs = (...rs: [string, string][]): AccountRef[] =>
  rs.map(([id, name]) => ({ id, name }));

describe("useBudgetAccountLoader", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiPost.mockReset();
  });

  it("selectBudget POSTs /config with the right field name (ynabBudgetId)", async () => {
    mockApiPost.mockResolvedValueOnce({});
    mockApiFetch.mockResolvedValueOnce(refs(["acc-1", "Checking"], ["acc-2", "Savings"]));

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

  it("selectBudget fetches /accounts and auto-selects the first one's id", async () => {
    mockApiPost.mockResolvedValueOnce({});
    mockApiFetch.mockResolvedValueOnce(refs(["acc-1", "Checking"], ["acc-2", "Savings"]));

    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "ynabBudgetId" }));
    await act(async () => { await result.current.selectBudget("budget-1"); });

    expect(result.current.state.accounts).toEqual(
      refs(["acc-1", "Checking"], ["acc-2", "Savings"]),
    );
    // selectedAccount holds the stable id, not the display name.
    expect(result.current.state.selectedAccount).toBe("acc-1");
  });

  it("loadAllAccounts=true triggers a second /accounts?all=true fetch", async () => {
    mockApiPost.mockResolvedValueOnce({});
    mockApiFetch
      .mockResolvedValueOnce(refs(["acc-1", "Checking"]))
      .mockResolvedValueOnce(refs(["acc-1", "Checking"], ["acc-9", "Hidden"]));

    const { result } = renderHook(() => useBudgetAccountLoader({
      budgetIdField: "ynabBudgetId",
      loadAllAccounts: true,
    }));
    await act(async () => { await result.current.selectBudget("budget-1"); });

    expect(mockApiFetch).toHaveBeenNthCalledWith(1, "/accounts?provider=ynab");
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, "/accounts?all=true&provider=ynab");
    expect(result.current.state.allAccounts).toEqual(
      refs(["acc-1", "Checking"], ["acc-9", "Hidden"]),
    );
  });

  it("loadAllAccounts=false skips the all=true fetch (wizard case)", async () => {
    mockApiPost.mockResolvedValueOnce({});
    mockApiFetch.mockResolvedValueOnce(refs(["acc-1", "Checking"]));

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
      .mockResolvedValueOnce(refs(["new", "NEW"]))
      .mockResolvedValueOnce(refs(["old", "OLD"]));

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

    expect(result.current.state.accounts).toEqual(refs(["new", "NEW"]));

    // Now unblock the stale first call's apiPost. Its fetchAccountsFor
    // returns ["OLD"], but the token check must drop it.
    await act(async () => {
      resolveFirstPost({});
      await firstPromise;
    });

    expect(result.current.state.accounts).toEqual(refs(["new", "NEW"]));
  });

  // Regression (premortem Bug 1): refreshAccounts must NOT clobber an
  // already-selected account that is still present in the refreshed list.
  // The settings provider round-trip relies on this — switching away and
  // back re-fetches accounts, and the saved Default Account (which the
  // import targets) must survive rather than snapping to the first one.
  it("refreshAccounts preserves an already-selected account that's still present", async () => {
    mockApiFetch.mockResolvedValueOnce(refs(["acc-1", "Checking"], ["acc-2", "Savings"]));
    const { result } = renderHook(() => useBudgetAccountLoader({
      budgetIdField: "ynabBudgetId",
      initialSelectedAccount: "acc-2",
    }));

    await act(async () => { await result.current.refreshAccounts(); });

    expect(result.current.state.selectedAccount).toBe("acc-2");
  });

  // Regression (premortem round 2, Bug 2): an empty /accounts response
  // must NOT wipe an existing selection. Otherwise a transient empty reply
  // from the 30s focus-refresh blanks the Default Account, and the next
  // good refresh then snaps it to the first account.
  it("refreshAccounts preserves the selection when /accounts returns empty", async () => {
    mockApiFetch.mockResolvedValueOnce([]);
    const { result } = renderHook(() => useBudgetAccountLoader({
      budgetIdField: "ynabBudgetId",
      initialSelectedAccount: "acct-2",
    }));

    await act(async () => { await result.current.refreshAccounts(); });

    expect(result.current.state.selectedAccount).toBe("acct-2");
  });

  it("refreshAccounts re-selects the first account when the prior selection is gone", async () => {
    mockApiFetch.mockResolvedValueOnce(refs(["acc-1", "Checking"], ["acc-2", "Savings"]));
    const { result } = renderHook(() => useBudgetAccountLoader({
      budgetIdField: "ynabBudgetId",
      initialSelectedAccount: "acc-removed",
    }));

    await act(async () => { await result.current.refreshAccounts(); });

    expect(result.current.state.selectedAccount).toBe("acc-1");
  });

  // Regression (premortem round 3, Bug 1): refreshAccounts(preferred) must
  // honor the explicitly-passed account, not a live (pollutable) selection.
  // Rapid provider switches can leave `selectedAccount` holding another
  // provider's account id; passing the desired id makes the result
  // deterministic regardless of that pollution.
  it("refreshAccounts(preferred) selects the preferred account over the live selection", async () => {
    mockApiFetch.mockResolvedValueOnce(refs(["acct-1", "Checking"], ["acct-2", "Savings"]));
    const { result } = renderHook(() => useBudgetAccountLoader({
      budgetIdField: "ynabBudgetId",
      initialSelectedAccount: "polluted-from-other-provider",
    }));

    await act(async () => { await result.current.refreshAccounts("acct-2"); });

    expect(result.current.state.selectedAccount).toBe("acct-2");
  });

  it("refreshAccounts(preferred) falls back to the first account when preferred is absent", async () => {
    mockApiFetch.mockResolvedValueOnce(refs(["acct-1", "Checking"], ["acct-2", "Savings"]));
    const { result } = renderHook(() => useBudgetAccountLoader({
      budgetIdField: "ynabBudgetId",
      initialSelectedAccount: "acct-2",
    }));

    // Preferred id isn't in this provider's list (e.g. a YNAB account id
    // passed while Actual accounts loaded) → first account.
    await act(async () => { await result.current.refreshAccounts("not-here"); });

    expect(result.current.state.selectedAccount).toBe("acct-1");
  });

  it("refreshAccounts re-fetches without changing the budget id", async () => {
    mockApiFetch.mockResolvedValueOnce(refs(["a", "A"], ["b", "B"]));
    const { result } = renderHook(() => useBudgetAccountLoader({
      budgetIdField: "ynabBudgetId",
      initialSelectedBudgetId: "budget-x",
    }));

    await act(async () => { await result.current.refreshAccounts(); });

    expect(result.current.state.selectedBudgetId).toBe("budget-x");
    expect(result.current.state.accounts).toEqual(refs(["a", "A"], ["b", "B"]));
    expect(mockApiPost).not.toHaveBeenCalled();
  });

  it("failed /accounts surfaces 'Connected, but failed to load accounts' in state.error", async () => {
    mockApiPost.mockResolvedValueOnce({});
    mockApiFetch.mockRejectedValueOnce(new Error("500"));

    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "ynabBudgetId" }));
    await act(async () => { await result.current.selectBudget("b1"); });

    expect(result.current.state.error).toBe("Connected, but failed to load accounts");
  });

  // Root-cause regression (Actual account dropdown wouldn't load): account
  // fetches that omitted `?provider=` resolved against the server's guessed
  // config-active provider, which is stale/racy right after a switch — so an
  // Actual screen could fetch YNAB accounts (and fail). The loader knows its
  // own provider (via budgetIdField) and must ALWAYS send it, so no callsite
  // can trigger the server's guess path.
  it("refreshAccounts always sends the loader's provider (actual)", async () => {
    mockApiFetch.mockResolvedValueOnce(refs(["acc-1", "Apple Card"]));
    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "actualSyncId" }));
    await act(async () => { await result.current.refreshAccounts(); });
    expect(mockApiFetch).toHaveBeenCalledWith("/accounts?provider=actual");
  });

  it("refreshAccounts always sends the loader's provider (ynab)", async () => {
    mockApiFetch.mockResolvedValueOnce(refs(["acc-1", "Checking"]));
    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "ynabBudgetId" }));
    await act(async () => { await result.current.refreshAccounts(); });
    expect(mockApiFetch).toHaveBeenCalledWith("/accounts?provider=ynab");
  });

  it("the all=true fetch also carries the loader's provider", async () => {
    mockApiFetch
      .mockResolvedValueOnce(refs(["acc-1", "Apple Card"]))
      .mockResolvedValueOnce(refs(["acc-1", "Apple Card"], ["acc-9", "Hidden"]));
    const { result } = renderHook(() => useBudgetAccountLoader({
      budgetIdField: "actualSyncId",
      loadAllAccounts: true,
    }));
    await act(async () => { await result.current.refreshAccounts(); });
    expect(mockApiFetch).toHaveBeenNthCalledWith(1, "/accounts?provider=actual");
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, "/accounts?all=true&provider=actual");
  });

  // The synchronous provider-switch case still needs an explicit override:
  // handleProviderChange calls refreshAccounts before React re-renders the
  // loader with the new budgetIdField, so the override must win.
  it("an explicit provider override wins over the loader's own provider", async () => {
    mockApiFetch.mockResolvedValueOnce(refs(["acc-1", "Checking"]));
    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "actualSyncId" }));
    await act(async () => { await result.current.refreshAccounts(undefined, "ynab"); });
    expect(mockApiFetch).toHaveBeenCalledWith("/accounts?provider=ynab");
  });

  it("setBudgets and setSelectedAccount update state directly", () => {
    const { result } = renderHook(() => useBudgetAccountLoader({ budgetIdField: "ynabBudgetId" }));
    act(() => {
      result.current.setBudgets([{ id: "x", name: "X" }]);
      result.current.setSelectedAccount("acc-1");
    });
    expect(result.current.state.budgets).toEqual([{ id: "x", name: "X" }]);
    expect(result.current.state.selectedAccount).toBe("acc-1");
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

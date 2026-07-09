import { useState, useRef } from "react";
import { apiFetch, apiPost } from "../api/client";
import type { AccountRef } from "../api/types";

export interface BudgetSummary {
  id: string;
  name: string;
}

export interface BudgetAccountState {
  budgets: BudgetSummary[];
  selectedBudgetId: string;
  accounts: AccountRef[];
  /** Populated only when `loadAllAccounts` is true (settings case).
   *  Surfaces hidden/closed accounts for the visibility toggle UI. */
  allAccounts: AccountRef[];
  /** The selected account *id* (stable identity), not its display name. */
  selectedAccount: string;
  loadingAccounts: boolean;
  /** Non-empty when a /accounts fetch failed after a successful budget
   *  switch. Used by callers to show "Connected, but failed to load
   *  accounts" (settings) or equivalent. */
  error: string;
}

export interface UseBudgetAccountLoaderOptions {
  /** Backend field name to set when switching budgets: `ynabBudgetId`
   *  for YNAB, `actualSyncId` for Actual. */
  budgetIdField: "ynabBudgetId" | "actualSyncId";
  /** Settings needs the visibility-toggle list; wizard doesn't. */
  loadAllAccounts?: boolean;
  initialBudgets?: BudgetSummary[];
  initialSelectedBudgetId?: string;
  initialSelectedAccount?: string;
}

export interface UseBudgetAccountLoaderReturn {
  state: BudgetAccountState;
  setBudgets: (budgets: BudgetSummary[]) => void;
  setSelectedAccount: (account: string) => void;
  /** Set the selectedBudgetId locally WITHOUT firing /config or
   *  /accounts. Used when the caller already knows the right id
   *  (e.g. switching providers in settings — restoring the saved
   *  budget for the newly-active provider). */
  setSelectedBudgetId: (id: string) => void;
  /** Switches the active budget — POSTs /config + fetches /accounts.
   *  Rapid back-to-back calls resolve last-write-wins via an in-flight
   *  token; an earlier call's late response cannot overwrite a later
   *  call's accounts. */
  selectBudget: (id: string) => Promise<void>;
  /** Re-fetch accounts for the current budget id (e.g. after a token
   *  refresh exposed new accounts). Pass `preferredAccountId` to pin the
   *  selection to a known id (kept if present in the fetched list, else the
   *  first account) instead of preserving the live selection — used on a
   *  provider switch so a concurrent refresh can't reassign the target.
   *  Pass `provider` to read a specific provider's accounts regardless of
   *  the backend's global config.budgetProvider (a switch hasn't persisted
   *  it yet) — closes the cross-provider read race. */
  refreshAccounts: (preferredAccountId?: string, provider?: "ynab" | "actual") => Promise<void>;
}

/**
 * Loads + manages budget/account dropdowns. Used by both SetupWizard
 * (step 4) and SettingsView (Budget Connection + Account Visibility).
 *
 * Key behaviors:
 * - selectBudget POSTs the right field (ynabBudgetId vs actualSyncId)
 *   before fetching /accounts so the server reads the correct budget.
 * - loadAllAccounts toggles the second `/accounts?all=true` fetch.
 * - Auto-selects the first account when one isn't already selected.
 * - In-flight token ref prevents rapid double-clicks from racing.
 * - On /accounts failure, surfaces `error` instead of crashing — caller
 *   can decide whether to render the "Connected but failed to load
 *   accounts" branch.
 */
export function useBudgetAccountLoader(options: UseBudgetAccountLoaderOptions): UseBudgetAccountLoaderReturn {
  const {
    budgetIdField,
    loadAllAccounts = false,
    initialBudgets = [],
    initialSelectedBudgetId = "",
    initialSelectedAccount = "",
  } = options;

  // The loader's own provider, derived from the budget-id field it manages.
  // Every account fetch sends this so the server never has to guess from its
  // (stale-during-a-switch) config-active flag — the root cause of the Actual
  // account dropdown fetching YNAB and failing. Callers may still override it
  // (the synchronous provider-switch case, before React re-renders the loader).
  const loaderProvider: "ynab" | "actual" =
    budgetIdField === "actualSyncId" ? "actual" : "ynab";

  const [budgets, setBudgetsState] = useState<BudgetSummary[]>(initialBudgets);
  const [selectedBudgetId, setSelectedBudgetId] = useState(initialSelectedBudgetId);
  const [accounts, setAccounts] = useState<AccountRef[]>([]);
  const [allAccounts, setAllAccounts] = useState<AccountRef[]>([]);
  const [selectedAccount, setSelectedAccountState] = useState(initialSelectedAccount);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [error, setError] = useState("");

  // Monotonic counter — every selectBudget/refreshAccounts call snapshots
  // this, and only the most recent caller is allowed to commit results.
  // Without this, a slow first request returning after a fast second one
  // would clobber the second's account list.
  const inflightRef = useRef(0);

  const setBudgets = (next: BudgetSummary[]) => setBudgetsState(next);
  const setSelectedAccount = (account: string) => setSelectedAccountState(account);

  const fetchAccountsFor = async (token: number, preferredAccountId?: string, providerOverride?: "ynab" | "actual") => {
    setError("");
    const provider = providerOverride ?? loaderProvider;
    try {
      const accts = await apiFetch<AccountRef[]>(`/accounts?provider=${provider}`);
      if (inflightRef.current !== token) return; // stale — drop
      setAccounts(accts);
      // Decide the selection from `preferredAccountId` when the caller gave
      // one (a provider switch knows the saved account and must not trust a
      // `prev` that a concurrent refresh may have polluted); otherwise
      // preserve the live selection. Keep the target if it's present in the
      // fetched list, else fall back to the first account. selectBudget
      // clears the selection to "" first, so a freshly-picked budget still
      // lands on its first account. An empty list leaves the selection
      // untouched — a transient empty reply must not blank the saved account.
      setSelectedAccountState((prev) => {
        if (accts.length === 0) return prev;
        const want = preferredAccountId !== undefined ? preferredAccountId : prev;
        return want && accts.some((a) => a.id === want) ? want : accts[0].id;
      });

      if (loadAllAccounts) {
        const all = await apiFetch<AccountRef[]>(`/accounts?all=true&provider=${provider}`);
        if (inflightRef.current !== token) return;
        setAllAccounts(all);
      }
    } catch {
      if (inflightRef.current !== token) return;
      setError("Connected, but failed to load accounts");
    }
  };

  const selectBudget = async (id: string): Promise<void> => {
    setSelectedBudgetId(id);
    // Reset downstream state so the user doesn't see stale accounts
    // attached to the previous budget for a frame.
    setSelectedAccountState("");
    setAccounts([]);
    setAllAccounts([]);
    setLoadingAccounts(true);

    const token = ++inflightRef.current;

    try {
      await apiPost("/config", { [budgetIdField]: id });
    } catch {
      // Persist failed; still attempt /accounts so the user sees what
      // they have access to. The next save (or test-connection) re-tries.
    }

    if (inflightRef.current !== token) {
      // A newer call superseded us before /accounts even fired.
      return;
    }

    await fetchAccountsFor(token);

    if (inflightRef.current === token) setLoadingAccounts(false);
  };

  const refreshAccounts = async (preferredAccountId?: string, provider?: "ynab" | "actual"): Promise<void> => {
    setLoadingAccounts(true);
    const token = ++inflightRef.current;
    await fetchAccountsFor(token, preferredAccountId, provider);
    if (inflightRef.current === token) setLoadingAccounts(false);
  };

  return {
    state: {
      budgets,
      selectedBudgetId,
      accounts,
      allAccounts,
      selectedAccount,
      loadingAccounts,
      error,
    },
    setBudgets,
    setSelectedAccount,
    setSelectedBudgetId,
    selectBudget,
    refreshAccounts,
  };
}

import { useState, useRef } from "react";
import { apiFetch, apiPost } from "../api/client";

export interface BudgetSummary {
  id: string;
  name: string;
}

export interface BudgetAccountState {
  budgets: BudgetSummary[];
  selectedBudgetId: string;
  accounts: string[];
  /** Populated only when `loadAllAccounts` is true (settings case).
   *  Surfaces hidden/closed accounts for the visibility toggle UI. */
  allAccounts: string[];
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
   *  refresh exposed new accounts). */
  refreshAccounts: () => Promise<void>;
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

  const [budgets, setBudgetsState] = useState<BudgetSummary[]>(initialBudgets);
  const [selectedBudgetId, setSelectedBudgetId] = useState(initialSelectedBudgetId);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [allAccounts, setAllAccounts] = useState<string[]>([]);
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

  const fetchAccountsFor = async (token: number) => {
    setError("");
    try {
      const accts = await apiFetch<string[]>("/accounts");
      if (inflightRef.current !== token) return; // stale — drop
      setAccounts(accts);
      if (accts.length > 0) setSelectedAccountState(accts[0]);

      if (loadAllAccounts) {
        const all = await apiFetch<string[]>("/accounts?all=true");
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

  const refreshAccounts = async (): Promise<void> => {
    setLoadingAccounts(true);
    const token = ++inflightRef.current;
    await fetchAccountsFor(token);
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

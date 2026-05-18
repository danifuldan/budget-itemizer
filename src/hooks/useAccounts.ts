import { useRetryableFetch } from "./useRetryableFetch";
import type { AccountRef } from "../api/types";

export function useAccounts(enabled: boolean = true): {
  accounts: AccountRef[];
  /** Force a re-fetch of /accounts — wired to focus + dropdown-open so a
   *  YNAB-side rename surfaces without waiting for the next poll. */
  refresh: () => void;
} {
  const { data, refresh } = useRetryableFetch<AccountRef[]>("/accounts", [], { enabled });
  return { accounts: data, refresh };
}

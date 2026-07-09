import { useRetryableFetch } from "./useRetryableFetch";
import type { AccountRef } from "../api/types";

export function useAccounts(
  enabled: boolean = true,
  provider?: "ynab" | "actual",
): {
  accounts: AccountRef[];
  /** Force a re-fetch of /accounts — wired to focus + dropdown-open so a
   *  YNAB-side rename surfaces without waiting for the next poll. */
  refresh: () => void;
} {
  // Read the active provider's accounts explicitly rather than relying on the
  // server's config-active guess — the same fix applied to the Settings
  // account loader. When `provider` is omitted the server still falls back to
  // config-active (kept for callers that legitimately want the active one).
  const url = provider ? `/accounts?provider=${provider}` : "/accounts";
  const { data, refresh } = useRetryableFetch<AccountRef[]>(url, [], { enabled });
  return { accounts: data, refresh };
}

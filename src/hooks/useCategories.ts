import { useRetryableFetch } from "./useRetryableFetch";

export function useCategories(
  enabled: boolean = true,
  provider?: "ynab" | "actual",
): { categories: string[]; refresh: () => void } {
  // Bare by default: the server resolves categories against its authoritative
  // on-disk config-active provider. `provider` is an opt-in for callers that
  // must target a specific one (kept parallel to useAccounts). `refresh` lets
  // the main view re-read after Settings may have switched the active provider.
  const url = provider ? `/categories?provider=${provider}` : "/categories";
  const { data, refresh } = useRetryableFetch<string[]>(url, [], { enabled });
  return { categories: data, refresh };
}

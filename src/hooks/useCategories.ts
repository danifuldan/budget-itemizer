import { useRetryableFetch } from "./useRetryableFetch";

export function useCategories(
  enabled: boolean = true,
  provider?: "ynab" | "actual",
): string[] {
  // Read the active provider's categories explicitly (categories are
  // provider-specific) rather than relying on the server's config-active guess.
  const url = provider ? `/categories?provider=${provider}` : "/categories";
  return useRetryableFetch<string[]>(url, [], { enabled }).data;
}

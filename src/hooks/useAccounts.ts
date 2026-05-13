import { useRetryableFetch } from "./useRetryableFetch";

export function useAccounts(enabled: boolean = true): string[] {
  return useRetryableFetch<string[]>("/accounts", [], { enabled }).data;
}

import { useRetryableFetch } from "./useRetryableFetch";
import type { AccountRef } from "../api/types";

export function useAccounts(enabled: boolean = true): AccountRef[] {
  return useRetryableFetch<AccountRef[]>("/accounts", [], { enabled }).data;
}

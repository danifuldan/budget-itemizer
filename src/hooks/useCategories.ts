import { useRetryableFetch } from "./useRetryableFetch";

export function useCategories(enabled: boolean = true): string[] {
  return useRetryableFetch<string[]>("/categories", [], { enabled }).data;
}

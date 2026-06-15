import { useMemo } from "react";
import { apiPost } from "../api/client";
import { useRetryableFetch } from "./useRetryableFetch";

export interface ConfigData {
  embeddedModel: string;
  budgetProvider: "ynab" | "actual";
  ynabApiKey: string;
  ynabApiKeyLength?: number;
  ynabBudgetId: string;
  actualServerUrl: string;
  actualPassword: string;
  actualPasswordLength?: number;
  actualSyncId: string;
  ynabAccountId: string;
  defaultAccount: string;
  inboxPath: string;
  processedPath: string;
  deleteAfterImport: boolean;
  watcherEnabled: boolean;
  watcherAutoImport: boolean;
  watcherNotify: boolean;
  watcherFocusApp: boolean;
  minimizeToTray: boolean;
  matchAcrossAccounts: boolean;
  ynabHiddenAccounts: string[];
  actualHiddenAccounts: string[];
  discountMode: "distribute" | "credit";
}

const defaultConfig: ConfigData = {
  embeddedModel: "llama3.1-8b",
  budgetProvider: "ynab",
  ynabApiKey: "",
  ynabBudgetId: "",
  actualServerUrl: "",
  actualPassword: "",
  actualSyncId: "",
  ynabAccountId: "",
  defaultAccount: "",
  inboxPath: "",
  processedPath: "",
  deleteAfterImport: false,
  watcherEnabled: true,
  watcherAutoImport: false,
  watcherNotify: true,
  watcherFocusApp: false,
  minimizeToTray: true,
  matchAcrossAccounts: true,
  ynabHiddenAccounts: [] as string[],
  actualHiddenAccounts: [] as string[],
  discountMode: "distribute" as const,
};

export function useConfig() {
  // Backend returns a partial config; fields the user hasn't set yet are
  // absent. Merge with defaults so consumers can read every field safely.
  const { data, loading, refresh, mutate } = useRetryableFetch<Partial<ConfigData>>("/config", {});
  const config = useMemo(() => ({ ...defaultConfig, ...data }), [data]);

  const save = async (updates: Partial<ConfigData>): Promise<boolean> => {
    try {
      await apiPost("/config", updates);
      mutate((prev) => ({ ...prev, ...updates }));
      return true;
    } catch {
      return false;
    }
  };

  return { config, loading, save, refresh };
}

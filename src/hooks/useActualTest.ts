import { useState } from "react";
import { apiPost } from "../api/client";

export interface ActualTestResult {
  success: boolean;
  error?: string;
}

export interface ActualBudget {
  id: string;
  name: string;
}

export interface ActualTestState {
  serverUrl: string;
  password: string;
  /** True once the user has typed into the password field. Until then,
   *  the password is the masked placeholder (e.g. "••••") and must not
   *  be POSTed back as a real credential. */
  passwordChanged: boolean;
  result: ActualTestResult | null;
  testing: boolean;
  budgets: ActualBudget[];
}

export interface UseActualTestOptions {
  initialServerUrl?: string;
  /** Settings passes "•".repeat(actualPasswordLength) as the masked
   *  placeholder. Wizard passes "" since there's no saved password yet. */
  initialPasswordPlaceholder?: string;
  /** Called after `test()` lands, with the result and (on success)
   *  the returned budget list. Wizard uses this to seed selectedBudget. */
  onTested?: (result: ActualTestResult, budgets: ActualBudget[]) => Promise<void> | void;
}

export interface UseActualTestReturn {
  state: ActualTestState;
  setServerUrl: (url: string) => void;
  /** Sets the password AND flips `passwordChanged = true`. */
  setPassword: (pw: string) => void;
  test: () => Promise<void>;
}

/**
 * Actual Budget credential fields + test-connection lifecycle.
 *
 * Persists via `/config` (NOT `/setup/save`) — this canonicalizes on
 * settings's endpoint. Wizard's old behavior was `/setup/save`; if a
 * Phase-3 e2e regresses we revert this endpoint and document, per the
 * plan's risk-hotspot §4.
 *
 * `passwordChanged` is the gate that prevents POSTing the masked
 * placeholder (`••••`) as a real password.
 */
export function useActualTest(options: UseActualTestOptions = {}): UseActualTestReturn {
  const {
    initialServerUrl = "http://localhost:5006",
    initialPasswordPlaceholder = "",
    onTested,
  } = options;

  const [serverUrl, setServerUrlState] = useState(initialServerUrl);
  const [password, setPasswordState] = useState(initialPasswordPlaceholder);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [result, setResult] = useState<ActualTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [budgets, setBudgets] = useState<ActualBudget[]>([]);

  const setServerUrl = (url: string) => setServerUrlState(url);

  const setPassword = (pw: string) => {
    setPasswordState(pw);
    setPasswordChanged(true);
  };

  const test = async (): Promise<void> => {
    setResult(null);
    setTesting(true);
    try {
      // Persist URL + (conditionally) password before testing. Backend
      // /setup/test-actual reads from saved config.
      const configUpdate: Record<string, string> = { actualServerUrl: serverUrl };
      if (passwordChanged && password) configUpdate.actualPassword = password;
      try {
        await apiPost("/config", configUpdate);
      } catch {
        // Swallow — test endpoint will use whatever config is on disk and
        // surface its own error if creds are stale.
      }

      const data = await apiPost<{
        success: boolean;
        error?: string;
        budgets?: ActualBudget[];
      }>("/setup/test-actual", {});

      if (data.success) {
        const nextResult: ActualTestResult = { success: true };
        const nextBudgets = data.budgets ?? [];
        setResult(nextResult);
        setBudgets(nextBudgets);
        try {
          await onTested?.(nextResult, nextBudgets);
        } catch {
          // Best-effort.
        }
      } else {
        const nextResult: ActualTestResult = { success: false, error: data.error || "Connection failed" };
        setResult(nextResult);
        try {
          await onTested?.(nextResult, []);
        } catch {
          // Best-effort.
        }
      }
    } catch (err: any) {
      const nextResult: ActualTestResult = { success: false, error: err?.message || "Could not reach server" };
      setResult(nextResult);
    } finally {
      setTesting(false);
    }
  };

  return {
    state: { serverUrl, password, passwordChanged, result, testing, budgets },
    setServerUrl,
    setPassword,
    test,
  };
}

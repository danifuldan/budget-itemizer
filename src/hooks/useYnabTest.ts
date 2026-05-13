import { useState } from "react";
import { apiPost } from "../api/client";

export interface YnabTestResult {
  success: boolean;
  budgets?: { id: string; name: string }[];
  error?: string;
}

export interface YnabTestState {
  apiKey: string;
  result: YnabTestResult | null;
  testing: boolean;
}

export interface UseYnabTestOptions {
  initialApiKey?: string;
  /** Called after `test()` lands a result (both success and failure
   *  paths). Callers use this to populate the budget list from
   *  `result.budgets` and trigger downstream account loads. */
  onTested?: (result: YnabTestResult) => Promise<void> | void;
}

export interface UseYnabTestReturn {
  state: YnabTestState;
  setApiKey: (key: string) => void;
  test: () => Promise<YnabTestResult>;
}

/**
 * YNAB credential field + test-connection lifecycle.
 *
 * Saves the new API key (if non-empty) before testing, so the backend's
 * /setup/test-ynab reads from the most recent value. Note the asymmetric
 * empty-key handling: an empty apiKey means "test with the saved key" —
 * the wizard never hits this branch (Test button is disabled), but
 * settings does when the user clicks Test without retyping the token.
 */
export function useYnabTest(options: UseYnabTestOptions = {}): UseYnabTestReturn {
  const { initialApiKey = "", onTested } = options;
  const [apiKey, setApiKeyState] = useState(initialApiKey);
  const [result, setResult] = useState<YnabTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const setApiKey = (key: string) => setApiKeyState(key);

  const test = async (): Promise<YnabTestResult> => {
    setTesting(true);
    try {
      if (apiKey) {
        // Save the new key before testing so the server has it. Match the
        // wizard's historical endpoint (/setup/save) — see plan §"Risk
        // hotspots" §4: YNAB stays on /setup/save, Actual moves to /config.
        try {
          await apiPost("/setup/save", { ynabApiKey: apiKey });
        } catch {
          // If save fails, /setup/test-ynab will fall through to the
          // saved-key path and the user gets a clear "Failed: ..." result
          // from the test endpoint itself. Don't bail here — preserve the
          // old behavior where a transient save failure was still
          // recoverable via the saved key.
        }
      }
      const response = await apiPost<YnabTestResult>("/setup/test-ynab", {});
      setResult(response);
      try {
        await onTested?.(response);
      } catch {
        // Best-effort — `result` is already set, so the user sees the
        // outcome even if the caller's follow-up (e.g. /accounts fetch)
        // throws.
      }
      return response;
    } catch {
      const errResult: YnabTestResult = { success: false, error: "Could not reach server" };
      setResult(errResult);
      return errResult;
    } finally {
      setTesting(false);
    }
  };

  return {
    state: { apiKey, result, testing },
    setApiKey,
    test,
  };
}

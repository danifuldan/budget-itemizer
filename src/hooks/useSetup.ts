import { API_BASE, ensureAuth } from "../api/client";

/**
 * Minimal helper for the wizard's goNext save-on-advance flow.
 *
 * Previously this hook also hosted `testYnab` and a `testing` flag, but
 * those moved into useYnabTest. saveSetup stays here because the
 * wizard's per-step save semantics (return boolean, swallow errors) are
 * distinct from the standard apiPost flow and would clutter the
 * test-connection hooks if folded in.
 */
export function useSetup() {
  const saveSetup = async (fields: Record<string, unknown>): Promise<boolean> => {
    try {
      const auth = await ensureAuth();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (auth) headers["Authorization"] = auth;
      const res = await fetch(`${API_BASE}/setup/save`, {
        method: "POST",
        headers,
        body: JSON.stringify(fields),
      });
      const data = await res.json();
      return data.success ?? false;
    } catch {
      return false;
    }
  };

  return { saveSetup };
}

// One-time, idempotent, best-effort reconciler that moves account
// identity from a mutable YNAB display NAME to the stable account id.
// Called non-blocking at startup. Pure w.r.t. injected resolver/persist
// so it's unit-testable without the network. Never throws — a failed
// resolve just means "try again next launch"; a renamed account that no
// longer matches the stored name leaves the id empty so the picker can
// re-select (it must not guess).

export interface AccountRef {
  id: string;
  name: string;
}

interface MigratableConfig {
  budgetProvider: string;
  ynabAccountId?: string;
  defaultAccount: string;
  hiddenAccounts: string[];
}

const sameSet = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
};

export async function migrateAccountIdentity(
  cfg: MigratableConfig,
  resolveAccounts: () => Promise<AccountRef[]>,
  persist: (updates: { ynabAccountId?: string; hiddenAccounts?: string[] }) => Promise<void> | void,
): Promise<{ ynabAccountId: string; hiddenAccounts: string[] }> {
  const currentId = cfg.ynabAccountId ?? "";
  const currentHidden = cfg.hiddenAccounts ?? [];
  const unchanged = { ynabAccountId: currentId, hiddenAccounts: currentHidden };

  if (cfg.budgetProvider !== "ynab") return unchanged;
  // Steady state: id resolved and no name-keyed hidden entries to fix.
  // Skip the resolve entirely so startup doesn't pay a YNAB call once
  // migration has happened.
  if (currentId && currentHidden.length === 0) return unchanged;

  let accounts: AccountRef[];
  try {
    accounts = await resolveAccounts();
  } catch {
    return unchanged; // best-effort: retry next launch
  }

  const byName = new Map(accounts.map((a) => [a.name, a.id]));
  const ids = new Set(accounts.map((a) => a.id));

  // Default account: only resolve if we don't already have an id. A
  // stored name that no longer exists (rename) leaves the id empty —
  // do NOT guess; the picker will re-select.
  let nextId = currentId;
  if (!currentId && cfg.defaultAccount) {
    nextId = byName.get(cfg.defaultAccount) ?? "";
  }

  // Hidden accounts: keep entries that are already ids, map names → ids,
  // drop entries that resolve to neither (closed/renamed-away).
  const nextHidden = Array.from(
    new Set(
      currentHidden
        .map((e) => (ids.has(e) ? e : byName.get(e)))
        .filter((e): e is string => typeof e === "string"),
    ),
  );

  const updates: { ynabAccountId?: string; hiddenAccounts?: string[] } = {};
  if (nextId !== currentId) updates.ynabAccountId = nextId;
  if (!sameSet(nextHidden, currentHidden)) updates.hiddenAccounts = nextHidden;

  if (Object.keys(updates).length > 0) {
    try {
      await persist(updates);
    } catch {
      // best-effort; the in-memory return below still reflects intent
    }
  }

  return { ynabAccountId: nextId, hiddenAccounts: nextHidden };
}

// Account identity is moving from a mutable display NAME to the stable
// YNAB account id. migrateAccountIdentity is the one-time, idempotent,
// best-effort reconciler. The load-bearing case is the disagreement: the
// stored name no longer exists in YNAB (user renamed the account) — it
// must NOT crash, NOT block, and NOT guess; it leaves the id empty so the
// picker can re-select. Resolver + persist are injected (no network).
import { describe, it, expect, vi } from "vitest";
import { migrateAccountIdentity } from "./account-identity";
import type { AccountRef } from "./account-identity";

const ynab = (over: Partial<Parameters<typeof migrateAccountIdentity>[0]> = {}) => ({
  budgetProvider: "ynab",
  ynabAccountId: "",
  ynabDefaultAccount: "",
  ynabHiddenAccounts: [] as string[],
  ...over,
});

describe("migrateAccountIdentity", () => {
  it("renamed account: stored name absent in YNAB → id stays empty, no throw, no guess", async () => {
    const persist = vi.fn();
    const out = await migrateAccountIdentity(
      ynab({ ynabDefaultAccount: "Bank of America" }),
      async (): Promise<AccountRef[]> => [{ id: "acc1", name: "Wells Fargo Checking" }],
      persist,
    );
    expect(out.ynabAccountId).toBe(""); // unresolved — picker re-selects
    expect(persist).not.toHaveBeenCalledWith(
      expect.objectContaining({ ynabAccountId: expect.stringMatching(/.+/) }),
    );
  });

  it("resolvable name → id is set and persisted", async () => {
    const persist = vi.fn();
    const out = await migrateAccountIdentity(
      ynab({ ynabDefaultAccount: "Wells Fargo Checking" }),
      async () => [{ id: "acc1", name: "Wells Fargo Checking" }],
      persist,
    );
    expect(out.ynabAccountId).toBe("acc1");
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ ynabAccountId: "acc1" }));
  });

  it("idempotent: already-migrated config is a no-op (no persist, no needless resolve cost)", async () => {
    const persist = vi.fn();
    const resolve = vi.fn(async () => [{ id: "acc1", name: "Wells Fargo Checking" }]);
    await migrateAccountIdentity(
      ynab({ ynabAccountId: "acc1", ynabDefaultAccount: "Wells Fargo Checking", ynabHiddenAccounts: ["acc1"] }),
      resolve,
      persist,
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it("ynabHiddenAccounts: names → ids, unresolvable dropped, existing ids kept", async () => {
    const persist = vi.fn();
    const out = await migrateAccountIdentity(
      ynab({
        ynabAccountId: "acc1",
        ynabDefaultAccount: "Wells Fargo Checking",
        ynabHiddenAccounts: ["Old Closed Acct", "Savings", "acc1"],
      }),
      async () => [
        { id: "acc1", name: "Wells Fargo Checking" },
        { id: "acc9", name: "Savings" },
      ],
      persist,
    );
    expect(out.ynabHiddenAccounts.sort()).toEqual(["acc1", "acc9"]);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ ynabHiddenAccounts: expect.arrayContaining(["acc1", "acc9"]) }),
    );
  });

  // Regression (Bug B): the YNAB reconciliation must operate ONLY on the YNAB
  // hidden list. It persists `ynabHiddenAccounts`, never the legacy global
  // `hiddenAccounts` key — so Actual's separate list can't be pruned by a
  // YNAB-only resolve.
  it("persists ynabHiddenAccounts, never the legacy global hiddenAccounts key", async () => {
    const persist = vi.fn();
    await migrateAccountIdentity(
      ynab({ ynabAccountId: "acc1", ynabDefaultAccount: "Wells Fargo Checking", ynabHiddenAccounts: ["Savings"] }),
      async () => [{ id: "acc1", name: "Wells Fargo Checking" }, { id: "acc9", name: "Savings" }],
      persist,
    );
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ ynabHiddenAccounts: ["acc9"] }),
    );
    expect(persist).not.toHaveBeenCalledWith(
      expect.objectContaining({ hiddenAccounts: expect.anything() }),
    );
  });

  it("non-ynab provider → no-op even with stale data", async () => {
    const persist = vi.fn();
    await migrateAccountIdentity(
      { budgetProvider: "actual", ynabAccountId: "", ynabDefaultAccount: "Stale", ynabHiddenAccounts: ["x"] },
      async () => [{ id: "a", name: "b" }],
      persist,
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it("resolver throws → best-effort no-op, never throws", async () => {
    const persist = vi.fn();
    await expect(
      migrateAccountIdentity(
        ynab({ ynabDefaultAccount: "Bank of America" }),
        async () => {
          throw new Error("YNAB unreachable");
        },
        persist,
      ),
    ).resolves.toBeDefined();
    expect(persist).not.toHaveBeenCalled();
  });
});

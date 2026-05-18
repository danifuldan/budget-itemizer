// The index.ts startup wiring is thin, but it has a real contract:
// thread getConfig() → migrateAccountIdentity → persist, and NEVER let a
// failure crash server boot (it runs non-blocking after serve binds).
// These tests exercise the wired path through the REAL
// migrateAccountIdentity, not a mock of it.
import { describe, it, expect, vi } from "vitest";
import { runStartupAccountMigration } from "./account-identity";

describe("runStartupAccountMigration", () => {
  it("resolves an empty ynabAccountId from defaultAccount and persists the id", async () => {
    const persist = vi.fn();
    await runStartupAccountMigration({
      getConfig: () => ({
        budgetProvider: "ynab",
        ynabAccountId: "",
        defaultAccount: "Checking",
        hiddenAccounts: [],
      }),
      resolveAccounts: async () => [{ id: "acc-1", name: "Checking" }],
      persist,
    });
    expect(persist).toHaveBeenCalledWith({ ynabAccountId: "acc-1" });
  });

  it("does not guess: a renamed account leaves the id empty (no persist)", async () => {
    const persist = vi.fn();
    await runStartupAccountMigration({
      getConfig: () => ({
        budgetProvider: "ynab",
        ynabAccountId: "",
        defaultAccount: "Bank of America", // stale: account was renamed
        hiddenAccounts: [],
      }),
      resolveAccounts: async () => [{ id: "acc-1", name: "Wells Fargo Checking" }],
      persist,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it("never rejects even if persist throws (must not crash boot)", async () => {
    await expect(
      runStartupAccountMigration({
        getConfig: () => ({
          budgetProvider: "ynab",
          ynabAccountId: "",
          defaultAccount: "Checking",
          hiddenAccounts: [],
        }),
        resolveAccounts: async () => [{ id: "acc-1", name: "Checking" }],
        persist: () => {
          throw new Error("disk full");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

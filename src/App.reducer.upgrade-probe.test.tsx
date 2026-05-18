// PREMORTEM PROBE (Bug 1): the upgrade ordering.
// On the first post-upgrade launch, /accounts resolves while
// config.ynabAccountId is still "" (the non-blocking startup migration
// in index.ts has not persisted the resolved id yet, and the FE has not
// refetched /config). The emitter dispatches ACCOUNTS_LOADED with
// defaultAccountId:"" FIRST, then again with the real id once config
// catches up. This probe folds that exact sequence and asserts the
// user's saved account ultimately wins.
import { describe, it, expect } from "vitest";
import { reducer, initialState, type AppAction } from "./App";
import type { AccountRef } from "./api/types";

const accts: AccountRef[] = [
  { id: "acc-1", name: "Wells Fargo Checking" },
  { id: "acc-2", name: "Savings" }, // the user's actual saved default
];

describe("PROBE: upgrade ordering — accounts resolve before ynabAccountId", () => {
  it("ends on the user's saved account id, not the first account", () => {
    const final = [
      // 1st emit: config not loaded yet → defaultAccountId is empty.
      { type: "ACCOUNTS_LOADED", accounts: accts, defaultAccountId: "" } as AppAction,
      // 2nd emit: startup migration persisted + /config refetched → real id.
      { type: "ACCOUNTS_LOADED", accounts: accts, defaultAccountId: "acc-2" } as AppAction,
    ].reduce(reducer, initialState);

    expect(final.selectedAccount).toBe("acc-2");
  });
});

// @vitest-environment happy-dom
// Reducer: the default import account (selectedAccount) is provider-scoped —
// ACCOUNTS_LOADED must re-resolve it when a provider switch delivers a new
// account list, while still preserving a valid committed pick across idempotent
// re-polls. Started as an executed premortem probe (the switch case failed on
// the pre-fix guard) — kept as the regression test.
import { describe, it, expect } from "vitest";
import { reducer, initialState } from "./App";

const load = (state: typeof initialState, accounts: { id: string; name: string }[], defaultAccountId: string) =>
  reducer(state, { type: "ACCOUNTS_LOADED", accounts, defaultAccountId });

const YNAB = [{ id: "ynab-acct", name: "YNAB Checking" }];
const ACTUAL = [{ id: "actual-acct", name: "Apple Card" }];

describe("ACCOUNTS_LOADED across a provider switch", () => {
  it("moves the committed selection to the new provider's default when the old id is absent", () => {
    const onYnab = load(initialState, YNAB, "ynab-acct");
    expect(onYnab.selectedAccount).toBe("ynab-acct");
    expect(onYnab.accountIsProvisional).toBe(false);

    // Switch → new list + new default. Old id isn't in ACTUAL, so it re-resolves.
    const onActual = load(onYnab, ACTUAL, "actual-acct");
    expect(onActual.selectedAccount).toBe("actual-acct");
    expect(onActual.accountIsProvisional).toBe(false);
  });

  it("settles correctly even if the new accounts arrive before the new default (ordering race)", () => {
    const onYnab = load(initialState, YNAB, "ynab-acct");
    // New list arrives first, still carrying the OLD default id (config not yet
    // refreshed) → old id invalid in ACTUAL, no valid default → provisional first.
    const mid = load(onYnab, ACTUAL, "ynab-acct");
    expect(mid.selectedAccount).toBe("actual-acct");
    expect(mid.accountIsProvisional).toBe(true);
    // Then the new default lands → corrects and commits.
    const settled = load(mid, ACTUAL, "actual-acct");
    expect(settled.selectedAccount).toBe("actual-acct");
    expect(settled.accountIsProvisional).toBe(false);
  });

  it("does NOT override a still-valid committed pick when the default changes (user pick wins)", () => {
    // Commit ynab-acct, then a re-poll with the SAME list but a different default
    // must not clobber the committed selection.
    const committed = load(initialState, YNAB, "ynab-acct");
    const twoAccts = [{ id: "ynab-acct", name: "YNAB Checking" }, { id: "ynab-savings", name: "Savings" }];
    const rePoll = load(committed, twoAccts, "ynab-savings");
    expect(rePoll.selectedAccount).toBe("ynab-acct");
  });

  it("is idempotent on re-poll with the same list (committed selection survives)", () => {
    const committed = load(initialState, YNAB, "ynab-acct");
    const again = load(committed, YNAB, "ynab-acct");
    expect(again).toBe(committed); // same reference — no state churn
  });
});

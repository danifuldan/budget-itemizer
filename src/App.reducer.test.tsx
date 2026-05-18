import { describe, it, expect } from "vitest";
import { reducer, initialState, discardTargetFor, type AppAction } from "./App";
import type { Receipt, AccountRef } from "./api/types";

/**
 * Bug 2 regression: streamed line-item amounts are provisional (extracted
 * before total/summary lines are claimed). The backend then emits the
 * reconciled receipt via the `done` event. STREAM_DONE used to keep the
 * streamed amounts and only patch categories, so the review screen (and
 * the import payload, which is built from state.items) could show/submit
 * a stale amount that disagreed with what reconciliation produced.
 *
 * Every other receipt-ingest branch (LOAD_RECEIPT, RECEIPT_READY_FOR_
 * PENDING) already adopts action.receipt.lineItems wholesale. STREAM_DONE
 * must do the same — one pattern for "a finished receipt arrived."
 */

function fold(actions: AppAction[]) {
  return actions.reduce(reducer, initialState);
}

describe("reducer STREAM_DONE", () => {
  it("adopts reconciled line-item amounts from the final receipt", () => {
    const file = new File([], "receipt.pdf", { type: "application/pdf" });

    // The reconciled receipt the backend emits on `done`. The line item's
    // true amount is 12.00 — different from the 9.99 streamed guess below.
    const reconciled: Receipt = {
      merchant: "TestCo",
      transactionDate: "2026-05-10",
      memo: "",
      totalAmount: 12.0,
      category: "Shopping",
      lineItems: [
        {
          productName: "Widget",
          quantity: 1,
          lineItemTotalAmount: 12.0,
          category: "Shopping",
        },
      ],
    };

    const state = fold([
      { type: "START_STREAM", file },
      { type: "SET_HEADER", header: { merchant: "TestCo", transactionDate: "2026-05-10" } },
      // Provisional streamed amount — deliberately wrong.
      { type: "ADD_ITEM", item: { productName: "Widget", quantity: 1, amount: 9.99 } },
      { type: "SET_TOTAL", totals: { totalAmount: 12.0 } },
      // Category resolves during streaming — this is what made the old
      // code keep the (stale) streamed item via `if (item.category) return item`.
      { type: "SET_CATEGORIES", categories: ["Shopping"] },
      { type: "STREAM_DONE", receipt: reconciled },
    ]);

    expect(state.streamDone).toBe(true);
    expect(state.items).toHaveLength(1);
    expect(state.items[0].lineItemTotalAmount).toBe(12.0);
    expect(state.items[0].productName).toBe("Widget");
    expect(state.items[0].category).toBe("Shopping");
  });

  // Regression (premortem Bug 1): a line the user deletes WHILE the receipt
  // is still streaming must stay deleted after parsing completes — the
  // reconciled receipt still lists it, so a wholesale replace resurrected
  // it. ItemRow is editable during streaming, so this is reachable.
  it("does not resurrect a line the user deleted before parsing finished", () => {
    const file = new File([], "r.pdf", { type: "application/pdf" });
    const reconciled: Receipt = {
      merchant: "C", transactionDate: "2026-05-10", memo: "", totalAmount: 5,
      category: "X",
      lineItems: [
        { productName: "Keep", quantity: 1, lineItemTotalAmount: 3, category: "X" },
        { productName: "JunkAd", quantity: 1, lineItemTotalAmount: 2, category: "X" },
      ],
    };
    const state = fold([
      { type: "START_STREAM", file },
      { type: "ADD_ITEM", item: { productName: "Keep", quantity: 1, amount: 3 } },
      { type: "ADD_ITEM", item: { productName: "JunkAd", quantity: 1, amount: 2 } },
      { type: "DELETE_ITEM", index: 1 }, // user removes the junk line mid-stream
      { type: "STREAM_DONE", receipt: reconciled },
    ]);
    // If this is 2, the user's deletion was reverted (junk line resurrected).
    expect(state.items.map((i) => i.productName)).toEqual(["Keep"]);
  });

  // A streamed item the reconciled receipt doesn't include must NOT vanish
  // from the review screen — the user saw it; dropping it silently is the
  // Bug-2 regression. It keeps its streamed values; the reconcile gate
  // still guards the total at import.
  it("keeps a streamed item with no reconciled match instead of dropping it", () => {
    const file = new File([], "r.pdf", { type: "application/pdf" });
    const reconciled: Receipt = {
      merchant: "C", transactionDate: "2026-05-10", memo: "", totalAmount: 3,
      category: "X",
      lineItems: [{ productName: "A", quantity: 1, lineItemTotalAmount: 3, category: "X" }],
    };
    const state = fold([
      { type: "START_STREAM", file },
      { type: "ADD_ITEM", item: { productName: "A", quantity: 1, amount: 2.5 } },
      { type: "ADD_ITEM", item: { productName: "B", quantity: 1, amount: 1 } },
      { type: "STREAM_DONE", receipt: reconciled },
    ]);
    expect(state.items.map((i) => i.productName)).toEqual(["A", "B"]);
    // A matched → amount refreshed to the reconciled 3; B unmatched → kept.
    expect(state.items[0].lineItemTotalAmount).toBe(3);
    expect(state.items[1].lineItemTotalAmount).toBe(1);
  });

  // Account identity is now the stable id, not the mutable display name.
  // ACCOUNTS_LOADED must seed selectedAccount with an *id*, preferring the
  // configured default-account id when it still resolves.
  const accts: AccountRef[] = [
    { id: "acc-1", name: "Wells Fargo Checking" },
    { id: "acc-2", name: "Savings" },
  ];

  it("ACCOUNTS_LOADED selects the configured default-account id when it matches", () => {
    const s = fold([
      { type: "ACCOUNTS_LOADED", accounts: accts, defaultAccountId: "acc-2" } as AppAction,
    ]);
    expect(s.selectedAccount).toBe("acc-2");
  });

  // The disagreement: the stored default-account id no longer resolves
  // (account was deleted, or config still holds an empty/stale id after a
  // rename the migration couldn't reconcile). It must NOT keep the stale
  // id — it falls back to the first available account's id so the picker
  // shows a real, selectable account.
  it("ACCOUNTS_LOADED falls back to the first account id when the default id no longer resolves", () => {
    const s = fold([
      { type: "ACCOUNTS_LOADED", accounts: accts, defaultAccountId: "acc-GONE" } as AppAction,
    ]);
    expect(s.selectedAccount).toBe("acc-1");
  });

  // Premortem Bug 1: on first post-upgrade launch /accounts resolves
  // before the async startup migration persists ynabAccountId, so the
  // emitter fires with defaultAccountId:"" FIRST (→ provisional first
  // account), then again with the real id. The real id must correct the
  // provisional pick, not be swallowed by idempotency.
  it("ACCOUNTS_LOADED corrects a provisional first-account pick when the real default id arrives later", () => {
    const s = fold([
      { type: "ACCOUNTS_LOADED", accounts: accts, defaultAccountId: "" } as AppAction,
      { type: "ACCOUNTS_LOADED", accounts: accts, defaultAccountId: "acc-2" } as AppAction,
    ]);
    expect(s.selectedAccount).toBe("acc-2");
  });

  it("ACCOUNTS_LOADED never overrides an explicit user pick even after a real default id arrives", () => {
    const s = fold([
      { type: "ACCOUNTS_LOADED", accounts: accts, defaultAccountId: "" } as AppAction,
      { type: "SET_ACCOUNT", account: "acc-1" }, // user deliberately picks acc-1
      { type: "ACCOUNTS_LOADED", accounts: accts, defaultAccountId: "acc-2" } as AppAction,
    ]);
    expect(s.selectedAccount).toBe("acc-1");
  });

  it("ACCOUNTS_LOADED is idempotent — never overrides an account the user already picked", () => {
    const s = fold([
      { type: "ACCOUNTS_LOADED", accounts: accts, defaultAccountId: "acc-1" } as AppAction,
      { type: "SET_ACCOUNT", account: "acc-2" },
      // A later poll re-emits with a different default — must not clobber.
      { type: "ACCOUNTS_LOADED", accounts: accts, defaultAccountId: "acc-1" } as AppAction,
    ]);
    expect(s.selectedAccount).toBe("acc-2");
  });

  it("ACCOUNTS_LOADED is a no-op on an empty accounts list", () => {
    const s = fold([
      { type: "ACCOUNTS_LOADED", accounts: [], defaultAccountId: "acc-1" } as AppAction,
    ]);
    expect(s.selectedAccount).toBe("");
  });

  it("NAVIGATE carries an optional settingsSection (status-link deep-link)", () => {
    const toWatcher = fold([
      { type: "NAVIGATE", view: "settings", settingsSection: "folder-watcher" } as AppAction,
    ]);
    expect(toWatcher.view).toBe("settings");
    expect(toWatcher.settingsSection).toBe("folder-watcher");

    // A plain settings open (no section) must not carry a stale target.
    const plain = fold([{ type: "NAVIGATE", view: "settings" } as AppAction]);
    expect(plain.settingsSection).toBeUndefined();
  });
});

// Bug: in-review Discard for a receipt opened from HISTORY fired the
// pending-watcher delete (DELETE /watcher/pending/{filename}) -> 404,
// silent no-op. LOAD_RECEIPT dropped the history record id, and the only
// origin signal was sourceFilename, which a history receipt also sets,
// so the JSX ternary always chose the pending route. The discard target
// must differ by origin: history -> DELETE /history/{id}; pending ->
// skip pending. This is the "test the disagreement" probe.
const historyReceipt: Receipt = {
  merchant: "Walmart",
  transactionDate: "2026-05-18",
  memo: "",
  totalAmount: 33.66,
  category: "Groceries",
  lineItems: [
    { productName: "Black beans 15oz can", quantity: 1, lineItemTotalAmount: 33.66, category: "Groceries" },
  ],
};

describe("reducer LOAD_RECEIPT origin (history vs pending)", () => {
  it("LOAD_RECEIPT from history records the history id in state", () => {
    const s = fold([
      { type: "LOAD_RECEIPT", receipt: historyReceipt, sourceFilename: "Walmart_receipt.pdf", historyId: "hist-1" } as AppAction,
    ]);
    expect(s.view).toBe("review");
    expect(s.sourceFilename).toBe("Walmart_receipt.pdf");
    expect(s.historyId).toBe("hist-1");
  });

  it("LOAD_RECEIPT from a pending file leaves historyId null", () => {
    const s = fold([
      { type: "LOAD_RECEIPT", receipt: historyReceipt, sourceFilename: "watched.pdf" } as AppAction,
    ]);
    expect(s.sourceFilename).toBe("watched.pdf");
    expect(s.historyId).toBeNull();
  });

  it("a falsy history id is normalized to null, not stored as \"\"", () => {
    // Invariant: historyId is a non-empty string OR null — never "".
    // Otherwise discardTargetFor's truthiness gate silently routes a
    // history receipt back to the pending (404) path.
    const s = fold([
      { type: "LOAD_RECEIPT", receipt: historyReceipt, sourceFilename: "Walmart_receipt.pdf", historyId: "" } as AppAction,
    ]);
    expect(s.historyId).toBeNull();
    expect(discardTargetFor(s)).toEqual({ kind: "pending", filename: "Walmart_receipt.pdf" });
  });
});

describe("discardTargetFor — history-origin vs pending-origin discard route", () => {
  it("a history-loaded receipt discards via /history/{id}, NOT the pending route", () => {
    const s = fold([
      { type: "LOAD_RECEIPT", receipt: historyReceipt, sourceFilename: "Walmart_receipt.pdf", historyId: "hist-1" } as AppAction,
    ]);
    expect(discardTargetFor(s)).toEqual({ kind: "history", id: "hist-1" });
  });

  it("a pending-loaded receipt discards via the pending-watcher delete", () => {
    const s = fold([
      { type: "LOAD_RECEIPT", receipt: historyReceipt, sourceFilename: "watched.pdf" } as AppAction,
    ]);
    expect(discardTargetFor(s)).toEqual({ kind: "pending", filename: "watched.pdf" });
  });

  it("no source -> no discard target (button hidden)", () => {
    expect(discardTargetFor(initialState)).toBeNull();
  });
});

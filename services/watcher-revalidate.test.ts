// Regression: when YNAB reconnects after an offline period, pending
// receipts categorized against the stale list must have categories that
// no longer exist in the budget reset to "" (uncategorized). Otherwise
// import would silently route money to the wrong (or missing) envelope.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addPending,
  markPendingReady,
  getPending,
  getPendingFiles,
  removePending,
  revalidatePendingCategories,
  watcherEvents,
} from "./watcher";
import type { Receipt } from "./shared-types";

// Tiny pure-data Receipt fixture; we don't need real parser output.
const buildReceipt = (categories: string[]): Receipt => ({
  merchant: "Test",
  totalAmount: 0,
  transactionDate: "2026-01-01",
  lineItems: categories.map((category, i) => ({
    name: `item-${i}`,
    amount: 1,
    category,
  })),
}) as any;

describe("revalidatePendingCategories", () => {
  beforeEach(() => {
    // Clear pending state from any prior test.
    for (const f of getPendingFiles()) removePending(f.filename);
  });

  it("clears categories that aren't in the fresh list", () => {
    addPending("a.pdf", "/tmp/a.pdf");
    markPendingReady("a.pdf", buildReceipt(["Groceries", "Gas", "Phone"]));

    const { affected } = revalidatePendingCategories(["Groceries", "Phone"]); // Gas removed upstream

    expect(affected).toEqual(["a.pdf"]);
    const items = getPending("a.pdf")!.receipt!.lineItems!;
    expect(items.map((i) => i.category)).toEqual(["Groceries", "", "Phone"]);
  });

  it("emits file-parsed for receipts that were mutated", () => {
    addPending("b.pdf", "/tmp/b.pdf");
    markPendingReady("b.pdf", buildReceipt(["StaleCategory"]));

    const handler = vi.fn();
    watcherEvents.on("file-parsed", handler);

    revalidatePendingCategories(["Groceries", "Phone"]);

    expect(handler).toHaveBeenCalled();
    const lastCall = handler.mock.calls[handler.mock.calls.length - 1][0];
    expect(lastCall.filename).toBe("b.pdf");
    watcherEvents.off("file-parsed", handler);
  });

  it("does not touch already-empty categories or receipts in non-ready states", () => {
    addPending("ready.pdf", "/tmp/ready.pdf");
    markPendingReady("ready.pdf", buildReceipt(["", "Groceries"]));

    addPending("parsing.pdf", "/tmp/parsing.pdf");
    // Don't mark ready — should be skipped.

    const { affected } = revalidatePendingCategories(["Groceries"]);

    expect(affected).toEqual([]); // ready.pdf had only valid + empty; parsing.pdf is skipped
    expect(getPending("ready.pdf")!.receipt!.lineItems!.map((i) => i.category)).toEqual(["", "Groceries"]);
  });

  it("affects multiple receipts independently", () => {
    addPending("one.pdf", "/tmp/one.pdf");
    markPendingReady("one.pdf", buildReceipt(["Stale1"]));
    addPending("two.pdf", "/tmp/two.pdf");
    markPendingReady("two.pdf", buildReceipt(["Stale2", "Groceries"]));

    const { affected } = revalidatePendingCategories(["Groceries"]);

    expect(affected.sort()).toEqual(["one.pdf", "two.pdf"]);
    expect(getPending("one.pdf")!.receipt!.lineItems![0].category).toBe("");
    expect(getPending("two.pdf")!.receipt!.lineItems!.map((i) => i.category)).toEqual(["", "Groceries"]);
  });

  it("emits categories-revalidated event with the affected list", () => {
    addPending("c.pdf", "/tmp/c.pdf");
    markPendingReady("c.pdf", buildReceipt(["StaleX"]));

    const handler = vi.fn();
    watcherEvents.on("categories-revalidated", handler);

    revalidatePendingCategories(["OnlyValid"]);

    expect(handler).toHaveBeenCalledWith({ affected: ["c.pdf"] });
    watcherEvents.off("categories-revalidated", handler);
  });
});

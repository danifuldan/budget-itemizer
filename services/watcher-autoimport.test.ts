// F1 regression: watcher auto-import (autoImportParsed) submitted to the
// budget provider WITHOUT going through claimForImport. The moment a file
// finishes parsing, `file-parsed` is emitted and the FE row becomes a
// clickable "ready" — so a manual Quick-Import can claim and submit the
// same receipt in the window before autoImportParsed reaches
// `await importReceipt`. Result: two YNAB transactions for one receipt.
// The fix brackets autoImportParsed with the same claim the /import
// route uses; whichever path claims first wins, the other bails.
import { describe, it, expect, beforeEach, vi } from "vitest";

const importReceipt = vi.fn<(account: string, receipt: any) => Promise<void>>();
vi.mock("./receipt", async () => {
  const actual = await vi.importActual<typeof import("./receipt")>("./receipt");
  return { ...actual, importReceipt: (a: string, r: any) => importReceipt(a, r) };
});
// The disagreement: defaultAccount holds a now-stale display name while
// ynabAccountId holds the stable id. Auto-import must submit to the id.
vi.mock("./config", () => ({
  getConfig: () => ({
    defaultAccount: "Bank of America",
    ynabAccountId: "acc-1",
    processedPath: "/tmp/out",
  }),
}));
const addRecord = vi.fn();
vi.mock("./history", () => ({ addRecord: (...a: any[]) => addRecord(...a) }));

import {
  addPending,
  markPendingReady,
  getPending,
  getPendingFiles,
  removePending,
  claimForImport,
  autoImportParsed,
} from "./watcher";
import type { Receipt } from "./shared-types";

const fakeReceipt: Receipt = {
  merchant: "Walmart",
  totalAmount: 10,
  transactionDate: "2026-01-01",
  lineItems: [],
} as any;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("autoImportParsed — claim-bracketed (F1)", () => {
  beforeEach(() => {
    for (const f of getPendingFiles()) removePending(f.filename);
    importReceipt.mockReset().mockResolvedValue(undefined);
    addRecord.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("bails (no second submit) when a manual import already claimed the entry", async () => {
    addPending("dup.pdf", "/tmp/dup.pdf");
    markPendingReady("dup.pdf", fakeReceipt);
    // The manual /import path wins the claim first.
    expect(claimForImport("dup.pdf")).toBe(true);

    const entry = getPending("dup.pdf")!;
    await autoImportParsed(entry);

    // Auto-import must NOT also submit — the manual path owns this receipt.
    expect(importReceipt).not.toHaveBeenCalled();
  });

  it("submits to the stable ynabAccountId, not the stale defaultAccount name", async () => {
    addPending("id.pdf", "/tmp/id.pdf");
    markPendingReady("id.pdf", fakeReceipt);

    const entry = getPending("id.pdf")!;
    await autoImportParsed(entry);

    expect(importReceipt).toHaveBeenCalledTimes(1);
    expect(importReceipt.mock.calls[0][0]).toBe("acc-1");
  });

  it("claims first so a concurrent manual import is rejected", async () => {
    addPending("a.pdf", "/tmp/a.pdf");
    markPendingReady("a.pdf", fakeReceipt);
    const d = deferred<void>();
    importReceipt.mockReturnValue(d.promise);

    const entry = getPending("a.pdf")!;
    const p = autoImportParsed(entry); // mid-import (deferred)

    // A concurrent manual /import must see the entry already claimed.
    expect(claimForImport("a.pdf")).toBe(false);

    d.resolve();
    await p;
    expect(importReceipt).toHaveBeenCalledTimes(1);
  });
});

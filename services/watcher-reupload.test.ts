// F5 regression: addPending's "re-upload" branch refreshed
// filePath/detectedAt unconditionally. If a claimed import is in flight
// (status "importing" — /import has already snapshotted claimedFilePath),
// a re-upload mutated the entry's filePath underneath it. On import
// success removePending deletes the entry, leaving the re-uploaded bytes
// at the new path with NO pending entry and NO claim → the watcher
// re-parses and (auto-import) re-imports them = duplicate transaction.
// addPending must NOT mutate an entry that is currently "importing".
import { describe, it, expect, beforeEach } from "vitest";
import {
  addPending,
  markPendingReady,
  getPending,
  getPendingFiles,
  removePending,
  claimForImport,
} from "./watcher";
import type { Receipt } from "./shared-types";

const fakeReceipt = { merchant: "Amazon", totalAmount: 5, transactionDate: "2026-05-10", lineItems: [] } as any as Receipt;

describe("addPending leaves an in-flight claimed entry untouched (F5)", () => {
  beforeEach(() => {
    for (const f of getPendingFiles()) removePending(f.filename);
  });

  it("does not re-path or re-stamp an entry that is currently importing", () => {
    addPending("Order.pdf", "/inbox/old/Order.pdf");
    markPendingReady("Order.pdf", fakeReceipt);
    expect(claimForImport("Order.pdf")).toBe(true); // /import owns it now
    const before = getPending("Order.pdf")!;
    const beforePath = before.filePath;
    const beforeStamp = before.detectedAt;

    // A re-upload arrives mid-import.
    addPending("Order.pdf", "/inbox/new/Order.pdf");

    const after = getPending("Order.pdf")!;
    expect(after.status).toBe("importing"); // claim intact
    expect(after.filePath).toBe(beforePath); // NOT hijacked to /new
    expect(after.detectedAt).toBe(beforeStamp);
  });

  it("still refreshes a non-importing entry on re-upload (version-token behavior preserved)", async () => {
    addPending("b.pdf", "/inbox/old/b.pdf");
    const stamp1 = getPending("b.pdf")!.detectedAt;
    await new Promise((r) => setTimeout(r, 2));
    addPending("b.pdf", "/inbox/new/b.pdf"); // status still "parsing"
    const e = getPending("b.pdf")!;
    expect(e.filePath).toBe("/inbox/new/b.pdf");
    expect(e.detectedAt).not.toBe(stamp1);
  });
});

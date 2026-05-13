// Regression: addPending used to no-op when called for an already-known
// filename. That made the DELETE-vs-POST race destructive — a stale
// pending entry kept its old `detectedAt` while the file on disk was
// silently overwritten by a concurrent re-upload. addPending now
// refreshes path + detectedAt so the FE-side version token (detectedAt)
// changes, which the DELETE handler uses to refuse stale Discards.
import { describe, it, expect, beforeEach } from "vitest";
import {
  addPending,
  getPending,
  getPendingFiles,
  removePending,
  markPendingReady,
} from "./watcher";
import type { Receipt } from "./shared-types";

const fakeReceipt: Receipt = {
  merchant: "Walmart",
  totalAmount: 10,
  transactionDate: "2026-01-01",
  lineItems: [],
} as any;

describe("addPending — re-upload behavior", () => {
  beforeEach(() => {
    for (const f of getPendingFiles()) removePending(f.filename);
  });

  it("re-adding the same filename refreshes detectedAt and filePath", async () => {
    addPending("foo.pdf", "/tmp/old/foo.pdf");
    const first = getPending("foo.pdf")!;
    const firstStamp = first.detectedAt;
    const firstPath = first.filePath;

    // Force a different ISO timestamp on the second add. setTimeout(1)
    // is enough on every platform we run on.
    await new Promise((r) => setTimeout(r, 5));
    addPending("foo.pdf", "/tmp/new/foo.pdf");

    const second = getPending("foo.pdf")!;
    expect(second.detectedAt).not.toBe(firstStamp);
    expect(second.filePath).toBe("/tmp/new/foo.pdf");
    expect(second.filePath).not.toBe(firstPath);
  });

  it("preserves status and receipt across a re-add (does not disturb in-flight parses)", () => {
    addPending("bar.pdf", "/tmp/bar.pdf");
    markPendingReady("bar.pdf", fakeReceipt);
    expect(getPending("bar.pdf")?.status).toBe("ready");

    addPending("bar.pdf", "/tmp/bar.pdf");

    // Status and receipt are intentionally untouched. The FE will see
    // a fresh detectedAt and may decide what to do; we don't reset.
    expect(getPending("bar.pdf")?.status).toBe("ready");
    expect(getPending("bar.pdf")?.receipt).toBe(fakeReceipt);
  });
});

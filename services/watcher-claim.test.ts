// Regression: a double-click on Import (or any concurrent /import call
// for the same pending file) must not produce two YNAB submissions.
// `claimForImport` is the atomic gate that prevents the second call from
// reaching the budget provider.
import { describe, it, expect, beforeEach } from "vitest";
import {
  addPending,
  markPendingReady,
  getPending,
  getPendingFiles,
  removePending,
  claimForImport,
  releaseImportClaim,
  clearAllPending,
} from "./watcher";
import type { Receipt } from "./shared-types";

const fakeReceipt: Receipt = {
  merchant: "Walmart",
  totalAmount: 10,
  transactionDate: "2026-01-01",
  lineItems: [],
} as any;

describe("claimForImport / releaseImportClaim", () => {
  beforeEach(() => {
    for (const f of getPendingFiles()) removePending(f.filename);
  });

  it("first claim succeeds; second claim on the same filename returns false", () => {
    addPending("a.pdf", "/tmp/a.pdf");
    markPendingReady("a.pdf", fakeReceipt);

    expect(claimForImport("a.pdf")).toBe(true);
    expect(getPending("a.pdf")?.status).toBe("importing");

    // Second concurrent call sees status="importing" and refuses.
    expect(claimForImport("a.pdf")).toBe(false);
  });

  it("release after a failed import restores status to 'ready'", () => {
    addPending("b.pdf", "/tmp/b.pdf");
    markPendingReady("b.pdf", fakeReceipt);

    expect(claimForImport("b.pdf")).toBe(true);
    releaseImportClaim("b.pdf");

    expect(getPending("b.pdf")?.status).toBe("ready");
    // After release, a fresh claim should succeed (user can retry).
    expect(claimForImport("b.pdf")).toBe(true);
  });

  it("release after a failed import on an errored receipt restores 'error'", () => {
    addPending("c.pdf", "/tmp/c.pdf");
    // Simulate a parse failure followed by user retrying via Import.
    const entry = getPending("c.pdf")!;
    entry.status = "error";
    entry.parseError = "parse failed";

    expect(claimForImport("c.pdf")).toBe(true);
    releaseImportClaim("c.pdf");

    expect(getPending("c.pdf")?.status).toBe("error");
  });

  it("returns false for a filename that isn't in pending", () => {
    expect(claimForImport("nonexistent.pdf")).toBe(false);
  });

  it("returns false for a file still being parsed (status='parsing')", () => {
    addPending("d.pdf", "/tmp/d.pdf");
    // No markPendingReady → status stays "parsing"
    expect(getPending("d.pdf")?.status).toBe("parsing");
    expect(claimForImport("d.pdf")).toBe(false);
  });

  it("release is a no-op for an entry that was never claimed", () => {
    addPending("e.pdf", "/tmp/e.pdf");
    markPendingReady("e.pdf", fakeReceipt);

    releaseImportClaim("e.pdf");
    // Status unchanged; no exception.
    expect(getPending("e.pdf")?.status).toBe("ready");
  });

  // Regression: clearAllPending used to drop *every* entry, including
  // status="importing" / status="parsing" mid-flight. That left the
  // /import handler's post-success cleanup looking up an entry that no
  // longer existed and skipping moveToProcessed — file orphaned in the
  // old inbox. Same problem for an in-flight queueFile that finishes
  // and emits file-parsed for an entry the map no longer contains.
  it("clearAllPending preserves importing entries so /import can finish its cleanup", () => {
    addPending("a.pdf", "/old-inbox/a.pdf");
    markPendingReady("a.pdf", fakeReceipt);
    expect(claimForImport("a.pdf")).toBe(true);
    expect(getPending("a.pdf")?.status).toBe("importing");

    clearAllPending();

    expect(getPending("a.pdf")?.status).toBe("importing");
    expect(getPending("a.pdf")?.filePath).toBe("/old-inbox/a.pdf");
  });

  it("clearAllPending preserves parsing entries so an in-flight queueFile won't ghost-emit", () => {
    addPending("b.pdf", "/old-inbox/b.pdf");
    // No markPendingReady → still parsing
    expect(getPending("b.pdf")?.status).toBe("parsing");

    clearAllPending();

    expect(getPending("b.pdf")?.status).toBe("parsing");
  });

  it("clearAllPending drops ready and error entries (the user moved their inbox; these are stale)", () => {
    addPending("c.pdf", "/old-inbox/c.pdf");
    markPendingReady("c.pdf", fakeReceipt);
    addPending("d.pdf", "/old-inbox/d.pdf");
    const errored = getPending("d.pdf")!;
    errored.status = "error";
    errored.parseError = "boom";

    clearAllPending();

    expect(getPending("c.pdf")).toBeUndefined();
    expect(getPending("d.pdf")).toBeUndefined();
  });
});

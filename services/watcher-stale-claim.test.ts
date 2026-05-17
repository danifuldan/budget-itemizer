// F1b regression: claimForImport flips an entry to "importing"; /import
// releases on failure. But if the /import REQUEST itself dies post-claim
// (network drop, app backgrounded) — or autoImportParsed bailed because
// a manual import claimed then died — the entry is stuck "importing"
// FOREVER: no terminal, never cleaned, the receipt neither imports nor
// is recoverable. A claim with no terminal within a generous bound is
// reaped on the next pending poll, restoring it to its pre-claim status.
// Safe to retry afterward because F2's import_id dedupes a re-create.
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

describe("stale import-claim reaper (F1b)", () => {
  beforeEach(() => {
    for (const f of getPendingFiles()) removePending(f.filename);
  });

  it("reaps an import claim with no terminal after the bound, restoring pre-claim status", () => {
    addPending("a.pdf", "/in/a.pdf");
    markPendingReady("a.pdf", fakeReceipt); // status: ready
    expect(claimForImport("a.pdf")).toBe(true); // → importing

    // The /import that claimed it died without a terminal. Age the claim.
    const entry = getPending("a.pdf")!;
    expect(entry.status).toBe("importing");
    (entry as any).claimedAt = Date.now() - 5 * 60_000; // 5 min ago

    // The FE polls pending — this is the reap trigger.
    getPendingFiles();

    const after = getPending("a.pdf")!;
    expect(after.status).toBe("ready"); // recovered, actionable again
    expect((after as any).preImportStatus).toBeUndefined();
    expect((after as any).claimedAt).toBeUndefined();
  });

  it("does NOT reap a fresh, legitimately in-flight claim", () => {
    addPending("b.pdf", "/in/b.pdf");
    markPendingReady("b.pdf", fakeReceipt);
    expect(claimForImport("b.pdf")).toBe(true);

    getPendingFiles(); // poll happens while the import is genuinely running

    expect(getPending("b.pdf")!.status).toBe("importing"); // untouched
  });
});

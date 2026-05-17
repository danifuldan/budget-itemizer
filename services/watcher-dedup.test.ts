// F4 regression: the watcher's recently-processed dedup was keyed by bare
// basename. Amazon order invoices are ALWAYS "Order.pdf", so a second,
// genuinely different Order.pdf dropped within DEDUP_TTL_MS (10s) of the
// previous one was silently never queued/parsed/imported — that receipt's
// money never entered the budget. fileDedupKey is the fix: dedup keys on
// file identity (name + size + mtime), so a same-event refire of the SAME
// file is still deduped but a DIFFERENT same-named file is not.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("./llama-server", () => ({
  isLlamaServerRunning: () => true,
  getLlamaServerStartError: () => null,
  isLlamaServerStarting: () => false,
}));

import { fileDedupKey } from "./watcher";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "watcher-dedup-"));

describe("fileDedupKey — identity, not basename (F4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is stable for the same untouched file (same-event refire stays deduped)", () => {
    const p = path.join(dir, "Order.pdf");
    fs.writeFileSync(p, "RECEIPT-A");
    const k = fileDedupKey(p);
    expect(k).toBeTruthy();
    expect(fileDedupKey(p)).toBe(k);
  });

  it("differs for two genuinely different files that share the name Order.pdf", () => {
    const p = path.join(dir, "Order.pdf");
    fs.writeFileSync(p, "FIRST-RECEIPT");
    const k1 = fileDedupKey(p)!;
    // A different receipt later saved under the same Amazon filename.
    fs.writeFileSync(p, "SECOND-DIFFERENT-RECEIPT-LONGER");
    const k2 = fileDedupKey(p)!;
    expect(k2).not.toBe(k1); // would have collided on bare basename → F4
  });

  it("returns null when the file has vanished (caller must not dedup-skip)", () => {
    expect(fileDedupKey(path.join(dir, "gone.pdf"))).toBeNull();
  });
});

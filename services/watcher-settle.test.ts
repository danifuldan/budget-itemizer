// F11 regression (coupled to F4): the watcher parsed/keyed files while
// they were still being written (slow network/iCloud copy, .crdownload
// → rename). Truncated parses, wrong totals, and — because F4's identity
// key changes as the file grows — the settled file gets processed a
// SECOND time (duplicate import). waitUntilStable gates processing on a
// size-stable file so the dedup key is the settled identity.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("./llama-server", () => ({
  isLlamaServerRunning: () => true,
  getLlamaServerStartError: () => null,
  isLlamaServerStarting: () => false,
}));

import { waitUntilStable } from "./watcher";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "watcher-settle-"));

describe("waitUntilStable (F11)", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmp();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("resolves true quickly for an already-complete file", async () => {
    const p = path.join(dir, "done.pdf");
    fs.writeFileSync(p, "COMPLETE");
    const ok = await waitUntilStable(p, { intervalMs: 15, maxMs: 2000 });
    expect(ok).toBe(true);
  });

  it("waits until a still-growing file stops changing", async () => {
    const p = path.join(dir, "growing.pdf");
    fs.writeFileSync(p, "A");
    let size = 1;
    const grow = setInterval(() => {
      size += 5;
      fs.writeFileSync(p, "X".repeat(size));
    }, 12);
    // Stop growing after ~70ms.
    setTimeout(() => clearInterval(grow), 70);

    const start = Date.now();
    const ok = await waitUntilStable(p, { intervalMs: 15, maxMs: 3000 });
    const waited = Date.now() - start;

    expect(ok).toBe(true);
    // It must not have returned during the growth phase.
    expect(waited).toBeGreaterThanOrEqual(70);
    // And the file it deemed stable is the final size.
    expect(fs.statSync(p).size).toBe(size);
  });

  it("returns false when the file vanished", async () => {
    expect(
      await waitUntilStable(path.join(dir, "ghost.pdf"), { intervalMs: 15, maxMs: 500 }),
    ).toBe(false);
  });
});

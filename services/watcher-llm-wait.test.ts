// Regression: queueFile's "wait for llama-server during warmup" loop
// (added in feat(loading-ux) 022714b) had no exit condition other than
// isLlamaServerRunning() turning true. If llama-server permanently failed
// to start (OOM, missing/corrupt model), every dropped file sat in
// "parsing" and polled every 1s FOREVER — the app never recovered and the
// event loop never quieted.
//
// The fix terminates on a recorded start error, but ONLY when no start is
// currently underway (isLlamaServerStarting() === false). lastStartError
// lingers across the gap between a failed attempt and the next one (and
// across a model-switch's stop phase), so without that guard a file
// dropped mid-restart would be wrongly errored even though the server is
// about to come up. Both cases are tested below.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("./receipt", async () => {
  const actual = await vi.importActual<typeof import("./receipt")>("./receipt");
  return {
    ...actual,
    parseImageReceiptStream: vi.fn(async () => ({
      merchant: "M",
      transactionDate: "2026-05-10",
      memo: "",
      totalAmount: 1,
      category: "X",
      lineItems: [{ productName: "I", quantity: 1, lineItemTotalAmount: 1, category: "X" }],
    })),
  };
});

const running = vi.fn<() => boolean>(() => false);
const startErr = vi.fn<() => string | null>(() => null);
const starting = vi.fn<() => boolean>(() => false);
vi.mock("./llama-server", () => ({
  isLlamaServerRunning: () => running(),
  getLlamaServerStartError: () => startErr(),
  isLlamaServerStarting: () => starting(),
}));

import {
  queueFile,
  getPending,
  getPendingFiles,
  removePending,
  watcherEvents,
} from "./watcher";
import { parseImageReceiptStream } from "./receipt";

const tempInbox = () => fs.mkdtempSync(path.join(os.tmpdir(), "watcher-llmwait-"));

describe("queueFile — llama-server warmup wait is bounded but restart-safe", () => {
  let inbox: string;

  beforeEach(() => {
    inbox = tempInbox();
    for (const f of getPendingFiles()) removePending(f.filename);
    running.mockReset().mockReturnValue(false);
    startErr.mockReset().mockReturnValue(null);
    starting.mockReset().mockReturnValue(false);
    vi.mocked(parseImageReceiptStream).mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(inbox, { recursive: true, force: true });
  });

  it("surfaces an error entry instead of polling forever when start permanently failed", async () => {
    running.mockReturnValue(false);
    startErr.mockReturnValue("llama-server health check timed out after 180s");
    starting.mockReturnValue(false); // failed, nothing in progress → terminal

    const filePath = path.join(inbox, "receipt.pdf");
    fs.writeFileSync(filePath, "%PDF-1.4 fixture");
    const parsed: any[] = [];
    const onParsed = (e: any) => parsed.push(e);
    watcherEvents.on("file-parsed", onParsed);

    const HANG = Symbol("hang");
    const result = await Promise.race([
      queueFile(filePath).then(() => "resolved"),
      new Promise((r) => setTimeout(() => r(HANG), 3000)),
    ]);
    watcherEvents.off("file-parsed", onParsed);

    expect(result).toBe("resolved");
    const entry = getPending("receipt.pdf");
    expect(entry?.status).toBe("error");
    expect(entry?.parseError).toMatch(/AI model/i);
    expect(vi.mocked(parseImageReceiptStream)).not.toHaveBeenCalled();
    expect(parsed.find((e) => e.filename === "receipt.pdf" && e.error)).toBeDefined();
  });

  it("waits through an in-progress restart and parses — does NOT error on a lingering start error while starting=true", async () => {
    // Server down for the first 2 polls, then up. A start error from a
    // prior attempt is still set, but a restart IS underway (starting
    // true) until the server comes up.
    let polls = 0;
    running.mockImplementation(() => {
      polls++;
      return polls > 2;
    });
    startErr.mockReturnValue("stale error from a prior attempt");
    starting.mockImplementation(() => polls <= 2); // restart in progress

    const filePath = path.join(inbox, "r.pdf");
    fs.writeFileSync(filePath, "%PDF-1.4 fixture");

    const HANG = Symbol("hang");
    const result = await Promise.race([
      queueFile(filePath).then(() => "resolved"),
      new Promise((r) => setTimeout(() => r(HANG), 6000)),
    ]);

    expect(result).toBe("resolved");
    const entry = getPending("r.pdf");
    expect(entry?.status).toBe("ready"); // parsed, NOT errored on the stale flag
    expect(vi.mocked(parseImageReceiptStream)).toHaveBeenCalledOnce();
  }, 8000);

  it("does not cap out a file while a start is genuinely underway (slow / suspended warmup)", async () => {
    // Premortem-found regression: the 300s cap is wall-clock. A laptop
    // sleeping during warmup (or a cold start > 5min) made Date.now jump
    // past the cap and wrongly errored a file whose server was coming up.
    let polls = 0;
    running.mockImplementation(() => {
      polls++;
      return polls > 2; // up by the 3rd poll
    });
    startErr.mockReturnValue(null); // no error — just slow
    starting.mockReturnValue(true); // a real start IS underway throughout
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() =>
      polls >= 2 ? realNow + 600_000 : realNow, // 10-min wall jump = "slept"
    );

    const filePath = path.join(inbox, "slow.pdf");
    fs.writeFileSync(filePath, "%PDF-1.4 fixture");

    const HANG = Symbol("hang");
    const result = await Promise.race([
      queueFile(filePath).then(() => "resolved"),
      new Promise((r) => setTimeout(() => r(HANG), 6000)),
    ]);

    expect(result).toBe("resolved");
    expect(getPending("slow.pdf")?.status).toBe("ready");
  }, 8000);
});

/**
 * F10 regression: POST /parse-image/stream stashes the dropped file into
 * the inbox with `if (!existsSync(destPath)) writeFileSync(...)`. When a
 * DIFFERENT unimported receipt already occupies that name (Amazon order
 * invoices are always "Order.pdf"), the new bytes were NOT written and
 * `addPending` pointed at the OLD file. On import the OLD pdf got
 * archived and the OLD unimported receipt was silently destroyed; the
 * new bytes were never persisted. Fix: uniquify on collision.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("./utils/env-vars", () => ({
  default: { APP_API_KEY: "testuser", APP_API_SECRET: "testpass", MAX_FILE_SIZE: 5242880 },
}));

let tmpInbox: string;

vi.mock("./services/config", () => ({
  getConfig: vi.fn(() => ({
    inboxPath: tmpInbox,
    processedPath: "/tmp/processed",
    appApiKey: "",
    appApiSecret: "",
    watcherAutoImport: false,
  })),
  saveConfig: vi.fn(async (u: any) => u),
  isSetupComplete: vi.fn(() => true),
  wasConfigReset: vi.fn(() => false),
}));
vi.mock("./services/budget", () => ({
  getAllAccounts: vi.fn(),
  getAllEnvelopes: vi.fn(async () => []),
}));
const parseImageReceiptStream = vi.fn();
vi.mock("./services/receipt", () => ({
  parseImageReceiptStream: (...a: any[]) => parseImageReceiptStream(...a),
  importReceiptToYnab: vi.fn(),
}));
vi.mock("./services/history", () => ({
  getHistory: vi.fn(() => []),
  addRecord: vi.fn(),
  deleteRecord: vi.fn(),
}));
vi.mock("./services/llama-server", () => ({
  isLlamaServerRunning: vi.fn(() => true),
  getLlamaServerEndpoint: vi.fn(() => "http://127.0.0.1:8921/v1"),
  getLlamaServerStartError: vi.fn(() => null),
  startLlamaServer: vi.fn(),
  stopLlamaServer: vi.fn(),
}));
const addPending = vi.fn();
const markPendingReady = vi.fn();
const removePending = vi.fn();
vi.mock("./services/watcher", () => {
  const { EventEmitter } = require("events");
  return {
    getWatcherStatus: vi.fn(() => ({ running: false, inboxPath: null })),
    startWatcher: vi.fn(() => ({ running: true })),
    stopWatcher: vi.fn(),
    watcherEvents: new EventEmitter(),
    getPendingFiles: vi.fn(() => []),
    getPending: vi.fn(),
    removePending: (...a: any[]) => removePending(...a),
    addPending: (...a: any[]) => addPending(...a),
    markPendingReady: (...a: any[]) => markPendingReady(...a),
    moveToProcessed: vi.fn(),
    claimForImport: vi.fn(() => true),
    releaseImportClaim: vi.fn(),
    clearAllPending: vi.fn(),
    queueFile: vi.fn(),
  };
});
vi.mock("./services/model-manager", () => ({
  AVAILABLE_MODELS: [],
  getModelsStatus: vi.fn(() => []),
  isModelDownloaded: vi.fn(() => true),
  downloadModel: vi.fn(),
  cancelDownload: vi.fn(),
  getModelPath: vi.fn(),
}));

import app from "./app";

const auth = "Basic " + Buffer.from("testuser:testpass").toString("base64");

beforeEach(() => {
  tmpInbox = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-collision-"));
  addPending.mockReset();
  markPendingReady.mockReset();
  removePending.mockReset();
  parseImageReceiptStream.mockReset().mockImplementation(async (_f: any, opts: any) => {
    await opts.onDone?.({ merchant: "Amazon", totalAmount: 1, transactionDate: "2026-05-10", lineItems: [] });
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /parse-image/stream — inbox name collision (F10)", () => {
  it("preserves the existing file and persists the new bytes under a unique name", async () => {
    const existing = path.join(tmpInbox, "Order.pdf");
    fs.writeFileSync(existing, "OLD-RECEIPT-BYTES");

    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(Buffer.from("NEW-DIFFERENT-RECEIPT"))], "Order.pdf", {
        type: "application/pdf",
      }),
    );
    const res = await app.request("/parse-image/stream", {
      method: "POST",
      headers: { Authorization: auth },
      body: form,
    });
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream

    // The pre-existing receipt is untouched.
    expect(fs.readFileSync(existing, "utf8")).toBe("OLD-RECEIPT-BYTES");

    // The new bytes were persisted under a distinct name.
    const written = fs
      .readdirSync(tmpInbox)
      .filter((n) => n !== "Order.pdf")
      .map((n) => ({ n, c: fs.readFileSync(path.join(tmpInbox, n), "utf8") }));
    const newFile = written.find((w) => w.c === "NEW-DIFFERENT-RECEIPT");
    expect(newFile, "new bytes must be saved to a fresh file").toBeTruthy();

    // addPending + markPendingReady reference the unique name, not Order.pdf.
    expect(addPending).toHaveBeenCalledTimes(1);
    expect(addPending.mock.calls[0][0]).toBe(newFile!.n);
    expect(addPending.mock.calls[0][0]).not.toBe("Order.pdf");
    expect(markPendingReady).toHaveBeenCalledWith(newFile!.n, expect.anything());
  });

  it("F3: an aborted parse does not resurrect the receipt via markPendingReady", async () => {
    let releaseParse!: () => void;
    parseImageReceiptStream.mockReset().mockImplementation(async (_f: any, opts: any) => {
      // Hold the parse open until the test releases it (post-abort).
      await new Promise<void>((r) => (releaseParse = r));
      await opts.onDone?.({ merchant: "Amazon", totalAmount: 1, transactionDate: "2026-05-10", lineItems: [] });
    });

    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(Buffer.from("ABANDONED"))], "Order.pdf", { type: "application/pdf" }),
    );
    const res = await app.request("/parse-image/stream", {
      method: "POST",
      headers: { Authorization: auth },
      body: form,
    });
    // Simulate the client going away: cancel the SSE response stream.
    // Hono fires stream.onAbort on cancel.
    const reader = res.body!.getReader();
    await new Promise((r) => setTimeout(r, 30)); // handler registers onAbort + enters parse
    await reader.cancel(); // user navigates away / discards
    await new Promise((r) => setTimeout(r, 30));
    releaseParse(); // parse "completes" after the abort
    await new Promise((r) => setTimeout(r, 30));

    expect(markPendingReady).not.toHaveBeenCalled();
    // ...and the pending entry must be cleaned up, not left stuck
    // "parsing" forever (F1b's reaper only covers "importing").
    expect(removePending).toHaveBeenCalledWith("Order.pdf");
  });
});

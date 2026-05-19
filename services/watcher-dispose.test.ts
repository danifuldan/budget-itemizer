/**
 * disposeSourceFile generalizes moveToProcessed so Discard reuses one
 * collision-safe move/delete path. The disagreement that matters:
 * the user's `deleteAfterImport` retention setting governs BOTH import
 * and discard — delete if they asked, otherwise move to the given
 * keep-dir (created on demand), never the wrong one.
 *
 * Real fs against os.tmpdir() (production calls fs.renameSync/unlinkSync
 * directly); config + watcher's transitive imports mocked, house style.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpInbox: string;
let tmpProcessed: string;
let tmpDiscarded: string;
let cfgDeleteAfterImport = false;

// fs.renameSync can't be vi.spyOn'd (ESM namespace not configurable), so
// partially mock the module: real fs everywhere, but renameSync throws
// EXDEV when the toggle is on. Default off → the other tests use real fs.
const exdev = vi.hoisted(() => ({ on: false }));
vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return {
    ...real,
    default: real,
    renameSync: (src: fs.PathLike, dest: fs.PathLike) => {
      if (exdev.on) {
        const e: any = new Error("EXDEV: cross-device link not permitted");
        e.code = "EXDEV";
        throw e;
      }
      return real.renameSync(src, dest);
    },
  };
});

vi.mock("../utils/env-vars", () => ({ default: { MAX_FILE_SIZE: 5242880 } }));
vi.mock("./config", () => ({
  getConfig: vi.fn(() => ({
    inboxPath: tmpInbox,
    processedPath: tmpProcessed,
    deleteAfterImport: cfgDeleteAfterImport,
    watcherAutoImport: false,
  })),
}));
vi.mock("./receipt", () => ({ parseImageReceiptStream: vi.fn(), importReceipt: vi.fn() }));
vi.mock("./budget-provider", () => ({ BudgetConnectionError: class extends Error {} }));
vi.mock("./history", () => ({ addRecord: vi.fn() }));
vi.mock("./llama-server", () => ({
  isLlamaServerRunning: vi.fn(() => true),
  getLlamaServerStartError: vi.fn(() => null),
  isLlamaServerStarting: vi.fn(() => false),
}));

import { disposeSourceFile, moveToProcessed } from "./watcher";

beforeEach(() => {
  tmpInbox = fs.mkdtempSync(path.join(os.tmpdir(), "disp-inbox-"));
  tmpProcessed = fs.mkdtempSync(path.join(os.tmpdir(), "disp-processed-"));
  // Deliberately NOT created — disposeSourceFile must ensureDir it.
  tmpDiscarded = path.join(tmpProcessed, "discarded");
  cfgDeleteAfterImport = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(tmpInbox, { recursive: true, force: true });
  fs.rmSync(tmpProcessed, { recursive: true, force: true });
});

const seed = (name: string): string => {
  const p = path.join(tmpInbox, name);
  fs.writeFileSync(p, "PDF");
  return p;
};

describe("disposeSourceFile — retention setting governs", () => {
  it("deleteAfterImport=false → moves to keepDir (created on demand), source gone, not unlinked", () => {
    const src = seed("receipt.pdf");
    disposeSourceFile(src, "receipt.pdf", tmpDiscarded);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(tmpDiscarded)).toBe(true);
    expect(fs.readdirSync(tmpDiscarded)).toEqual(["receipt.pdf"]);
  });

  it("deleteAfterImport=true → deletes the source, does NOT create/populate keepDir", () => {
    cfgDeleteAfterImport = true;
    const src = seed("receipt.pdf");
    disposeSourceFile(src, "receipt.pdf", tmpDiscarded);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(tmpDiscarded)).toBe(false);
  });

  it("name collision in keepDir → uniquified, no clobber", () => {
    fs.mkdirSync(tmpDiscarded, { recursive: true });
    fs.writeFileSync(path.join(tmpDiscarded, "receipt.pdf"), "OLD");
    const src = seed("receipt.pdf");
    disposeSourceFile(src, "receipt.pdf", tmpDiscarded);
    const names = fs.readdirSync(tmpDiscarded).sort();
    expect(names).toHaveLength(2);
    expect(fs.readFileSync(path.join(tmpDiscarded, "receipt.pdf"), "utf8")).toBe("OLD");
  });
});

describe("moveToProcessed regression (after generalization)", () => {
  it("deleteAfterImport=false → file lands in processedPath", () => {
    const src = seed("a.pdf");
    moveToProcessed(src, "a.pdf");
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readdirSync(tmpProcessed)).toContain("a.pdf");
  });
  it("deleteAfterImport=true → file deleted, processedPath untouched", () => {
    cfgDeleteAfterImport = true;
    const src = seed("b.pdf");
    moveToProcessed(src, "b.pdf");
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.readdirSync(tmpProcessed)).not.toContain("b.pdf");
  });
});

// Premortem Bug 1: inbox vs keepDir on different volumes (external-drive
// inbox) → fs.renameSync throws EXDEV. Must fall back to copy+unlink so
// the move still succeeds and the receipt isn't lost/bounced. Fixes the
// same latent fragility in the import path (moveToProcessed) too.
describe("disposeSourceFile — cross-device (EXDEV) fallback", () => {
  it("falls back to copy+unlink when rename can't span volumes", () => {
    const src = seed("receipt.pdf");
    exdev.on = true;
    try {
      expect(() => disposeSourceFile(src, "receipt.pdf", tmpDiscarded)).not.toThrow();
      expect(fs.existsSync(src)).toBe(false);
      expect(fs.readdirSync(tmpDiscarded)).toEqual(["receipt.pdf"]);
    } finally {
      exdev.on = false;
    }
  });
});

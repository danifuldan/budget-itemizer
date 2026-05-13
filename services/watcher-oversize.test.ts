// Regression: the HTTP /watcher/inbox route enforces MAX_FILE_SIZE via
// Zod, but the file-watcher path (drag & drop into the inbox folder)
// used to skip the check entirely. A 50MB scanned PDF would be loaded
// fully into memory and pushed through parseImageReceiptStream before
// failing somewhere downstream. queueFile now stat-checks first and
// surfaces an error pending entry without reading the bytes.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Stop parseImageReceiptStream from running for under-limit files —
// we don't want the test parsing a fake PDF.
vi.mock("./receipt", async () => {
  const actual = await vi.importActual<typeof import("./receipt")>("./receipt");
  return {
    ...actual,
    parseImageReceiptStream: vi.fn(async () => {
      throw new Error("test stub: should not parse oversized files");
    }),
  };
});

import {
  queueFile,
  getPending,
  getPendingFiles,
  removePending,
  watcherEvents,
} from "./watcher";

const tempInbox = () => fs.mkdtempSync(path.join(os.tmpdir(), "watcher-oversize-"));

describe("queueFile — file size enforcement", () => {
  let inbox: string;

  beforeEach(() => {
    inbox = tempInbox();
    for (const f of getPendingFiles()) removePending(f.filename);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(inbox, { recursive: true, force: true });
  });

  it("rejects oversized PDFs with an error pending entry and does not read the file", async () => {
    // Default MAX_FILE_SIZE is 5MB. Write 6MB.
    const filePath = path.join(inbox, "huge.pdf");
    const sixMB = Buffer.alloc(6 * 1024 * 1024, 0);
    fs.writeFileSync(filePath, sixMB);

    const events: any[] = [];
    const onQueued = (e: any) => events.push({ type: "file-queued", e });
    const onParsed = (e: any) => events.push({ type: "file-parsed", e });
    watcherEvents.on("file-queued", onQueued);
    watcherEvents.on("file-parsed", onParsed);

    await queueFile(filePath);

    watcherEvents.off("file-queued", onQueued);
    watcherEvents.off("file-parsed", onParsed);

    const entry = getPending("huge.pdf");
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("error");
    expect(entry?.parseError).toMatch(/6\.0 MB/);
    expect(entry?.parseError).toMatch(/max receipt size is 5 MB/);
    // Both events fire so the FE notification flow surfaces the rejection
    // the same way a parse error would.
    expect(events.find((x) => x.type === "file-queued")).toBeDefined();
    expect(events.find((x) => x.type === "file-parsed")).toBeDefined();
  });

  it("ignores files that vanished between fs.watch event and queueFile (no entry created)", async () => {
    const filePath = path.join(inbox, "ghost.pdf");
    // Don't create the file — simulate fs.watch firing on a renamed-away file.

    await queueFile(filePath);

    expect(getPending("ghost.pdf")).toBeUndefined();
  });

  it("skips non-PDF files with no pending entry created", async () => {
    const filePath = path.join(inbox, "note.txt");
    fs.writeFileSync(filePath, "hello");

    await queueFile(filePath);

    expect(getPending("note.txt")).toBeUndefined();
  });
});

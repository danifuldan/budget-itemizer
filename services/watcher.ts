import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import type { Receipt } from "./shared-types";
import { importReceipt, parseImageReceiptStream } from "./receipt";
import { BudgetConnectionError } from "./budget-provider";
import { addRecord } from "./history";
import { getConfig } from "./config";
import env from "../utils/env-vars";

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
};

export interface WatcherStatus {
  running: boolean;
  inboxPath: string | null;
  processedPath: string | null;
  /** True iff the inbox directory currently exists on disk. fs.watch
   *  silently tolerates a missing path and recovers when it appears, so
   *  `running: true` alone is misleading — the UI needs to know if the
   *  path is reachable to surface a useful state. */
  inboxExists: boolean;
}

export interface PendingFile {
  filename: string;
  filePath: string;
  detectedAt: string;
  status: "parsing" | "ready" | "error" | "importing";
  receipt?: Receipt;
  parseError?: string;
  /** Status at the moment `claimForImport` was called — used by
   *  `releaseImportClaim` to restore state when an import fails. */
  preImportStatus?: "ready" | "error";
}

// --- Event bus ---
export const watcherEvents = new EventEmitter();

// --- Pending queue ---
const pendingFiles = new Map<string, PendingFile>();

export const getPendingFiles = (): PendingFile[] => Array.from(pendingFiles.values());

export const removePending = (filename: string): boolean => pendingFiles.delete(filename);

/** Drop pending entries when the user moves their inbox in Settings.
 *  Mid-flight entries (status="importing" or "parsing") are preserved —
 *  their in-flight handlers must reach a terminal state to clean up.
 *  Wiping them here would orphan files or produce ghost ready-entries. */
export const clearAllPending = (): void => {
  for (const [filename, entry] of pendingFiles) {
    if (entry.status === "importing" || entry.status === "parsing") continue;
    pendingFiles.delete(filename);
  }
};

export const getPending = (filename: string): PendingFile | undefined => pendingFiles.get(filename);

/** Reset stale categories on pending receipts after a YNAB reconnect. */
export const revalidatePendingCategories = (validCategories: string[]): { affected: string[] } => {
  // "" is the in-flight "user hasn't picked one" sentinel for line items —
  // detected by the review screen's missing-category warning (App.tsx:512).
  // Always allowed so we don't churn already-uncategorized items.
  const allowed = new Set([...validCategories, ""]);
  const affected: string[] = [];
  for (const entry of pendingFiles.values()) {
    if (entry.status !== "ready" || !entry.receipt) continue;
    const items = entry.receipt.lineItems ?? [];
    let mutated = false;
    for (const item of items) {
      if (item.category && !allowed.has(item.category)) {
        item.category = "";
        mutated = true;
      }
    }
    if (mutated) {
      affected.push(entry.filename);
      // Re-fire `file-parsed` so the FE re-renders the receipt with the
      // cleared categories. Same channel the parser uses for fresh data.
      watcherEvents.emit("file-parsed", { filename: entry.filename, receipt: entry.receipt });
    }
  }
  if (affected.length > 0) {
    console.log(
      `Revalidated pending receipts after YNAB reconnect: ${affected.length} had stale categories cleared.`,
    );
    watcherEvents.emit("categories-revalidated", { affected });
  }
  return { affected };
};

export const addPending = (filename: string, filePath: string): void => {
  const existing = pendingFiles.get(filename);
  if (existing) {
    // Re-upload: refresh path + detectedAt (acts as a version token for DELETE).
    existing.filePath = filePath;
    existing.detectedAt = new Date().toISOString();
    return;
  }
  const entry: PendingFile = {
    filename,
    filePath,
    detectedAt: new Date().toISOString(),
    status: "parsing",
  };
  pendingFiles.set(filename, entry);
  watcherEvents.emit("file-queued", entry);
};

/**
 * Atomically transition a pending entry to "importing" so a second
 * concurrent /import call (e.g., user double-clicks) can't fire a second
 * YNAB submission for the same receipt. Single-threaded JS makes this
 * read-then-write safe without a real mutex — the caller and the check
 * are in the same synchronous turn.
 *
 * Returns false when there's no pending entry, or the entry is in a
 * non-importable state (parsing, already importing). Caller should
 * surface 409 Conflict.
 */
export const claimForImport = (filename: string): boolean => {
  const entry = pendingFiles.get(filename);
  if (!entry) return false;
  if (entry.status !== "ready" && entry.status !== "error") return false;
  entry.preImportStatus = entry.status;
  entry.status = "importing";
  return true;
};

/** Restore a pending entry to its pre-claim state after an import fails. */
export const releaseImportClaim = (filename: string): void => {
  const entry = pendingFiles.get(filename);
  if (!entry || entry.status !== "importing") return;
  entry.status = entry.preImportStatus ?? "ready";
  delete entry.preImportStatus;
};

export const markPendingReady = (filename: string, receipt: Receipt): void => {
  const entry = pendingFiles.get(filename);
  if (!entry) return;
  entry.status = "ready";
  entry.receipt = receipt;
  watcherEvents.emit("file-parsed", { filename, receipt });
};

// --- Move (or delete) source file after successful import ---
// When `deleteAfterImport` is on, the source PDF is unlinked instead of
// archived. Reduces long-term plaintext retention of sensitive receipt
// content (full addresses, last-4 card digits, item lists) in the
// user's home directory. Default is move-to-processed; opt-in destructive.
export const moveToProcessed = (filePath: string, filename: string) => {
  const config = getConfig();
  if (config.deleteAfterImport) {
    try {
      fs.unlinkSync(filePath);
      console.log(`  Deleted source: ${filePath}`);
    } catch (e: any) {
      console.warn(`  Could not delete source: ${e.message}`);
    }
    return;
  }
  const processedDir = config.processedPath;
  if (processedDir) {
    const safeName = path.basename(filename);
    const ext = path.extname(safeName);
    const base = safeName.slice(0, -ext.length || undefined);
    // Find a non-colliding destination. Date.now() alone collides when
    // two imports finish within the same millisecond (possible during a
    // startup burst where multiple Order.pdf duplicates landed in inbox).
    // Loop with an incrementing counter so the second mover never
    // silently overwrites the first.
    let dest = path.join(processedDir, safeName);
    if (fs.existsSync(dest)) {
      const stamp = Date.now();
      let n = 0;
      do {
        const suffix = n === 0 ? `${stamp}` : `${stamp}-${n}`;
        dest = path.join(processedDir, `${base}_${suffix}${ext}`);
        n++;
      } while (fs.existsSync(dest));
    }
    fs.renameSync(filePath, dest);
    console.log(`  Moved to: ${dest}`);
  }
};

let watcher: fs.FSWatcher | null = null;

// Track every setTimeout owned by the watcher subsystem so stopWatcher
// can cancel them. Without this, an fs.watch debounce that fired 800ms
// before "Stop watcher" would still call enqueue() against the now-
// stopped watcher, and recentlyProcessed TTL timeouts would keep the
// event loop alive for 10s past stop. Visible behaviorally: files
// keep getting parsed for ~1s after the user thinks they stopped.
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

const trackedSetTimeout = (
  fn: () => void,
  ms: number,
): ReturnType<typeof setTimeout> => {
  let handle: ReturnType<typeof setTimeout>;
  handle = setTimeout(() => {
    pendingTimers.delete(handle);
    fn();
  }, ms);
  pendingTimers.add(handle);
  return handle;
};

// --- Serial processing queue ---
// All file processing funnels through this queue so only one file is
// parsed / imported at a time, regardless of how many fs.watch events fire.
const fileQueue: string[] = [];
let draining = false;

// Guard against fs.watch double-fire: tracks recently processed filenames
// so the same file isn't processed twice within a short window.
const recentlyProcessed = new Map<string, ReturnType<typeof setTimeout>>();
const DEDUP_TTL_MS = 10_000;

const markProcessed = (filename: string) => {
  // If the watcher has been stopped, skip both the cleanup and the new
  // timer registration. An in-flight `drain()` await can resolve AFTER
  // stopWatcher cleared `pendingTimers`, race back into this function,
  // and add a fresh 10-second timer to the just-cleared Set — keeping
  // the event loop alive past stop. Bail when there's nothing to track.
  if (watcher === null) return;
  if (recentlyProcessed.has(filename)) clearTimeout(recentlyProcessed.get(filename)!);
  recentlyProcessed.set(filename, trackedSetTimeout(() => recentlyProcessed.delete(filename), DEDUP_TTL_MS));
};

const enqueue = (filePath: string) => {
  const filename = path.basename(filePath);
  // Deduplicate: skip if already queued or recently processed
  if (fileQueue.includes(filePath)) return;
  if (recentlyProcessed.has(filename)) return;
  fileQueue.push(filePath);
  drain();
};

const drain = async () => {
  if (draining) return;
  draining = true;
  try {
    while (fileQueue.length > 0) {
      const filePath = fileQueue.shift()!;
      if (!fs.existsSync(filePath)) continue;
      const filename = path.basename(filePath);
      if (recentlyProcessed.has(filename)) continue;
      try {
        await processFile(filePath);
        markProcessed(filename);
      } catch (err) {
        console.error(`Error processing ${filePath}:`, err);
      }
    }
  } finally {
    draining = false;
  }
};

const ensureDirs = (inbox: string, processed: string) => {
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(processed, { recursive: true });
};

const autoImportParsed = async (entry: PendingFile) => {
  const config = getConfig();
  const account = config.defaultAccount;
  if (!account) {
    console.error("No default account configured, skipping auto-import");
    return;
  }

  const receipt = entry.receipt!;
  const filename = entry.filename;

  try {
    await importReceipt(account, receipt);
    console.log(`  Auto-imported to budget (account: ${account})`);

    addRecord({
      filename,
      merchant: receipt.merchant,
      totalAmount: receipt.totalAmount,
      itemCount: receipt.lineItems?.length ?? 0,
      transactionDate: receipt.transactionDate,
      success: true,
      receipt,
    });

    // moveToProcessed has its own failure modes (file removed externally,
    // processed dir read-only) and they're independent of the YNAB
    // submission. Don't let them flow into the outer catch — that would
    // double-record this same import as both succeeded *and* failed.
    try {
      moveToProcessed(entry.filePath, filename);
    } catch (e: any) {
      console.warn(`  Could not move source file for ${filename}: ${e?.message ?? e}`);
    }
    removePending(filename);

    watcherEvents.emit("file-processed", {
      filename,
      merchant: receipt.merchant,
      totalAmount: receipt.totalAmount,
      success: true,
    });
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    console.error(`  Auto-import error for ${filename}:`, err);
    addRecord({
      filename,
      merchant: receipt.merchant || "",
      totalAmount: receipt.totalAmount || 0,
      itemCount: receipt.lineItems?.length ?? 0,
      transactionDate: receipt.transactionDate || new Date().toISOString().split("T")[0],
      success: false,
      error: errorMsg,
    });

    removePending(filename);

    watcherEvents.emit("file-processed", {
      filename,
      merchant: receipt.merchant || "",
      totalAmount: receipt.totalAmount || 0,
      success: false,
    });
  }
};

export const queueFile = async (filePath: string, autoImport = false) => {
  const filename = path.basename(filePath);
  const ext = path.extname(filename).toLowerCase();

  if (ext !== ".pdf") {
    console.warn(`  Skipping non-PDF file: ${filename}`);
    return;
  }

  if (pendingFiles.has(filename)) return;

  // Reject oversized files before reading them into memory. The HTTP
  // upload route enforces this via Zod, but fs-watched drops bypass the
  // route entirely — so a 50MB scan dragged into the inbox folder used
  // to load fully into RAM and balloon parse memory before failing
  // downstream. Surface as an error pending entry so the user sees
  // *why* the file was rejected and can discard it.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err: any) {
    console.warn(`  Skipping ${filename}: cannot stat file (${err?.code ?? err?.message ?? err})`);
    return;
  }
  if (stat.size > env.MAX_FILE_SIZE) {
    const limitMB = env.MAX_FILE_SIZE / 1024 / 1024;
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    const errorMsg = `File is ${sizeMB} MB; max receipt size is ${limitMB} MB. Convert to a smaller PDF or split the receipt before retrying.`;
    const tooBig: PendingFile = {
      filename,
      filePath,
      detectedAt: new Date().toISOString(),
      status: "error",
      parseError: errorMsg,
    };
    pendingFiles.set(filename, tooBig);
    console.warn(`  Skipping oversized file ${filename}: ${errorMsg}`);
    watcherEvents.emit("file-queued", tooBig);
    watcherEvents.emit("file-parsed", { filename, error: errorMsg });
    return;
  }

  const entry: PendingFile = {
    filename,
    filePath,
    detectedAt: new Date().toISOString(),
    status: "parsing",
  };
  pendingFiles.set(filename, entry);
  console.log(`  Queued for review: ${filename}`);
  watcherEvents.emit("file-queued", entry);

  try {
    const buffer = fs.readFileSync(filePath);
    const file = new File([buffer], filename, { type: "application/pdf" });
    const receipt = await parseImageReceiptStream(file, {
      onStatus: (step) => {
        watcherEvents.emit("file-parse-progress", { filename, event: "status", data: { step } });
      },
      onHeader: (header) => {
        watcherEvents.emit("file-parse-progress", { filename, event: "header", data: header });
      },
      onItem: (item) => {
        watcherEvents.emit("file-parse-progress", { filename, event: "item", data: item });
      },
      onTotal: (totals) => {
        watcherEvents.emit("file-parse-progress", { filename, event: "total", data: totals });
      },
      onCategories: (categories) => {
        watcherEvents.emit("file-parse-progress", { filename, event: "categories", data: categories });
      },
    });

    entry.receipt = receipt;
    entry.status = "ready";
    console.log(`  Parsed: ${receipt.merchant} - $${receipt.totalAmount}`);
    watcherEvents.emit("file-parsed", { filename, receipt });

    if (autoImport) {
      await autoImportParsed(entry);
    }
  } catch (err: any) {
    entry.status = "error";
    entry.parseError = err.message || String(err);
    console.error(`  Error parsing ${filename}:`, err);
    watcherEvents.emit("file-parsed", { filename, error: entry.parseError });
  }
};

const processFile = async (filePath: string) => {
  const config = getConfig();
  await queueFile(filePath, !!config.watcherAutoImport);
};

const processInbox = (inboxPath: string) => {
  // Guarded readdir: a permission-restricted inbox (sandboxed Documents
  // folder, disconnected network mount, accidentally-chmod-000 directory)
  // used to throw EACCES out of readdirSync, crashing the entire sidecar
  // process. We log and continue so the rest of the app stays alive — the
  // watcher status will reflect the inaccessible state via inboxExists.
  let entries: string[];
  try {
    entries = fs.readdirSync(inboxPath);
  } catch (err: any) {
    console.error(`Could not read inbox at ${inboxPath}: ${err?.code ?? err?.message ?? err}`);
    return;
  }
  const files = entries
    .filter((f) => path.extname(f).toLowerCase() === ".pdf")
    .map((f) => path.join(inboxPath, f));

  if (files.length === 0) {
    console.log("Inbox is empty.");
    return;
  }

  console.log(`Found ${files.length} PDF(s) in inbox.`);

  for (const file of files) {
    enqueue(file);
  }
};

export const startWatcher = (): WatcherStatus => {
  const config = getConfig();
  const inbox = config.inboxPath;
  const processed = config.processedPath;

  if (!inbox || !processed) {
    console.log("Watcher not started: inbox/processed paths not configured");
    return { running: false, inboxPath: inbox, processedPath: processed, inboxExists: false };
  }

  if (watcher) {
    console.log("Watcher already running");
    return { running: true, inboxPath: inbox, processedPath: processed, inboxExists: fs.existsSync(inbox) };
  }

  ensureDirs(inbox, processed);
  console.log(`Watching ${inbox} for new PDFs...`);

  // Process existing files first (guarded against EACCES inside).
  processInbox(inbox);

  // fs.watch can also throw on permission-restricted or non-existent
  // paths. Catch so the watcher fails closed (running: false) instead of
  // taking the whole sidecar down with it.
  try {
    watcher = fs.watch(inbox, (eventType, filename) => {
      if (!filename || path.extname(filename).toLowerCase() !== ".pdf") return;

      const filePath = path.join(inbox, filename);

      // Small delay to let file finish writing, then enqueue. Tracked so
      // stopWatcher can cancel pending debounces — otherwise a "Stop
      // watcher → change inbox" flow can fire delayed enqueues against
      // the OLD inbox after the watcher was already torn down.
      trackedSetTimeout(() => {
        if (!watcher) return; // watcher was stopped between schedule and fire
        if (!fs.existsSync(filePath)) return;
        enqueue(filePath);
      }, 1000);
    });
  } catch (err: any) {
    console.error(`Could not watch inbox at ${inbox}: ${err?.code ?? err?.message ?? err}`);
    return { running: false, inboxPath: inbox, processedPath: processed, inboxExists: fs.existsSync(inbox) };
  }

  return { running: true, inboxPath: inbox, processedPath: processed, inboxExists: fs.existsSync(inbox) };
};

export const stopWatcher = () => {
  if (watcher) {
    watcher.close();
    watcher = null;
    fileQueue.length = 0;
    // Cancel every tracked setTimeout (fs.watch debounces + dedup TTLs).
    // Without this, pending timers keep firing for up to 10s after stop.
    for (const t of pendingTimers) clearTimeout(t);
    pendingTimers.clear();
    recentlyProcessed.clear();
    console.log("Watcher stopped.");
  }
};

export const getWatcherStatus = (): WatcherStatus => {
  const config = getConfig();
  return {
    running: watcher !== null,
    inboxPath: config.inboxPath,
    processedPath: config.processedPath,
    inboxExists: !!config.inboxPath && fs.existsSync(config.inboxPath),
  };
};

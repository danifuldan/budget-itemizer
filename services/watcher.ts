import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import type { Receipt } from "./shared-types";
import { importReceipt, parseImageReceiptStream } from "./receipt";
import { isLlamaServerRunning, getLlamaServerStartError, isLlamaServerStarting } from "./llama-server";
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
  /** When `claimForImport` set status to "importing". A claim with no
   *  terminal within STALE_CLAIM_MS is reaped (the /import that owned it
   *  died without releasing). */
  claimedAt?: number;
}

// --- Event bus ---
export const watcherEvents = new EventEmitter();

// --- Pending queue ---
const pendingFiles = new Map<string, PendingFile>();

/** A claim with no terminal (success → removePending / failure →
 *  releaseImportClaim) within this bound means the /import that owned it
 *  died (network drop, app backgrounded, or autoImportParsed bailed to a
 *  manual import that then died). Far longer than any real import
 *  (YNAB 30s timeout + retries). Reaped on the next pending poll so the
 *  receipt becomes actionable again instead of stuck forever (F1b).
 *  Safe to retry after reap: F2's import_id dedupes a re-create. */
const STALE_CLAIM_MS = 120_000;

const reapStaleClaims = (): void => {
  const now = Date.now();
  for (const entry of pendingFiles.values()) {
    if (
      entry.status === "importing" &&
      entry.claimedAt !== undefined &&
      now - entry.claimedAt > STALE_CLAIM_MS
    ) {
      console.warn(
        `  Reaping stale import claim for ${entry.filename} (no terminal in ${STALE_CLAIM_MS}ms)`,
      );
      entry.status = entry.preImportStatus ?? "ready";
      delete entry.preImportStatus;
      delete entry.claimedAt;
    }
  }
};

export const getPendingFiles = (): PendingFile[] => {
  reapStaleClaims();
  return Array.from(pendingFiles.values());
};

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
    // A claimed import is in flight for this filename. /import has
    // already snapshotted claimedFilePath; mutating filePath here would,
    // on import success + removePending, orphan the re-uploaded bytes
    // with no entry and no claim → the watcher re-imports them
    // (duplicate transaction, F5). Leave the in-flight entry untouched —
    // the re-upload is handled as its own arrival via the watcher's
    // identity-keyed dedup once the claim resolves.
    if (existing.status === "importing") return;
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
  entry.claimedAt = Date.now();
  return true;
};

/** Restore a pending entry to its pre-claim state after an import fails. */
export const releaseImportClaim = (filename: string): void => {
  const entry = pendingFiles.get(filename);
  if (!entry || entry.status !== "importing") return;
  entry.status = entry.preImportStatus ?? "ready";
  delete entry.preImportStatus;
  delete entry.claimedAt;
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

/**
 * Identity key for dedup. Keyed on name + size + mtime, NOT bare basename:
 * Amazon order invoices are always "Order.pdf", so a basename-only key
 * silently suppressed a genuinely different second Order.pdf dropped
 * within DEDUP_TTL_MS (F4 — a receipt's money never entered the budget).
 * A same-event refire of the SAME file has identical size+mtime → same
 * key (still deduped); a different file differs in size and/or mtime →
 * different key (processed). Returns null if the file vanished.
 */
export const fileDedupKey = (filePath: string): string | null => {
  try {
    const s = fs.statSync(filePath);
    return `${path.basename(filePath)}:${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
};

/**
 * Resolve once the file's size has stopped changing (two consecutive
 * stats equal across `intervalMs`), i.e. the copy/write has settled.
 * Returns false if the file vanished (renamed away mid-copy). A slow
 * multi-MB receipt on a network/iCloud inbox used to be parsed while
 * still being written → truncated parse + wrong total, AND — since the
 * F4 identity key is size/mtime-based — the settled file got a new key
 * and was processed a SECOND time (duplicate import). Gating drain on
 * this means the dedup key is computed on the SETTLED identity, so a
 * post-settle fs.watch refire dedupes correctly.
 */
export const waitUntilStable = async (
  filePath: string,
  opts: { intervalMs?: number; maxMs?: number } = {},
): Promise<boolean> => {
  const intervalMs = opts.intervalMs ?? 600;
  const maxMs = opts.maxMs ?? 15_000;
  const started = Date.now();
  let prev = -1;
  for (;;) {
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return false; // vanished / renamed away mid-copy
    }
    if (size === prev) return true; // unchanged across one interval → settled
    // Best-effort cap: a file that never settles within maxMs is
    // pathological; attempt the parse (its own error path handles a bad
    // PDF) rather than silently drop the receipt forever.
    if (Date.now() - started > maxMs) return true;
    prev = size;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
};

const markProcessed = (key: string) => {
  // If the watcher has been stopped, skip both the cleanup and the new
  // timer registration. An in-flight `drain()` await can resolve AFTER
  // stopWatcher cleared `pendingTimers`, race back into this function,
  // and add a fresh 10-second timer to the just-cleared Set — keeping
  // the event loop alive past stop. Bail when there's nothing to track.
  if (watcher === null) return;
  if (recentlyProcessed.has(key)) clearTimeout(recentlyProcessed.get(key)!);
  recentlyProcessed.set(key, trackedSetTimeout(() => recentlyProcessed.delete(key), DEDUP_TTL_MS));
};

const enqueue = (filePath: string) => {
  // Deduplicate: skip if this exact path is already queued, or this
  // file's identity (see fileDedupKey) was recently processed.
  if (fileQueue.includes(filePath)) return;
  const key = fileDedupKey(filePath);
  if (key && recentlyProcessed.has(key)) return;
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
      // Wait for the copy/write to settle BEFORE keying or parsing.
      // Keeps the parse off a truncated file and makes the identity key
      // the settled one (so a later refire of the same file dedupes).
      if (!(await waitUntilStable(filePath))) continue;
      // Compute the identity key NOW (settled), while the file is still
      // in the inbox — by the time processFile resolves, auto-import may
      // have moved it to processed and stat would fail.
      const key = fileDedupKey(filePath);
      if (key && recentlyProcessed.has(key)) continue;
      try {
        await processFile(filePath);
        if (key) markProcessed(key);
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

export const autoImportParsed = async (entry: PendingFile) => {
  const config = getConfig();
  const account = config.ynabAccountId;
  if (!account) {
    console.error("No account configured, skipping auto-import");
    return;
  }

  const receipt = entry.receipt!;
  const filename = entry.filename;

  // Atomically claim before submitting. By the time we get here the
  // `file-parsed` event has already flipped the FE row to a clickable
  // "ready", so a manual Quick-Import can race us. claimForImport is the
  // same gate /import uses; if it fails another path already owns this
  // receipt — bail rather than double-submit to the budget provider.
  // (Both terminal paths below removePending, consuming the claim;
  // auto-import failure removes the entry, so no releaseImportClaim —
  // consistent with this function's existing remove-on-failure behavior.)
  if (!claimForImport(filename)) {
    console.log(`  Auto-import skipped for ${filename}: already claimed by another import`);
    return;
  }

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

  // Drops during LLM warmup arrive before llama-server's health check
  // returns. Without this wait, parseImageReceiptStream throws on its
  // first callLLM. Poll until the server's up; the entry sits in the
  // pending list as "parsing" the whole time, and the FE shows a
  // "Loading AI model" hint when status.llmReady is false.
  //
  // Bounded, deliberately: a recorded start error (OOM, missing/corrupt
  // model) means the server will NEVER come up, and an absolute cap well
  // past the ~180s health-check window guards the pathological "start
  // hung without throwing" case. Either way surface an error entry
  // instead of polling every 1s forever (was: unbounded `while
  // (!running)` — a permanent start failure wedged the queue, kept the
  // entry stuck in "parsing", and pinned the event loop indefinitely).
  const WARMUP_POLL_MS = 1_000;
  const WARMUP_MAX_MS = 300_000;
  const waitStarted = Date.now();
  while (!isLlamaServerRunning()) {
    // While a start is genuinely underway, never terminate — wait it out.
    // It's internally bounded (pollHealth has a 180s timeout, after which
    // it throws → lastStartError set, `starting` cleared → the next poll
    // sees the not-starting terminal case). This is what keeps a file
    // dropped mid-restart (lastStartError lingers across the failed-
    // attempt gap and the model-switch stop phase) AND a slow/suspended
    // warmup (wall clock can jump past the cap) from being wrongly
    // errored while the server is actually coming up.
    if (!isLlamaServerStarting()) {
      const startErr = getLlamaServerStartError();
      const timedOut = Date.now() - waitStarted > WARMUP_MAX_MS;
      if (startErr || timedOut) {
        entry.status = "error";
        entry.parseError = startErr
          ? `AI model failed to start: ${startErr}. Open Settings → AI Model, then re-drop the file.`
          : "AI model didn't become ready in time. Open Settings → AI Model, then re-drop the file.";
        console.error(`  ${filename}: ${entry.parseError}`);
        watcherEvents.emit("file-parsed", { filename, error: entry.parseError });
        return;
      }
    }
    await new Promise((r) => setTimeout(r, WARMUP_POLL_MS));
  }

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

export interface WatcherBootDeps {
  isSetupComplete: () => boolean;
  getConfig: () => { watcherEnabled?: boolean };
  startWatcher: () => WatcherStatus;
}

// Boot wiring, injectable for the same reason runStartupAccountMigration
// is: thin orchestration with a real contract. Deliberately takes NO LLM
// signal — the watcher does not depend on llama-server (queueFile waits
// for it before parsing), so gating the watcher start on llmReady only
// produced a false "inbox unreachable" status during model warmup and
// hid pending entries for receipts dropped while loading. Returns the
// status when started, null when intentionally not started.
export const startWatcherOnBoot = (deps: WatcherBootDeps): WatcherStatus | null => {
  if (!deps.isSetupComplete()) {
    console.log("Setup incomplete — watcher not started. Configure via /setup endpoints.");
    return null;
  }
  if (deps.getConfig().watcherEnabled === false) {
    console.log("Watcher disabled in config — not started.");
    return null;
  }
  // startWatcher() can throw before its own fs.watch try/catch (e.g.
  // ensureDirs()/processInbox() on an unreachable inbox — unplugged
  // volume at launch). This runs on the serve-bind path immediately
  // before runStartupAccountMigration; never let a throw escape and
  // reject the bind callback (which would also skip the migration).
  // Fail closed, same never-throws-at-boot contract the migration has.
  let status: WatcherStatus;
  try {
    status = deps.startWatcher();
  } catch (err) {
    console.error(
      `Watcher failed to start: ${err instanceof Error ? err.message : err}. ` +
        `Inbox may be unreachable — check Settings.`,
    );
    return null;
  }
  if (status.running) {
    console.log(`Watcher active: ${status.inboxPath}`);
  }
  return status;
};

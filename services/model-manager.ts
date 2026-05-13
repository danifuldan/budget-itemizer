import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

const MODELS_DIR = path.join(os.homedir(), ".config", "budget-itemizer", "models");

export type ModelRole = "text";

export interface ModelDef {
  id: string;
  name: string;
  size: string;       // human-readable, e.g. "2.3 GB"
  sizeBytes: number;
  url: string;
  filename: string;
  license: string;
  role: ModelRole;
  /** SHA-256 of the file content. When present, the downloader hashes
   *  the partial after download and refuses to activate the model if
   *  it doesn't match — closes the MITM-replaces-blob attack. Omit
   *  only if the upstream repo doesn't publish a verifiable hash. */
  sha256?: string;
}

export const AVAILABLE_MODELS: ModelDef[] = [
  {
    id: "llama3.1-8b",
    name: "Llama 3.1 8B (Recommended)",
    size: "4.9 GB",
    sizeBytes: 4_920_000_000,
    url: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    filename: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    license: "Llama 3.1 Community",
    role: "text",
    sha256: "7b064f5842bf9532c91456deda288a1b672397a54fa729aa665952863033557c",
  },
];

let activeDownload: AbortController | null = null;

interface InFlightDownload {
  promise: Promise<void>;
  // All onProgress callbacks subscribed to this download. The first
  // caller registers theirs at start; subsequent callers (Settings page
  // open while SetupWizard also clicks Download) attach here so each
  // SSE response sees the same progress events. Pre-fix, only the first
  // caller's callback was wired and second-and-later clients sat at 0%.
  subscribers: Set<ProgressCallback>;
}

const inFlightDownloads = new Map<string, InFlightDownload>();

function ensureModelsDir(): void {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
}

export function getModelPath(modelId: string): string | null {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!model) return null;
  const p = path.join(MODELS_DIR, model.filename);
  return fs.existsSync(p) ? p : null;
}

export function isModelDownloaded(modelId: string): boolean {
  return getModelPath(modelId) !== null;
}

export interface DownloadProgress {
  modelId: string;
  downloaded: number;
  total: number;
  percent: number;
  done: boolean;
  error?: string;
}

export type ProgressCallback = (progress: DownloadProgress) => void | Promise<void>;

const MAX_NO_PROGRESS_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

interface AttemptResult {
  /** Did this attempt finish receiving exactly `total` bytes? */
  complete: boolean;
  /** The expected final file size as reported by the server. null when
   *  the server returned 416 (no content-length to learn from). */
  total: number | null;
}

/** Run one download attempt against the partial file. Throws on
 *  non-recoverable errors (HTTP 4xx, user cancel). Returns
 *  `complete: false` when the stream was interrupted or closed
 *  prematurely so the caller can retry. */
async function downloadAttempt(
  model: ModelDef,
  partialPath: string,
  signal: AbortSignal,
  onProgress: ProgressCallback,
): Promise<AttemptResult> {
  const existingBytes = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;

  const headers: Record<string, string> = {};
  if (existingBytes > 0) headers["Range"] = `bytes=${existingBytes}-`;

  const response = await fetch(model.url, { headers, signal, redirect: "follow" });

  if (response.status === 416) {
    // Range not satisfiable — partial file is already complete or larger
    // than expected. Caller validates size before rename.
    return { complete: true, total: null };
  }
  if (!response.ok && response.status !== 206) {
    // Non-recoverable HTTP error — don't retry
    const err: any = new Error(`Download failed: HTTP ${response.status}`);
    err.fatal = true;
    throw err;
  }

  const contentLength = parseInt(response.headers.get("content-length") || "0");
  const total = existingBytes + contentLength;

  const fileStream = fs.createWriteStream(partialPath, { flags: existingBytes > 0 ? "a" : "w" });
  const reader = response.body!.getReader();
  let downloaded = existingBytes;
  let lastEmit = 0;

  // We must await the stream's "finish" before the caller statSyncs the
  // partial. Without this, fileStream.close() returns before bytes are
  // flushed and the size check sees stale data.
  const flushed = new Promise<void>((resolve, reject) => {
    fileStream.once("finish", () => resolve());
    fileStream.once("error", reject);
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
      downloaded += value.byteLength;
      const now = Date.now();
      if (now - lastEmit >= 500) {
        lastEmit = now;
        const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        await onProgress({ modelId: model.id, downloaded, total, percent, done: false });
      }
    }
    fileStream.end();
    await flushed;
    // Premature close: the stream signalled end-of-data before the
    // promised content-length arrived. Treat as recoverable so the
    // retry loop reconnects and resumes.
    if (downloaded !== total) return { complete: false, total };
    return { complete: true, total };
  } catch (err: any) {
    fileStream.end();
    // Best-effort wait for any pending writes to land before the next
    // attempt opens its own stream against the same path.
    await flushed.catch(() => {});
    if (err.name === "AbortError") {
      // User cancelled — bubble up, don't retry
      err.cancelled = true;
      throw err;
    }
    // Network error mid-stream — caller will retry from new partial size
    return { complete: false, total };
  }
}

export async function downloadModel(
  modelId: string,
  onProgress: ProgressCallback,
): Promise<void> {
  // Coalesce concurrent calls for the same model. Two simultaneous
  // calls would otherwise race on the same .partial file: their write
  // streams would interleave and corrupt the download. Subsequent
  // callers subscribe to the same fan-out so each SSE response gets
  // the full progress stream including the terminal done event.
  // Different models can still download concurrently.
  const existing = inFlightDownloads.get(modelId);
  if (existing) {
    existing.subscribers.add(onProgress);
    try {
      await existing.promise;
    } finally {
      existing.subscribers.delete(onProgress);
    }
    return;
  }

  const subscribers = new Set<ProgressCallback>([onProgress]);
  // Fan-out: each progress tick invokes every current subscriber. We
  // snapshot the subscriber list on each tick so a late-joining caller
  // gets subsequent events, and a subscriber that disconnects mid-flight
  // (SSE client closed) is dropped on its next finally.
  const fanOut: ProgressCallback = async (progress) => {
    for (const sub of [...subscribers]) {
      try {
        await sub(progress);
      } catch (err) {
        // One subscriber's failure (closed SSE pipe, FE crash) must not
        // block the others.
        console.warn(`[downloadModel] subscriber threw on progress event:`, err);
      }
    }
  };

  const promise = doDownload(modelId, fanOut);
  inFlightDownloads.set(modelId, { promise, subscribers });
  try {
    await promise;
  } finally {
    inFlightDownloads.delete(modelId);
  }
}

async function doDownload(modelId: string, onProgress: ProgressCallback): Promise<void> {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!model) throw new Error(`Unknown model: ${modelId}`);

  ensureModelsDir();

  const finalPath = path.join(MODELS_DIR, model.filename);
  if (fs.existsSync(finalPath)) {
    await onProgress({ modelId, downloaded: model.sizeBytes, total: model.sizeBytes, percent: 100, done: true });
    return;
  }

  const partialPath = finalPath + ".partial";

  if (activeDownload) activeDownload.abort();
  activeDownload = new AbortController();
  const { signal } = activeDownload;

  // Retry policy: unlimited retries as long as the partial file is
  // growing between attempts. Bail only after MAX_NO_PROGRESS_RETRIES
  // consecutive attempts that don't add any bytes — that's when we're
  // truly stuck (HF unreachable, disk full, etc.) rather than just on
  // a flaky connection that drops every few hundred MB.
  let noProgressStreak = 0;
  // The first response that carries a content-length establishes the
  // expected final size. Used to validate the partial before rename so
  // we never publish a short file as a complete model.
  let expectedTotal: number | null = null;
  while (true) {
    const beforeBytes = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;

    let success = false;
    try {
      const result = await downloadAttempt(model, partialPath, signal, onProgress);
      success = result.complete;
      if (result.total !== null && expectedTotal === null) {
        expectedTotal = result.total;
      }
    } catch (err: any) {
      if (err.cancelled) {
        onProgress({ modelId, downloaded: beforeBytes, total: model.sizeBytes, percent: 0, done: false, error: "cancelled" });
        return;
      }
      if (err.fatal) throw err;
      // Network mid-stream error — fall through to retry logic
    }
    if (success) break;

    const afterBytes = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
    if (afterBytes > beforeBytes) {
      noProgressStreak = 0;
    } else {
      noProgressStreak++;
    }

    if (noProgressStreak >= MAX_NO_PROGRESS_RETRIES) {
      throw new Error(`Download stalled — couldn't make progress after ${MAX_NO_PROGRESS_RETRIES} consecutive attempts. Your partial download is preserved; click Download again later.`);
    }

    // Exponential backoff scaled by how stuck we are. Race against the
    // abort signal so a Cancel click during a 16s/30s backoff sleep
    // returns immediately instead of making the user wait it out.
    const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** noProgressStreak, 30000);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, backoff);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    if (signal.aborted) {
      const downloaded = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
      onProgress({ modelId, downloaded, total: model.sizeBytes, percent: 0, done: false, error: "cancelled" });
      return;
    }
  }

  // Defense-in-depth: even if the loop reports success, verify the
  // partial really is the full size. Catches any path where the loop
  // can exit while bytes are still missing.
  if (expectedTotal !== null) {
    const actualSize = fs.statSync(partialPath).size;
    if (actualSize !== expectedTotal) {
      try { fs.unlinkSync(partialPath); } catch {}
      activeDownload = null;
      throw new Error(`Download verification failed: file is ${actualSize} bytes but the server reported ${expectedTotal}. The corrupt partial has been deleted; please retry.`);
    }
  }

  // SHA-256 integrity check. Catches a same-length blob substitution
  // (CDN compromise, MITM with forged cert, or upstream-repo tamper).
  // Streamed hashing so the 4.9 GB Llama file doesn't get slurped into
  // memory. Only enforced when a pinned hash is present in the ModelDef.
  if (model.sha256) {
    const hash = crypto.createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(partialPath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });
    const digest = hash.digest("hex");
    if (digest !== model.sha256) {
      try { fs.unlinkSync(partialPath); } catch {}
      activeDownload = null;
      throw new Error(
        `Model integrity check failed: SHA-256 mismatch for ${model.filename} ` +
        `(got ${digest.slice(0, 12)}…, expected ${model.sha256.slice(0, 12)}…). ` +
        `The download has been deleted; please retry from a trusted network.`
      );
    }
  }

  fs.renameSync(partialPath, finalPath);
  await onProgress({ modelId, downloaded: model.sizeBytes, total: model.sizeBytes, percent: 100, done: true });
  activeDownload = null;
}

export function cancelDownload(): void {
  if (activeDownload) {
    activeDownload.abort();
    activeDownload = null;
  }
}

export function deleteModel(modelId: string): void {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!model) return;
  const p = path.join(MODELS_DIR, model.filename);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const partial = p + ".partial";
  if (fs.existsSync(partial)) fs.unlinkSync(partial);
}

export function getModelsStatus(): { id: string; downloaded: boolean; path: string | null }[] {
  return AVAILABLE_MODELS.map((m) => ({
    id: m.id,
    downloaded: isModelDownloaded(m.id),
    path: getModelPath(m.id),
  }));
}

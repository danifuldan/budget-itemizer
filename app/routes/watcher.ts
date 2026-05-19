import * as fs from "fs";
import * as path from "path";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import env from "../../utils/env-vars";
import { auth, sseAuth } from "../middleware";
import { sanitizeReceiptFilename } from "../sanitize";
import { getConfig } from "../../services/config";
import {
  startWatcher,
  stopWatcher,
  watcherEvents,
  getPendingFiles,
  getPending,
  removePending,
  disposeSourceFile,
  abortParse,
  queueFile,
} from "../../services/watcher";

const watcher = new Hono();

watcher.get("/events", sseAuth, async (c) => {
  return streamSSE(c, async (stream) => {
    const onQueued = (data: unknown) => {
      stream.writeSSE({ event: "file-queued", data: JSON.stringify(data) }).catch(() => {});
    };
    const onParsed = (data: unknown) => {
      stream.writeSSE({ event: "file-parsed", data: JSON.stringify(data) }).catch(() => {});
    };
    const onProcessed = (data: unknown) => {
      stream.writeSSE({ event: "file-processed", data: JSON.stringify(data) }).catch(() => {});
    };
    const onProgress = (data: unknown) => {
      stream.writeSSE({ event: "file-parse-progress", data: JSON.stringify(data) }).catch(() => {});
    };

    watcherEvents.on("file-queued", onQueued);
    watcherEvents.on("file-parsed", onParsed);
    watcherEvents.on("file-processed", onProcessed);
    watcherEvents.on("file-parse-progress", onProgress);

    // Keep connection alive until client disconnects.
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
      watcherEvents.off("file-queued", onQueued);
      watcherEvents.off("file-parsed", onParsed);
      watcherEvents.off("file-processed", onProcessed);
      watcherEvents.off("file-parse-progress", onProgress);
    });

    // Heartbeat. Without the aborted check, a reload-storm leaks one
    // setTimeout + closure per connection until the writeSSE eventually
    // throws on the closed pipe.
    while (!aborted) {
      await stream.writeSSE({ event: "ping", data: "{}" });
      await new Promise((r) => setTimeout(r, 30000));
    }
  });
});

watcher.get("/pending", auth, async (c) => {
  return c.json(getPendingFiles(), 200);
});

watcher.delete("/pending/:filename", auth, async (c) => {
  // Defense-in-depth: even though pendingFiles is hash-keyed (a `..`
  // filename can't escape via the map), re-sanitize so any future code
  // path that builds a filesystem path from this param can't be tricked.
  const filename = path.basename(c.req.param("filename"));
  const expectedToken = c.req.query("detectedAt");

  const pending = getPending(filename);
  if (!pending) {
    return c.json({ error: "File not found in pending queue" }, 404);
  }

  // Concurrency guard against the DELETE-vs-POST race: if a re-upload
  // happened between the FE rendering this entry and the user clicking
  // Discard, addPending will have refreshed detectedAt. The user's
  // intent was to discard the *old* version they saw; we refuse rather
  // than silently delete the new file. Stale FE → 409 → refresh → retry.
  if (expectedToken && expectedToken !== pending.detectedAt) {
    return c.json(
      { error: "File was re-uploaded after you opened this view. Refresh and try again." },
      409,
    );
  }

  // Cancel any in-flight parse for this entry first — otherwise the LLM
  // call would keep running on the abandoned file, pinning a llama slot
  // until it completes. queueFile's catch treats AbortError as a quiet
  // cancellation (not an error entry).
  if (pending.status === "parsing") {
    abortParse(filename);
  }

  // Discard disposes of the source the SAME way a successful import does
  // (disposeSourceFile honors the deleteAfterImport retention setting):
  // delete only if the user opted into not retaining receipt plaintext,
  // otherwise MOVE it to processed/discarded/ — never destroy it on a
  // cancel/failure against the user's stated preference.
  const processedPath = getConfig().processedPath;
  if (!processedPath) {
    // Unreachable in practice (setup requires processedPath). Don't
    // delete; just clear the queue entry.
    console.warn(`No processedPath; discarding ${filename} without relocating its file`);
    removePending(filename);
    return c.json({ success: true }, 200);
  }
  try {
    disposeSourceFile(pending.filePath, filename, path.join(processedPath, "discarded"));
  } catch (e: any) {
    // Move failed (cross-device / perms). Do NOT removePending — keep the
    // queue reflecting it so the receipt isn't silently lost.
    console.warn(`Could not dispose discarded file ${filename}: ${e.message}`);
    return c.json({ error: "Could not move the file out of the inbox" }, 500);
  }
  removePending(filename);
  return c.json({ success: true }, 200);
});

watcher.post("/inbox", auth, zValidator(
  "form",
  z.object({
    file: z
      .instanceof(File)
      .refine(
        (f) => f.size <= env.MAX_FILE_SIZE,
        `Max file size is ${env.MAX_FILE_SIZE / 1024 / 1024}MB`
      )
      .refine((f) => f.type === "application/pdf", "Only PDF files are accepted"),
  })
), async (c) => {
  const { file } = c.req.valid("form");
  const config = getConfig();
  const inboxPath = config.inboxPath;
  if (!inboxPath) {
    return c.json({ error: "Inbox path not configured" }, 400);
  }

  const safeFilename = sanitizeReceiptFilename(file.name);
  if (!safeFilename) {
    return c.json({ error: "Filename could not be sanitized to a safe name." }, 400);
  }
  const destPath = path.join(inboxPath, safeFilename);
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.mkdirSync(inboxPath, { recursive: true });
  fs.writeFileSync(destPath, buffer);
  // Drive the parse pipeline directly. Pre-fix, this called addPending
  // which inserted a status="parsing" entry — and then queueFile
  // (invoked by fs.watch ~1s later) saw `pendingFiles.has(filename)`
  // and bailed, leaving the entry stuck at "parsing" forever. By
  // calling queueFile directly we ensure a parse actually runs and
  // transitions the entry to ready/error normally. Fire-and-forget
  // because queueFile already routes its own errors into the pending
  // entry's parseError; the HTTP response for this upload doesn't
  // need to wait on the LLM. fs.watch's later fire is a no-op
  // because queueFile's `pendingFiles.has` early-return covers it.
  void queueFile(destPath, !!config.watcherAutoImport);

  return c.json({ success: true, filename: safeFilename }, 200);
});

watcher.post("/start", auth, async (c) => {
  const status = startWatcher();
  return c.json(status, 200);
});

watcher.post("/stop", auth, async (c) => {
  stopWatcher();
  return c.json({ success: true }, 200);
});

export default watcher;

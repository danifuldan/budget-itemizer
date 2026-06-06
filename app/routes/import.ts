import * as fs from "fs";
import * as path from "path";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { streamSSE } from "hono/streaming";
import env from "../../utils/env-vars";
import { auth } from "../middleware";
import { sanitizeReceiptFilename } from "../sanitize";
import { rateLimitOr500 } from "../error-mapping";
import { getConfig } from "../../services/config";
import {
  parseImageReceiptStream,
  importReceiptToYnab,
} from "../../services/receipt";
import type { Receipt } from "../../services/shared-types";
import {
  addPending,
  markPendingReady,
  moveToProcessed,
  getPending,
  removePending,
  claimForImport,
  releaseImportClaim,
} from "../../services/watcher";
import { addRecord } from "../../services/history";

const importRoutes = new Hono();

importRoutes.post(
  "/parse-image/stream",
  auth,
  zValidator(
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
  ),
  async (c) => {
    const { file } = c.req.valid("form");

    // Save dropped file to inbox so the watcher lifecycle manages it
    const config = getConfig();
    const inboxPath = config.inboxPath;
    const safeFilename = sanitizeReceiptFilename(file.name);
    if (!safeFilename) {
      return c.json({ error: "Filename could not be sanitized to a safe name." }, 400);
    }
    let pendingName = safeFilename;
    if (inboxPath) {
      try {
        fs.mkdirSync(inboxPath, { recursive: true });
        const buffer = Buffer.from(await file.arrayBuffer());
        let destPath = path.join(inboxPath, pendingName);
        if (fs.existsSync(destPath)) {
          // A DIFFERENT unimported receipt already holds this name
          // (Amazon order invoices are always "Order.pdf"). Uniquify so
          // we persist THESE bytes and never adopt or destroy the
          // existing file / its pending entry.
          const ext = path.extname(safeFilename);
          const base = path.basename(safeFilename, ext);
          let n = 1;
          do {
            pendingName = `${base}-${n}${ext}`;
            destPath = path.join(inboxPath, pendingName);
            n++;
          } while (fs.existsSync(destPath) && n < 1000);
          if (fs.existsSync(destPath)) {
            pendingName = `${base}-${Date.now()}${ext}`;
            destPath = path.join(inboxPath, pendingName);
          }
        }
        fs.writeFileSync(destPath, buffer);
        addPending(pendingName, destPath);
      } catch (e: any) {
        console.warn(`Could not save to inbox: ${e.message}`);
      }
    }

    return streamSSE(c, async (stream) => {
      // If the client navigates away / discards mid-parse, the request
      // aborts. Without this guard the server keeps parsing and onDone
      // calls markPendingReady — resurrecting a receipt the user
      // explicitly abandoned as a clickable "ready" row (F3). Mirror the
      // watcher route's onAbort handling.
      let aborted = false;
      const controller = new AbortController();
      stream.onAbort(() => {
        aborted = true;
        // Cancel the in-flight parse so the LLM call stops promptly and
        // frees its slot, instead of running to completion on a receipt
        // the user already abandoned. (Pre-step-3, the parse kept running
        // and only the FE result was suppressed.)
        controller.abort();
        // Drop the entry — the user abandoned it. Idempotent if an
        // explicit Discard already DELETEd it.
        removePending(pendingName);
      });

      // Queue writes so sync callbacks from IncrementalLabelParser
      // don't race on the async SSE stream
      let writeChain = Promise.resolve();
      const writeEvent = (event: string, data: unknown) => {
        if (aborted) return;
        writeChain = writeChain.then(() =>
          stream.writeSSE({ event, data: JSON.stringify(data) })
        );
      };

      try {
        await parseImageReceiptStream(
          file,
          {
            onStatus: (step, detail) => writeEvent("status", { step, ...detail }),
            onHeader: (header) => writeEvent("header", header),
            onTotal: (totals) => writeEvent("total", totals),
            onItem: (item) => writeEvent("item", item),
            onCategories: (categories) => writeEvent("categories", { categories }),
            onDone: (receipt) => {
              // User abandoned this parse — do not resurrect it.
              if (aborted) return;
              markPendingReady(pendingName, receipt);
              writeEvent("done", { receipt });
            },
            onError: (error, step) => writeEvent("error", { message: error.message, step }),
          },
          controller.signal,
        );
        // Flush any queued writes
        await writeChain;
      } catch (err: any) {
        // Intentional cancellation (client disconnected) — suppress the
        // noisy error log and don't write an error event to a stream the
        // FE already abandoned. Gate ONLY on `aborted` (set by
        // stream.onAbort), NOT on err.name === "AbortError" — the 120s
        // fetch safety-timeout also surfaces as AbortError but isn't a
        // user cancellation; it must fall through to surface an error
        // event so the FE shows feedback (premortem Bug 1).
        if (aborted) {
          await writeChain;
          return;
        }
        console.error("Error in streaming receipt parse:", err);
        writeEvent("error", {
          message: err.message || "An unknown error occurred.",
          step: "unknown",
        });
        await writeChain;
      }
    });
  }
);

importRoutes.post(
  "/import",
  auth,
  zValidator(
    "json",
    z.object({
      account: z.string().nonempty(),
      receipt: z.object({
        merchant: z.string(),
        transactionDate: z.string(),
        memo: z.string(),
        totalAmount: z.number(),
        category: z.string(),
        lineItems: z
          .array(
            z.object({
              productName: z.string(),
              quantity: z.number().optional(),
              lineItemTotalAmount: z.number(),
              category: z.string(),
            })
          )
          .optional(),
        tax: z.number().optional(),
        shipping: z.number().optional(),
        fees: z.number().optional(),
        discount: z.number().optional(),
        credit: z.number().optional(),
        creditLabel: z.string().optional(),
        refund: z.number().optional(),
      }),
      sourceFilename: z.string().optional(),
    })
  ),
  async (c) => {
    const { account, receipt, sourceFilename } = c.req.valid("json");

    // Only a live watcher/pending entry participates in the import claim.
    // A history re-import sends the original sourceFilename, but that file
    // is no longer pending (it was processed and removed), so claimForImport
    // would find no entry and return false — 409ing EVERY history re-import.
    // Treat "not in the pending map" like a manual upload: skip the claim,
    // import anyway (the FE de-dupes via button-disable), and leave the
    // watcher's move/remove/release paths below untouched. Capture the
    // entry before the await (and before the claim mutates its status) so a
    // mid-flight inbox change can't wipe the filePath we need to clean up.
    const pendingEntry = sourceFilename ? getPending(sourceFilename) : undefined;

    // Idempotency: if this import is associated with a watcher pending
    // entry, atomically claim it. A second concurrent call (double-click,
    // network retry) sees the claim and bails before submitting to the
    // budget provider — otherwise it could create a duplicate transaction.
    // A pending entry that isn't "ready"/"error" (e.g. still parsing) also
    // fails the claim and correctly surfaces "not ready to import".
    if (pendingEntry && !claimForImport(sourceFilename!)) {
      return c.json(
        { error: "This receipt is already being imported or is not ready to import." },
        409,
      );
    }

    const claimedFilePath = pendingEntry?.filePath ?? null;

    try {
      await importReceiptToYnab(account, receipt as Receipt);

      // Record in import history
      addRecord({
        filename: sourceFilename || "manual-upload",
        merchant: receipt.merchant,
        totalAmount: receipt.totalAmount,
        itemCount: receipt.lineItems?.length ?? 0,
        transactionDate: receipt.transactionDate,
        success: true,
        receipt: receipt as Receipt,
      });

      // If this came from the watcher queue, move the file to processed.
      // Use the captured filePath rather than re-reading from the map so
      // we still clean up if the entry was wiped mid-flight.
      if (pendingEntry && claimedFilePath) {
        try {
          moveToProcessed(claimedFilePath, sourceFilename!);
        } catch (e: any) {
          console.warn(`Could not move source file: ${e.message}`);
        }
        removePending(sourceFilename!);
      }

      return c.json({ success: true }, 200);
    } catch (err: any) {
      console.error("Error importing receipt:", err);
      if (pendingEntry) releaseImportClaim(sourceFilename!);
      return rateLimitOr500(c, err);
    }
  }
);

export default importRoutes;

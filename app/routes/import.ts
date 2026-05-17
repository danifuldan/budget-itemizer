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
      stream.onAbort(() => {
        aborted = true;
        // Don't leave the entry stuck "parsing" forever: the parse keeps
        // running (no cancellation plumbed) and onDone is now skipped, so
        // nothing would ever transition it (the stale-claim reaper only
        // covers "importing"). Drop it — the user abandoned it. Idempotent
        // if an explicit Discard already DELETEd it.
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
        await parseImageReceiptStream(file, {
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
        });
        // Flush any queued writes
        await writeChain;
      } catch (err: any) {
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

    // Idempotency: if this import is associated with a watcher pending
    // entry, atomically claim it. A second concurrent call (double-click,
    // network retry) sees the claim and bails before submitting to the
    // budget provider — otherwise it could create a duplicate transaction.
    // Manual uploads (no sourceFilename) skip the claim and remain
    // racey at this layer; the FE de-dupes them via button-disable.
    if (sourceFilename && !claimForImport(sourceFilename)) {
      return c.json(
        { error: "This receipt is already being imported or is not ready to import." },
        409,
      );
    }

    // Snapshot the source file path *before* the YNAB await. If the user
    // changes their inbox in Settings mid-flight (which clears most
    // pending entries), the entry we'd look up after the await could be
    // wiped — leaving the source file orphaned in the old inbox.
    // clearAllPending preserves importing-status entries for this exact
    // reason, but capturing here is cheap defense-in-depth.
    const claimedFilePath = sourceFilename ? getPending(sourceFilename)?.filePath ?? null : null;

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
      if (sourceFilename && claimedFilePath) {
        try {
          moveToProcessed(claimedFilePath, sourceFilename);
        } catch (e: any) {
          console.warn(`Could not move source file: ${e.message}`);
        }
        removePending(sourceFilename);
      }

      return c.json({ success: true }, 200);
    } catch (err: any) {
      console.error("Error importing receipt:", err);
      if (sourceFilename) releaseImportClaim(sourceFilename);
      return rateLimitOr500(c, err);
    }
  }
);

export default importRoutes;

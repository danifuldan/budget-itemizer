import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Receipt } from "./shared-types";
import {
  createTransaction,
  findMatchingTransaction,
  updateTransactionWithSplits,
  getAllEnvelopes as getAllCategories,
} from "./budget";
import { ReconciliationError } from "./budget-provider";
import { extractPdfText } from "./pipeline/pdf-text";
import {
  parseReceiptFromTextStream,
  type StreamEventCallbacks,
} from "./pipeline/build-receipt";
import {
  getCapabilities,
  isSidecarAvailable,
  runVision,
} from "./swift-sidecar";
import { buildTextFromVisionResult } from "./text/vision-reconstruct";
import { getConfig } from "./config";
import { scrubLlmString, SCRUB_LIMITS } from "../utils/scrub-string";

/** Apply the scrub uniformly to every LLM-emitted string in a Receipt
 *  before it crosses the boundary into a transaction-API call. Returns
 *  a new Receipt with safe values; the original is left untouched
 *  (callers may still want to render the original for the user review,
 *  but the bytes going to YNAB / Actual go through this gate). */
function scrubReceipt(r: Receipt): Receipt {
  return {
    ...r,
    merchant: scrubLlmString(r.merchant, SCRUB_LIMITS.merchant),
    category: scrubLlmString(r.category, SCRUB_LIMITS.category),
    memo: scrubLlmString(r.memo, SCRUB_LIMITS.memo),
    lineItems: r.lineItems?.map((li) => ({
      ...li,
      productName: scrubLlmString(li.productName, SCRUB_LIMITS.productName),
      category: scrubLlmString(li.category, SCRUB_LIMITS.category),
    })),
  };
}

export const buildSplits = (receipt: Receipt) => {
  if (!receipt.lineItems || receipt.lineItems.length === 0) return undefined;

  const discount = receipt.discount ?? 0;
  const discountMode = getConfig().discountMode || "distribute";

  let itemSplits: { category: string; amount: number; memo: string }[];

  if (discount <= 0 || discountMode === "credit") {
    itemSplits = receipt.lineItems.map((li) => ({
      category: li.category,
      amount: li.lineItemTotalAmount,
      memo: li.productName,
    }));
  } else {
    // Distribute the discount proportionally across items
    const subtotal = receipt.lineItems.reduce((s, li) => s + li.lineItemTotalAmount, 0);
    itemSplits = receipt.lineItems.map((li) => {
      const share = Math.round((li.lineItemTotalAmount / subtotal) * discount * 100) / 100;
      return {
        category: li.category,
        amount: Math.round((li.lineItemTotalAmount - share) * 100) / 100,
        memo: li.productName,
      };
    });

    // Fix rounding: adjust the largest item so splits sum to exactly subtotal - discount
    const target = Math.round((subtotal - discount) * 100) / 100;
    const currentSum = Math.round(itemSplits.reduce((s, sp) => s + sp.amount, 0) * 100) / 100;
    const drift = Math.round((target - currentSum) * 100) / 100;
    if (drift !== 0) {
      const largest = itemSplits.reduce((max, sp, i) =>
        sp.amount > itemSplits[max].amount ? i : max, 0);
      itemSplits[largest].amount = Math.round((itemSplits[largest].amount + drift) * 100) / 100;
    }
  }

  // Add explicit breakdown splits so each shows as a separate line in YNAB
  const splits = [...itemSplits];
  const tax = receipt.tax ?? 0;
  const shipping = receipt.shipping ?? 0;
  const fees = receipt.fees ?? 0;
  const refund = receipt.refund ?? 0;

  if (tax > 0) {
    splits.push({ category: "", amount: tax, memo: "Tax/fees" });
  }
  if (shipping > 0) {
    splits.push({ category: "", amount: shipping, memo: "Shipping" });
  }
  if (fees > 0) {
    splits.push({ category: "", amount: fees, memo: "Delivery fee" });
  }
  if (discountMode === "credit" && discount > 0) {
    splits.push({ category: "", amount: -discount, memo: "Discount" });
  }
  const credit = receipt.credit ?? 0;
  if (credit > 0) {
    splits.push({ category: "", amount: -credit, memo: receipt.creditLabel || "Credit" });
  }
  if (refund > 0) {
    splits.push({ category: "", amount: -refund, memo: "Refund" });
  }

  return splits;
};

export const importReceipt = async (
  account: string,
  receiptIn: Receipt,
): Promise<void> => {
  try {
    // Scrub every LLM-emitted string at this boundary. The receipt object
    // we received was assembled from LLM output; anything from here on
    // flows into the YNAB / Actual API and must be control-char-clean
    // and length-capped. Numeric fields are untouched (amounts come from
    // deterministic OCR regex, not LLM choice).
    const receipt = scrubReceipt(receiptIn);
    const splits = buildSplits(receipt);

    const itemSum = receipt.lineItems?.reduce((s, li) => s + li.lineItemTotalAmount, 0) ?? 0;
    console.log(
      `[import] totalAmount=${receipt.totalAmount}, itemSum=${itemSum}, remainder=${receipt.totalAmount - itemSum}, items=${receipt.lineItems?.length ?? 0}`
    );

    // When there's only one line item, splits won't be used (YNAB doesn't
    // need subtransactions for a single category). Carry the product name
    // into the main transaction memo so it isn't lost.
    const memo =
      !receipt.memo && receipt.lineItems?.length === 1
        ? receipt.lineItems[0].productName
        : receipt.memo;

    // Try to find a matching transaction in the user's budget. Hard
    // filters: amount-exact, date ±3, account-per-setting. Tiebreakers:
    // splits-similarity (re-import of same receipt → high overlap → safe
    // to overwrite), vendor match (fuzzy), date proximity, and "least
    // touched" signals (uncleared, unapproved, no memo). See
    // `findMatchingTransaction` in each provider for the cascade.
    const splitAmounts = splits?.map((s) => s.amount);
    const match = await findMatchingTransaction(
      account,
      receipt.totalAmount,
      receipt.transactionDate,
      receipt.merchant,
      splitAmounts,
    );

    if (match) {
      console.log(`Found matching transaction: ${match.id}`);
      await updateTransactionWithSplits(
        match.id,
        receipt.merchant,
        receipt.category,
        memo,
        receipt.totalAmount,
        splits
      );
    } else {
      console.log(
        "No matching transaction found, creating new transaction"
      );
      await createTransaction(
        account,
        receipt.merchant,
        receipt.category,
        receipt.transactionDate,
        memo,
        receipt.totalAmount,
        splits
      );
    }
  } catch (err) {
    // ReconciliationError carries an actionable, user-facing message
    // ("splits don't reconcile…"). Don't bury it under the generic
    // ReceiptImportError — let the caller surface it verbatim.
    if (err instanceof ReconciliationError) throw err;
    console.error(`Failed to import the receipt: ${err}`);
    throw new ReceiptImportError({ cause: err });
  }
};

/**
 * Emit receipt fields as SSE events for non-streaming providers that
 * return a complete receipt in one shot (Apple Vision, etc.).
 */
export const emitReceiptEvents = async (
  receipt: Receipt,
  events: StreamEventCallbacks,
): Promise<void> => {
  await events.onHeader?.({
    merchant: receipt.merchant,
    transactionDate: receipt.transactionDate,
  });

  const items = receipt.lineItems ?? [];
  for (let i = 0; i < items.length; i++) {
    await events.onItem?.({
      index: i,
      productName: items[i].productName,
      quantity: items[i].quantity ?? 1,
      lineText: items[i].productName,
      amount: items[i].lineItemTotalAmount,
    });
  }

  await events.onTotal?.({
    totalAmount: receipt.totalAmount,
    tax: receipt.tax ?? 0,
    shipping: receipt.shipping ?? 0,
    fees: receipt.fees ?? 0,
    discount: receipt.discount ?? 0,
    credit: receipt.credit ?? 0,
    creditLabel: receipt.creditLabel,
    refund: receipt.refund ?? 0,
  });

  if (items.length > 0) {
    await events.onCategories?.(items.map((li) => li.category));
  }

  await events.onDone?.(receipt);
};

/**
 * Try Apple Vision OCR (best quality on macOS) → fall back to pdf.js
 * text extraction. Returns null if neither path produced text.
 */
const extractReceiptText = async (
  fileBuffer: Buffer,
  events: StreamEventCallbacks,
  signal?: AbortSignal,
): Promise<{ text: string; fullText?: string; sourceUrl?: string } | null> => {
  await events.onStatus?.("reading-pdf");

  // Apple Vision path — best layout quality for multi-column receipts.
  if (isSidecarAvailable()) {
    const caps = await getCapabilities();
    if (caps.visionAvailable) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-vision-"));
      const pdfPath = path.join(tmpDir, "input.pdf");
      fs.writeFileSync(pdfPath, fileBuffer);
      try {
        await events.onStatus?.("analyzing-layout");
        const result = await runVision(pdfPath, 6, undefined, signal);
        const text = buildTextFromVisionResult(result);
        if (text) {
          const fullPageText = result.pages.map((p) => p.text).join("\n");
          const urlMatch = fullPageText.match(/https?:\/\/[^\s]+/i);
          console.log(`[receipt] Apple Vision extracted ${text.length} chars from ${result.pages.length} page(s)`);
          return { text, fullText: fullPageText, sourceUrl: urlMatch?.[0] };
        }
        console.log("[receipt] Apple Vision returned no usable text");
      } catch (err) {
        console.warn("[receipt] Apple Vision failed, falling back to pdf.js:", err);
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  // Fallback: pdf.js text extraction.
  const text = await extractPdfText(fileBuffer);
  return text ? { text } : null;
};

export const parseImageReceiptStream = async (
  file: File,
  events: StreamEventCallbacks,
  signal?: AbortSignal,
): Promise<Receipt> => {
  if (file.type !== "application/pdf") {
    throw new ReceiptParseError(`unsupported file type "${file.type}"`);
  }

  // Early-abort checks between the fast steps. The slow LLM call gets
  // signal directly (step 1); getAllCategories is 5-min cached + 30s
  // timeout protected so threading the signal into the provider has
  // negligible marginal value vs the contract churn; pdf.js text
  // extract is fast-and-sync-ish. So we check signal.aborted between
  // these and fail fast instead of threading deeper.
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException("Parse aborted", "AbortError");
  };

  throwIfAborted();
  const fileBuffer = Buffer.from(await file.arrayBuffer());
  throwIfAborted();
  const ynabCategories = await getAllCategories();
  throwIfAborted();

  const extracted = await extractReceiptText(fileBuffer, events, signal);
  throwIfAborted();
  if (!extracted) {
    throw new ReceiptParseError("no text extracted from PDF");
  }

  const receipt = await parseReceiptFromTextStream(
    extracted.text,
    ynabCategories,
    events,
    extracted.sourceUrl,
    extracted.fullText,
    signal, // Aborts the streaming label LLM call + the category-assign LLM call.
  );

  if (!receipt) {
    throw new ReceiptParseError("understanding provider returned no result");
  }

  return receipt;
};

export class ReceiptParseError extends Error {
  constructor(detail?: string, options?: ErrorOptions) {
    super(detail ? `Failed to parse the receipt: ${detail}` : "Failed to parse the receipt", options);
    this.name = "ReceiptParseError";
  }
}

export class ReceiptImportError extends Error {
  constructor(options?: ErrorOptions) {
    // Surface the underlying cause so the user sees an actionable
    // message ("Account not found", "Category not found", a YNAB
    // error string) instead of the generic wrapper. Pre-fix the
    // wrapper's message always won at the HTTP layer, leaving the
    // user with no clue why the import failed.
    const cause = options?.cause;
    const causeMessage = cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : null;
    const message = causeMessage
      ? `Failed to import the receipt: ${causeMessage}`
      : "Failed to import the receipt";
    super(message, options);
    this.name = "ReceiptImportError";
  }
}

/** @deprecated Use importReceipt */
export const importReceiptToYnab = importReceipt;

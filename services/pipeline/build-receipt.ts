import type { Receipt, ReceiptLineItem } from "../shared-types";
import { refineMerchant } from "../merchant";
import {
  IncrementalLabelParser,
  type StreamParserCallbacks,
} from "../stream-parser";
import { callLLM, callLLMStream, getLlmTextModel } from "../llm/transport";
import { labelPrompt, labelSchema, type LabelResult } from "../llm/prompts";
import {
  normalizeText,
  sanitizeLabel,
  stripPrintTimestamp,
  stripDeliveryDates,
  normalizeDate,
} from "../text/normalize";
import {
  findAmountByLabel,
  detectZeroAmount,
  type ClaimedRange,
} from "../text/amount-extract";
import { reconcileExtraction, MAX_LLM_QTY } from "./reconcile";

/**
 * Build a Receipt from LLM-identified labels + deterministic text extraction.
 */
export const buildReceiptFromLabels = (labels: LabelResult, text: string): Receipt => {
  console.log("--- Deterministic extraction using LLM-identified labels ---");

  const claimedRanges: ClaimedRange[] = [];

  // Extract total first (sanitize label, use tight search distance)
  const totalResult = findAmountByLabel(text, sanitizeLabel(labels.totalLabel), claimedRanges, 80);
  const totalAmount = totalResult?.value ?? 0;
  if (totalResult && totalResult.claimed.start >= 0) {
    claimedRanges.push(totalResult.claimed);
  }

  // Extract line items BEFORE summary amounts. Items use wide search (500 chars)
  // and claim the correct amounts. Summary labels then search with item prices
  // excluded, preventing hallucinated summary labels from stealing item prices
  // (e.g. Target: hallucinated "TAX" label claiming $9.99 Aveeno price).
  const dollarPattern = /-?(?:\$\s*[\d,]+(?:\.\d{2})?|[\d,]+\.\d{2})/g;

  // Step 1: Deduplicate FM entries by lineText (case-insensitive)
  const seen = new Map<string, typeof labels.lineItems[0]>();
  for (const li of labels.lineItems) {
    const key = sanitizeLabel(li.lineText).toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, li);
    }
    // If FM reported separate entries, we'll count occurrences in the text instead
  }
  const uniqueItems = [...seen.values()];

  // Step 1b: Filter out items marked as unfulfilled (e.g. Walmart "Unavailable")
  const fulfilledItems = uniqueItems.filter((li) => {
    const combined = `${li.productName} ${li.lineText}`.toLowerCase();
    if (/\bunavailable\b|\bcancell?ed\b|\bout of stock\b|\brefunded\b/.test(combined)) {
      console.log(`  Skipping unfulfilled item: "${li.productName}"`);
      return false;
    }
    return true;
  });

  const lineItems: ReceiptLineItem[] = fulfilledItems.map((li) => {
    const result = findAmountByLabel(text, sanitizeLabel(li.lineText), claimedRanges, 500);
    const extractedPrice = result != null ? Math.abs(result.value) : 0;
    const fmPerLineQty = li.quantity ?? 1;

    // Count actual occurrences of this line text in the receipt
    const needle = sanitizeLabel(li.lineText);
    let occurrences = 0;
    if (needle.length > 0) {
      let searchFrom = 0;
      while (true) {
        const idx = text.toLowerCase().indexOf(needle.toLowerCase(), searchFrom);
        if (idx === -1) break;
        occurrences++;
        searchFrom = idx + needle.length;
      }
    }

    // Quantity resolution:
    // - If item appears multiple times in text (occurrences > 1), trust the text count
    //   (it's deterministic; FM is non-deterministic and sometimes overcounts)
    // - If item appears once, trust FM's per-line qty (e.g. "Qty 2") or prefixQty (e.g. "3 $9.99")
    // - Hard-cap at MAX_LLM_QTY to neutralize prompt-injected qty inflation —
    //   a malicious PDF that tricks the LLM into claiming qty=99 on a $2.49
    //   item would otherwise multiply through to a $246.51 line, blowing past
    //   subtotal reconciliation only because the reconciler used to validate
    //   the unit price not the line total.
    // Math.max biases toward over-counting. This is acceptable because over-counting
    // is caught by subtotal reconciliation; under-counting is not.
    const prefixQty = result?.prefixQty ?? 1;
    const rawQty = occurrences > 1
      ? Math.max(occurrences, prefixQty)
      : Math.max(1, fmPerLineQty, prefixQty);
    const qty = Math.min(rawQty, MAX_LLM_QTY);
    if (rawQty > MAX_LLM_QTY) {
      console.warn(`  Validation: clamped qty for "${li.lineText}" from ${rawQty} to ${MAX_LLM_QTY}`);
    }
    if (occurrences > 1 || fmPerLineQty > 1 || prefixQty > 1) {
      console.log(`  "${li.lineText}" appears ${occurrences}x in text, FM qty ${fmPerLineQty}, prefixQty ${prefixQty} → using ${qty}`);
    }

    const lineTotal = Math.round(extractedPrice * qty * 100) / 100;
    if (result && result.claimed.start >= 0) claimedRanges.push(result.claimed);
    return {
      productName: li.productName,
      quantity: qty,
      lineItemTotalAmount: lineTotal,
      category: "",
    };
  });

  // Now extract summary amounts (tax, shipping, discount, refund) AFTER items.
  // Item prices are already claimed, so summary labels won't steal them.
  // Track delivery charges vs other fees separately so "Free delivery" only
  // zeros the delivery component, not unrelated fees like "Below order minimum".
  let tax = 0;
  let deliveryCharges = 0;
  let feeCharges = 0;
  let discount = 0;
  let credit = 0;
  let creditLabel = "";
  let refund = 0;

  const sanitizedTotalLabel = sanitizeLabel(labels.totalLabel).toLowerCase();

  // Track individual contributions so we can dedup breakdown lines
  // (e.g. "Estimated regulatory fees & taxes $2.00" + "White Goods Excise Tax $2.00"
  // where the second is a breakdown of the first, not additive)
  const contributions: { type: string; label: string; value: number }[] = [];

  for (const sl of labels.summaryLabels) {
    const cleanLabel = sanitizeLabel(sl.label);

    // Skip summary labels that duplicate the totalLabel (e.g. FM outputs
    // "TOTAL $24.96 (credit)" when VISA CREDIT TEND is the payment, not a discount)
    if (cleanLabel.toLowerCase() === sanitizedTotalLabel) {
      console.log(`  "${sl.label}" (${sl.type}) → skipped (duplicates totalLabel)`);
      continue;
    }

    if (detectZeroAmount(text, cleanLabel)) {
      // A "free" label means THIS specific charge is $0. Only zero the
      // delivery accumulator when the label IS a shipping/delivery charge —
      // not for unrelated fees (e.g. "Driver tip Free" should not wipe out
      // a previously-accumulated "Below order minimum" fee).
      const labelLower = cleanLabel.toLowerCase();
      if (sl.type === "shipping" || /shipping|handling|delivery/i.test(labelLower)) {
        deliveryCharges = 0;
      } else if (sl.type === "tax" || /\btax\b/i.test(labelLower)) {
        tax = 0;
      }
      console.log(`  "${sl.label}" (${sl.type}) → $0 (detected free/zero)`);
      continue;
    }

    // Try to extract amount directly from the FM's raw label text
    // (before sanitization, which strips dollar amounts)
    const inlineAmounts = [...sl.label.matchAll(dollarPattern)];
    let value: number | null = null;

    if (inlineAmounts.length > 0) {
      // Use the last amount in the label (e.g. "TAX 1 8 % 0.27" → 0.27)
      const lastMatch = inlineAmounts[inlineAmounts.length - 1];
      value = parseFloat(lastMatch[0].replace(/[$,\s]/g, ""));
      console.log(`  "${sl.label}" (${sl.type}) → $${value} (from label)`);
    } else {
      // FM didn't include amount — fall back to text search
      const strippedLabel = cleanLabel.replace(dollarPattern, "").trim();
      const result = findAmountByLabel(text, strippedLabel, claimedRanges, 80);
      if (result == null) {
        console.log(`  "${sl.label}" (${sl.type}) → not found in text, dropping`);
        continue;
      }
      claimedRanges.push(result.claimed);
      value = Math.abs(result.value);
      console.log(`  "${sl.label}" (${sl.type}) → $${value} (from text search)`);
    }

    const absValue = Math.abs(value);
    contributions.push({ type: sl.type, label: sl.label, value: absValue });

    switch (sl.type) {
      case "tax": tax += absValue; break;
      case "shipping": deliveryCharges += absValue; break;
      case "fee": feeCharges += absValue; break;
      case "discount": discount += absValue; break;
      case "credit": credit += absValue; creditLabel = creditLabel || sl.label; break;
      case "refund": refund += absValue; break;
      case "subtotal": break; // used for validation only
    }
  }

  const shipping = deliveryCharges;
  const fees = feeCharges;
  console.log(`Extracted: total=${totalAmount}, tax=${tax}, shipping=${shipping}, fees=${fees}, discount=${discount}, credit=${credit}, refund=${refund}, items=${lineItems.length}`);

  const transactionDate = normalizeDate(labels.dateLabel);
  console.log(`  Date: dateLabel="${labels.dateLabel}" → transactionDate="${transactionDate}"`);

  const receipt: Receipt = {
    merchant: labels.merchant,
    transactionDate,
    memo: "",
    totalAmount: Math.abs(totalAmount),
    category: "",
    lineItems,
    tax,
    shipping,
    fees,
    discount,
    credit,
    creditLabel: creditLabel || undefined,
    refund,
  };

  // Post-extraction validation
  reconcileExtraction(receipt, labels, text, claimedRanges, contributions);

  return receipt;
};

const assignCategories = async (
  items: { productName: string; lineItemTotalAmount: number }[],
  merchant: string,
  availableCategories: string[],
  signal?: AbortSignal,
): Promise<(string | null)[]> => {
  if (items.length === 0) return [];

  const categoryList = availableCategories
    .filter((c) => c !== "Inflow: Ready to Assign")
    .join(", ");

  const itemList = items
    .map((item, i) => `${i + 1}. "${item.productName}" ($${item.lineItemTotalAmount})`)
    .join("\n");

  const categorySchema = {
    type: "object" as const,
    properties: {
      categories: {
        type: "array" as const,
        items: { type: "string" as const, enum: availableCategories },
      },
    },
    required: ["categories"],
  };

  try {
    const content = await callLLM(
      getLlmTextModel(),
      [
        {
          role: "system",
          content: `You categorize purchases into household budget categories. You will be given a list of items from a single receipt and must assign each item a category from the provided list.

Rules:
- You MUST pick from the provided categories exactly as written (including any emoji prefixes).
- Consider the item name, the merchant, and what the item most likely is.
- Pick the single most common-sense category for each item.
- If no category is a reasonable fit, use "Uncategorized".`,
        },
        {
          role: "user",
          content: `Merchant: ${merchant}

Items:
${itemList}

Available categories: ${categoryList}

Assign a category to each item. Return a JSON array with one category string per item, in the same order.`,
        },
      ],
      categorySchema,
      "category-assignment",
      signal, // Discard-while-categorizing aborts the in-flight LLM call.
    );

    console.log("[categories] Raw LLM response:", content.slice(0, 500));
    const result = JSON.parse(content);

    // Normalize response: model may return {"categories": ["A","B"]}
    // or [{"category": "A"}, ...] or ["A", "B"]
    let categories: string[];
    if (Array.isArray(result)) {
      // [{"category": "A"}, ...] or ["A", "B"]
      categories = result.map((item: unknown) =>
        typeof item === "string" ? item : (item as Record<string, string>).category || ""
      );
    } else {
      categories = result.categories || [];
    }

    return items.map((_, i) => categories[i] || null);
  } catch (err) {
    // Don't swallow a user-initiated abort as "categorization failed,
    // here's a row of nulls" — that's the bug that lets a Discard
    // mid-parse silently complete the pipeline with empty categories on
    // every line item AND fire events.onDone as if the parse had
    // succeeded. Re-throw so the cancel propagates up to the route
    // handler, where it's already handled (the FE bailed; we should too).
    if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw err;
    }
    console.error("Category assignment failed:", err);
    return items.map(() => null);
  }
};

const assignReceiptCategories = async (
  receipt: Receipt,
  availableCategories: string[],
  signal?: AbortSignal,
): Promise<void> => {
  const items = receipt.lineItems || [];
  if (items.length === 0) return;

  console.log(`Assigning categories to ${items.length} items from ${receipt.merchant}...`);
  const categories = await assignCategories(items, receipt.merchant, availableCategories, signal);

  items.forEach((item, i) => {
    if (categories[i]) item.category = categories[i]!;
  });

  // Overall category = category of highest-spend item
  const topItem = items.reduce((a, b) =>
    (b.lineItemTotalAmount || 0) > (a.lineItemTotalAmount || 0) ? b : a
  );
  if (topItem.category) receipt.category = topItem.category;

  console.log("Categories assigned:", items.map((i) => `${i.productName} -> ${i.category}`));
};

export interface StreamEventCallbacks {
  onStatus?: (step: string, detail?: Record<string, unknown>) => void | Promise<void>;
  onHeader?: (header: { merchant: string; transactionDate: string }) => void | Promise<void>;
  onTotal?: (totals: { totalAmount: number; tax: number; shipping: number; fees: number; discount: number; credit: number; creditLabel?: string; refund: number }) => void | Promise<void>;
  onItem?: (item: { index: number; productName: string; quantity: number; lineText: string; amount: number }) => void | Promise<void>;
  onCategories?: (categories: string[]) => void | Promise<void>;
  onDone?: (receipt: Receipt) => void | Promise<void>;
  onError?: (error: Error, step: string) => void | Promise<void>;
}

export const parseReceiptFromTextStream = async (
  content: string,
  availableCategories: string[] | null,
  events: StreamEventCallbacks,
  sourceUrl?: string,
  fullText?: string,
  signal?: AbortSignal,
): Promise<Receipt | null> => {
  console.log(`[stream] Input length: ${content.length} chars`);

  // Clean text: remove print timestamps and delivery dates that confuse date extraction
  const cleaned = stripDeliveryDates(stripPrintTimestamp(content));

  const userMessage = `Analyze this receipt and identify all labels and structure.

Receipt content:
${cleaned}`;

  // Collect items as they arrive so we can run findAmountByLabel immediately
  const parsedItems: { productName: string; quantity: number; lineText: string; amount: number }[] = [];
  const claimedRanges: ClaimedRange[] = [];
  let labels: LabelResult | null = null;

  let headerEmitted = false;
  const parserCallbacks: StreamParserCallbacks = {
    onHeader: (header) => {
      events.onHeader?.({
        merchant: refineMerchant(header.merchant, sourceUrl, fullText || content),
        transactionDate: normalizeDate(header.dateLabel),
      });
      if (!headerEmitted) {
        headerEmitted = true;
        events.onStatus?.("extracting-items");
      }
    },
    onItem: (item, index) => {
      // Run deterministic amount extraction immediately (sanitize label, wide search for items)
      const result = findAmountByLabel(content, sanitizeLabel(item.lineText), claimedRanges, 500);
      const extractedPrice = result != null ? Math.abs(result.value) : 0;
      const qty = item.quantity ?? 1;
      // Use extracted price as-is — receipts almost always print the line total,
      // not unit price. The final receipt from buildReceiptFromLabels will reconcile.
      const amount = extractedPrice;

      parsedItems.push({ ...item, amount });

      events.onItem?.({
        index,
        productName: item.productName,
        quantity: qty,
        lineText: item.lineText,
        amount,
      });
    },
    onComplete: (result) => {
      labels = result;
    },
    onError: (error) => {
      events.onError?.(error, "label-parsing");
    },
  };

  const parser = new IncrementalLabelParser(parserCallbacks);

  // Stream Pass 1: LLM label extraction
  await events.onStatus?.("label-extraction");

  try {
    for await (const delta of callLLMStream(
      getLlmTextModel(),
      [
        { role: "system", content: labelPrompt },
        { role: "user", content: userMessage },
      ],
      labelSchema(),
      "label-extraction",
      signal, // Discard-while-parsing aborts the streaming LLM call.
    )) {
      parser.feed(delta);
    }
    parser.finish();
  } catch (err) {
    // Re-throw user-initiated aborts so they don't surface as misleading
    // "Label extraction failed" errors. Without this, a Discard during
    // label extract fires events.onError("label-extraction") — the FE
    // sees a parse failure when the user was just cancelling.
    if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw err;
    }
    const error = err instanceof Error ? err : new Error(String(err));
    console.error("[stream] Label extraction failed:", error.message);
    await events.onError?.(error, "label-extraction");
    return null;
  }

  if (!labels) {
    console.error("[stream] Label extraction produced no result (labels is null)");
    await events.onError?.(new Error("Label extraction produced no result"), "label-extraction");
    return null;
  }

  console.log("[stream] Labels extracted, building receipt...");

  // Build the full receipt from labels (gets total, tax, shipping, discount)
  await events.onStatus?.("extracting-totals");
  const receipt = buildReceiptFromLabels(labels, content);

  // Refine merchant: cross-reference LLM guess against URL and footer
  receipt.merchant = refineMerchant(receipt.merchant, sourceUrl, fullText || content);

  console.log(`[stream] Receipt built: ${receipt.merchant} $${receipt.totalAmount}, ${(receipt.lineItems ?? []).length} items`);

  // Emit totals
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

  console.log("[stream] Totals emitted, starting category assignment...");

  // buildReceiptFromLabels already extracted items with correct claimed ranges
  // (total/summary claimed first, then items). The streaming items were emitted
  // to the UI progressively but may have wrong amounts since total/summary
  // hadn't been claimed yet. Use buildReceiptFromLabels' items for the final receipt.

  // Pass 3: Assign categories
  if (availableCategories && availableCategories.length > 0) {
    await events.onStatus?.("categorizing", { itemCount: (receipt.lineItems ?? []).length });

    await assignReceiptCategories(receipt, availableCategories, signal);

    await events.onCategories?.((receipt.lineItems ?? []).map((li) => li.category));
  }

  console.log("[stream] Done, emitting onDone...");
  await events.onDone?.(receipt);
  return receipt;
};

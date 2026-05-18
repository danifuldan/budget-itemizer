import type { Receipt, ReceiptLineItem } from "../shared-types";
import type { LabelResult } from "../llm/prompts";
import { normalizeText, sanitizeLabel } from "../text/normalize";
import { findAmountByLabel, type ClaimedRange } from "../text/amount-extract";

/** Cap line-item qty to neutralize prompt-injected inflation. Receipts
 *  with > 20 of a single line item are rare; reconciliation catches
 *  residual mismatch. */
export const MAX_LLM_QTY = 20;

/**
 * Validate extracted amounts and log warnings for inconsistencies.
 * Attempts corrections for clear errors (e.g. item > total).
 */
export const reconcileExtraction = (
  receipt: Receipt,
  labels: LabelResult,
  text: string,
  claimedRanges: ClaimedRange[],
  summaryContributions?: { type: string; label: string; value: number }[],
): void => {
  const total = receipt.totalAmount;
  const tax = receipt.tax ?? 0;
  const shipping = receipt.shipping ?? 0;
  const fees = receipt.fees ?? 0;
  const discount = receipt.discount ?? 0;
  const refund = receipt.refund ?? 0;
  const items = receipt.lineItems ?? [];
  const itemSum = items.reduce((s, li) => s + (li.lineItemTotalAmount ?? 0), 0);

  // Extract subtotal early so we can use it as the ceiling for item validation.
  // When credits/gift cards are applied, the final total is lower than item prices —
  // the subtotal (pre-credits) is the correct ceiling.
  let subtotal: number | null = null;
  const subtotalLabel = labels.summaryLabels.find((sl) => sl.type === "subtotal");
  if (subtotalLabel) {
    const subtotalResult = findAmountByLabel(text, sanitizeLabel(subtotalLabel.label), [], 80);
    if (subtotalResult) {
      subtotal = Math.abs(subtotalResult.value);
    }
  }
  if (subtotal == null) {
    const normText = normalizeText(text);
    const m = normText.match(/(?:item\(?s?\)?\s+)?subtotal[:\s]*\$?\s*([\d,]+\.\d{2})/i);
    if (m) {
      subtotal = parseFloat(m[1].replace(/,/g, ""));
      console.log(`  Validation: subtotal $${subtotal.toFixed(2)} found via text scan`);
    }
  }

  // Use subtotal as ceiling when available (handles gift card / credit scenarios),
  // otherwise fall back to the final total
  const itemCeiling = subtotal ?? total;

  // Check: individual item should not exceed ceiling — drop if unfixable
  const droppedIndices = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    if (itemCeiling > 0 && items[i].lineItemTotalAmount > itemCeiling) {
      console.warn(`  Validation: item "${items[i].productName}" ($${items[i].lineItemTotalAmount}) exceeds ${subtotal ? "subtotal" : "total"} ($${itemCeiling}) — re-extracting`);
      // Re-extract with all other claimed ranges excluded
      const li = labels.lineItems[i];
      let fixed = false;
      if (li) {
        const result = findAmountByLabel(text, sanitizeLabel(li.lineText), claimedRanges, 500);
        if (result && Math.abs(result.value) <= itemCeiling) {
          // Validate BOTH the unit price and the post-multiplication
          // line total against the ceiling. Earlier code only checked
          // the unit, then multiplied by the LLM-claimed qty without
          // re-validating — letting qty=99 sneak inflation past the
          // defense (adversarial test 2026-05-12).
          const qty = Math.min(li.quantity ?? 1, MAX_LLM_QTY);
          const lineTotal = Math.round(Math.abs(result.value) * qty * 100) / 100;
          if (lineTotal <= itemCeiling) {
            items[i].lineItemTotalAmount = lineTotal;
            fixed = true;
          }
        }
      }
      if (!fixed) {
        console.warn(`  Validation: dropping item "${items[i].productName}" — still exceeds total after re-extraction`);
        droppedIndices.add(i);
      }
    }
  }

  // Remove dropped items
  if (droppedIndices.size > 0) {
    receipt.lineItems = items.filter((_, i) => !droppedIndices.has(i));
  }

  // Recalculate item sum after drops
  const remainingItems = receipt.lineItems ?? [];
  let remainingSum = remainingItems.reduce((s, li) => s + (li.lineItemTotalAmount ?? 0), 0);

  // Zero-amount inference: if exactly one item has $0 (OCR missed its price) and
  // we have a subtotal, infer the missing amount as the gap.
  if (subtotal != null) {
    const zeroItems = remainingItems.filter((li) => (li.lineItemTotalAmount ?? 0) === 0);
    if (zeroItems.length === 1) {
      const nonZeroSum = Math.round(
        remainingItems.reduce((s, li) => li === zeroItems[0] ? s : s + (li.lineItemTotalAmount ?? 0), 0) * 100,
      ) / 100;
      const inferred = Math.round((subtotal - nonZeroSum) * 100) / 100;
      if (inferred > 0) {
        console.log(`  Validation: "${zeroItems[0].productName}" has $0 — inferred $${inferred.toFixed(2)} from subtotal ($${subtotal.toFixed(2)}) - other items ($${nonZeroSum.toFixed(2)})`);
        zeroItems[0].lineItemTotalAmount = inferred;
        remainingSum = remainingItems.reduce((s, li) => s + (li.lineItemTotalAmount ?? 0), 0);
      }
    }
  }

  // Check: subtotal vs item sum — try to fix qty if diff is an exact multiple of one item's unit price.
  // The post-reconciliation check at the bottom of this function warns only
  // if the discrepancy survives our corrections; this branch silently
  // attempts the fixes (qty inference + line-total detection) when needed.
  if (subtotal != null) {
    const diff = Math.round((subtotal - remainingSum) * 100) / 100;
    if (Math.abs(diff) > 0.05) {
      // Arithmetic qty inference: if the gap equals an exact multiple of one item's
      // unit price, that item's quantity is likely wrong (e.g. Amazon badge invisible to OCR).
      // Limitations:
      //   - Only fixes ONE item per pass (first match wins)
      //   - Item iteration order depends on LLM output order (non-deterministic)
      //   - A low-priced item ($1.00) absorbs almost any integer gap — false positive risk
      //   - Only catches under-counting (diff > 0), never over-counting
      if (diff > 0) {
        for (const item of remainingItems) {
          const unitPrice = item.lineItemTotalAmount / item.quantity;
          if (unitPrice > 0.01) {
            const missingUnits = diff / unitPrice;
            // Must be a clean integer (within rounding tolerance)
            if (Math.abs(missingUnits - Math.round(missingUnits)) < 0.01 && Math.round(missingUnits) >= 1) {
              const addQty = Math.round(missingUnits);
              const newQty = item.quantity + addQty;
              console.log(`  Validation: adjusting "${item.productName}" qty ${item.quantity} → ${newQty} (diff $${diff.toFixed(2)} = ${addQty} × $${unitPrice.toFixed(2)})`);
              item.quantity = newQty;
              item.lineItemTotalAmount = Math.round(unitPrice * newQty * 100) / 100;
              break; // only fix one item per pass
            }
          }
        }
      }

      // Line-total detection: if items overshoot the subtotal (diff < 0) and there
      // are multi-qty items, the listed prices may already be line totals (common on
      // online order receipts like Walmart.com). Check if un-multiplying multi-qty
      // items brings the sum closer to the subtotal.
      //
      // When a discount/savings exists, item prices may be post-savings while the
      // subtotal is pre-savings. Compare against both subtotal and subtotal-discount
      // to catch this case (e.g. Walmart "Savings -$12.97" with post-savings prices).
      //
      // NOTE: This block cooperates with the double-counted discount detection below.
      // When items are corrected to match postSavingsSubtotal, the double-counted
      // detector will fire and zero the discount. Both blocks must run in this order.
      if (diff < -0.50) {
        const multiQtyItems = remainingItems.filter((li) => li.quantity > 1);
        if (multiQtyItems.length > 0) {
          const getOriginalPrice = (li: ReceiptLineItem) =>
            li.quantity > 1 ? Math.round(li.lineItemTotalAmount / li.quantity * 100) / 100 : li.lineItemTotalAmount;

          // What would the sum be if we treated each extracted price as a line total?
          const correctedSum = Math.round(remainingItems.reduce((s, li) => {
            return s + getOriginalPrice(li);
          }, 0) * 100) / 100;

          // Check against both pre-savings subtotal and post-savings subtotal
          const postSavingsSubtotal = discount > 0 ? Math.round((subtotal - discount) * 100) / 100 : subtotal;
          const bestTarget = Math.abs(postSavingsSubtotal - correctedSum) < Math.abs(subtotal - correctedSum)
            ? postSavingsSubtotal : subtotal;
          const correctedDiff = Math.abs(bestTarget - correctedSum);
          // Require both: closer to a target than current sum, AND an exact match
          if (correctedDiff < Math.abs(diff) && correctedDiff < 0.01) {
            console.log(`  Validation: line-total detection — correctedSum=$${correctedSum.toFixed(2)}, target=$${bestTarget.toFixed(2)} (${bestTarget === postSavingsSubtotal && discount > 0 ? "post-savings" : "pre-savings"})`);
            for (const item of multiQtyItems) {
              const originalPrice = getOriginalPrice(item);
              console.log(`  Validation: "${item.productName}" $${item.lineItemTotalAmount.toFixed(2)} → $${originalPrice.toFixed(2)} (price was already a line total for qty ${item.quantity})`);
              item.lineItemTotalAmount = originalPrice;
            }
          }
        }
      }
    }
  }

  // Recompute item sum after all corrections (qty inference + line-total detection)
  const finalItemSum = (receipt.lineItems ?? []).reduce(
    (s, li) => s + (li.lineItemTotalAmount ?? 0), 0
  );

  // Post-reconciliation subtotal check: warn only if the gap survives qty
  // inference + line-total detection AND isn't the post-discount-items
  // shape that the next block resolves. Without that exclusion, receipts
  // where items are post-savings and subtotal is pre-savings would fire
  // a "differs by $X.XX" warning that the next two lines silently zero out.
  if (subtotal != null) {
    const finalDiff = Math.round((subtotal - finalItemSum) * 100) / 100;
    const explainedByDiscount = discount > 0 && Math.abs(finalDiff - discount) < 0.10;
    if (Math.abs(finalDiff) > 0.05 && !explainedByDiscount) {
      console.warn(`  Validation: item sum ($${finalItemSum.toFixed(2)}) differs from subtotal ($${subtotal.toFixed(2)}) by $${finalDiff.toFixed(2)} after reconciliation`);
    }
  }

  // Detect double-counted discount: if item prices are post-discount (i.e. they
  // already reflect the savings), subtracting the discount again would double-count.
  // Signal: item sum ≈ subtotal - discount (items are post-savings prices).
  if (subtotal != null && discount > 0) {
    const postDiscountSubtotal = Math.round((subtotal - discount) * 100) / 100;
    if (Math.abs(finalItemSum - postDiscountSubtotal) < 0.10) {
      console.log(`  Validation: item sum ($${finalItemSum.toFixed(2)}) matches subtotal - discount ($${postDiscountSubtotal.toFixed(2)}) — discount already in item prices, zeroing`);
      receipt.discount = 0;
    }
  }

  // Check: total vs components
  const credit = receipt.credit ?? 0;
  const effectiveDiscount = receipt.discount ?? 0;
  let expectedTotal = finalItemSum + tax + shipping + fees - effectiveDiscount - credit - refund;
  let totalDiff = Math.abs(expectedTotal - total);

  // Dedup: receipts sometimes show a summary line and its breakdown at the same
  // amount (e.g. "Estimated regulatory fees & taxes $2.00" followed by
  // "White Goods Solid Waste Excise Tax $2.00"). Detect by checking if removing
  // a single duplicate-amount same-type entry fixes the total exactly.
  if (total > 0 && totalDiff > 0.10 && summaryContributions) {
    const overshoot = Math.round((expectedTotal - total) * 100) / 100;
    if (overshoot > 0.01) {
      for (let i = 0; i < summaryContributions.length; i++) {
        const c = summaryContributions[i];
        if (c.type === "subtotal") continue;
        // Must have another entry of the same type with the same amount
        const hasDuplicate = summaryContributions.some((other, j) =>
          j !== i && other.type === c.type && Math.abs(other.value - c.value) < 0.01
        );
        if (!hasDuplicate) continue;
        // Would removing this entry fix the overshoot?
        const sign = (c.type === "discount" || c.type === "credit" || c.type === "refund") ? -1 : 1;
        if (Math.abs(overshoot - sign * c.value) < 0.01) {
          console.log(`  Validation: dedup "${c.label}" (${c.type}) $${c.value} — breakdown of another ${c.type} entry`);
          switch (c.type) {
            case "tax": receipt.tax = (receipt.tax ?? 0) - c.value; break;
            case "shipping": receipt.shipping = (receipt.shipping ?? 0) - c.value; break;
            case "fee": receipt.fees = (receipt.fees ?? 0) - c.value; break;
            case "discount": receipt.discount = (receipt.discount ?? 0) - c.value; break;
            case "credit": receipt.credit = (receipt.credit ?? 0) - c.value; break;
            case "refund": receipt.refund = (receipt.refund ?? 0) - c.value; break;
          }
          // Recompute
          expectedTotal = finalItemSum + (receipt.tax ?? 0) + (receipt.shipping ?? 0) + (receipt.fees ?? 0)
            - (receipt.discount ?? 0) - (receipt.credit ?? 0) - (receipt.refund ?? 0);
          totalDiff = Math.abs(expectedTotal - total);
          break;
        }
      }
    }
  }

  // Gross total + separate refund. An order invoice's stated total
  // (e.g. Amazon "Grand Total") is the amount CHARGED; a "Refund Total"
  // shown alongside it is a SEPARATE later credit, not a reduction of
  // that total. Subtracting it makes a correct extraction fail to
  // reconcile. If — and only if — adding the refund back is exactly
  // what makes the total reconcile, the stated total is gross: keep the
  // gross transaction (it matches the bank charge — matching is the
  // whole point) and drop the refund so it isn't deducted or emitted as
  // a -refund split. The net-stated case already reconciles WITH the
  // refund, so this branch never fires there.
  // Tax-from-anchors. SUBTOTAL and TOTAL are the two most reliably
  // printed figures on a receipt (large, isolated). When the items
  // reconcile to the printed SUBTOTAL but the components don't sum to
  // the printed TOTAL, the gap is a mis-extracted TAX (a classic OCR
  // digit slip on register tapes — e.g. $0.27 read as $0.20). Derive
  // tax from the anchors instead of trusting the OCR'd tax cell.
  //
  // Guard so this never papers over a genuinely missing line/fee: only
  // when items ≈ subtotal (items trusted) AND the derived tax is a
  // plausible sales-tax rate (≤15% of subtotal). A larger residual is a
  // missing fee, not a tax slip — leave it failing so it's caught.
  if (
    subtotal != null &&
    total > 0 &&
    Math.abs(finalItemSum - subtotal) <= 0.05 &&
    totalDiff > 0.005
  ) {
    const derivedTax =
      Math.round((total - subtotal - shipping - fees + effectiveDiscount + credit + refund) * 100) / 100;
    const plausibleTax = derivedTax >= -0.005 && derivedTax <= subtotal * 0.15 + 0.01;
    if (plausibleTax && Math.abs(derivedTax - (receipt.tax ?? 0)) > 0.005) {
      console.log(
        `  Validation: tax $${(receipt.tax ?? 0).toFixed(2)} inconsistent with subtotal $${subtotal.toFixed(2)} + total $${total.toFixed(2)} — deriving tax = $${derivedTax.toFixed(2)}`,
      );
      receipt.tax = derivedTax;
      expectedTotal = finalItemSum + derivedTax + shipping + fees - effectiveDiscount - credit - refund;
      totalDiff = Math.abs(expectedTotal - total);
    }
  }

  const curRefund = receipt.refund ?? 0;
  if (
    total > 0 &&
    totalDiff > 0.10 &&
    curRefund > 0 &&
    Math.abs(expectedTotal + curRefund - total) <= 0.10
  ) {
    console.log(
      `  Validation: stated total $${total.toFixed(2)} is gross; "Refund" $${curRefund.toFixed(2)} is a separate credit — not deducting (import matches the charge)`,
    );
    receipt.refund = 0;
    expectedTotal += curRefund;
    totalDiff = Math.abs(expectedTotal - total);
  }

  if (total > 0 && totalDiff > 0.10) {
    console.warn(`  Validation: computed total ($${expectedTotal.toFixed(2)}) differs from extracted total ($${total.toFixed(2)}) by $${totalDiff.toFixed(2)}`);
  }

};

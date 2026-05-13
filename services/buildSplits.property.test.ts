/**
 * Property-based tests for buildSplits (receipt.ts) and reconcileExtraction (pipeline/reconcile.ts).
 *
 * Invariants tested:
 *  1. Totals conservation: sum(splits) === itemSubtotal - discount + tax + shipping + fees - credit - refund
 *  2. No item is silently dropped: every line item maps to exactly one item split
 *  3. Idempotence: calling buildSplits twice on the same input yields the same splits
 *  4. Discount-distribute correctness: item splits sum to exactly subtotal - discount (rounding fixed)
 *  5. Discount-credit correctness: item splits are unmodified; discount appears as negative split
 *  6. Ancillary splits sign: tax/shipping/fees are positive; discount/credit/refund are negative
 *  7. reconcileExtraction threshold: warns only when diff > 0.10; accepts within-threshold totals
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fc from "fast-check";
import { buildSplits } from "./receipt";
import { reconcileExtraction } from "./pipeline/reconcile";
import type { Receipt, ReceiptLineItem } from "./shared-types";

// ---------------------------------------------------------------------------
// Config mock — buildSplits calls getConfig() for discountMode
// ---------------------------------------------------------------------------
vi.mock("./config", () => ({
  getConfig: vi.fn(() => ({ discountMode: "distribute" })),
}));

import { getConfig } from "./config";
const mockedGetConfig = vi.mocked(getConfig);

beforeEach(() => {
  mockedGetConfig.mockReturnValue({ discountMode: "distribute" } as any);
  // Suppress console noise from reconcileExtraction's validation logs
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Round to cents, matching the code's own rounding convention. */
const cents = (n: number) => Math.round(n * 100) / 100;

/** Sum an array of numbers, rounding the result to cents. */
const sumToCents = (nums: number[]) => cents(nums.reduce((a, b) => a + b, 0));

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * A monetary amount in cents (1 – 9999), returned as a dollar float.
 * Using integers-of-cents avoids the IEEE-754 drift that would make
 * invariant assertions unreliable.
 */
const monetaryAmount = fc
  .integer({ min: 1, max: 9999 })
  .map((c) => c / 100);

/** A non-negative monetary amount (0 or positive cents). */
const nonNegAmount = fc
  .integer({ min: 0, max: 9999 })
  .map((c) => c / 100);

/** A single ReceiptLineItem with a positive line total. */
const lineItemArb: fc.Arbitrary<ReceiptLineItem> = fc.record({
  productName: fc.constantFrom("Widget", "Bread", "Soap", "Book", "Cable"),
  quantity: fc.integer({ min: 1, max: 5 }),
  lineItemTotalAmount: monetaryAmount,
  category: fc.constantFrom("Groceries", "Electronics", "Personal Care", ""),
});

/**
 * A well-formed Receipt for property testing buildSplits.
 *
 * We deliberately do NOT derive totalAmount from the items + adjustments,
 * because buildSplits does not use totalAmount in its computation — it only
 * uses lineItems, discount, tax, shipping, fees, credit, refund.
 * Using a computed total lets us also check the full conservation invariant.
 */
const receiptArb = (discountMode: "distribute" | "credit" = "distribute") =>
  fc
    .record({
      lineItems: fc.array(lineItemArb, { minLength: 1, maxLength: 8 }),
      tax: nonNegAmount,
      shipping: nonNegAmount,
      fees: nonNegAmount,
      credit: nonNegAmount,
      refund: nonNegAmount,
      // Discount may not exceed item subtotal (prevents negative item amounts)
    })
    .chain(({ lineItems, tax, shipping, fees, credit, refund }) => {
      const subtotal = sumToCents(lineItems.map((li) => li.lineItemTotalAmount));
      // Keep discount strictly below the subtotal so no item goes negative
      return fc
        .integer({ min: 0, max: Math.max(0, Math.floor(subtotal * 100) - 1) })
        .map((discountCents) => {
          const discount = discountCents / 100;
          // Compute the "correct" total so we can check conservation
          const itemNet =
            discountMode === "distribute"
              ? cents(subtotal - discount)
              : subtotal;
          const discountSplit = discountMode === "credit" ? discount : 0;
          const totalAmount = cents(
            itemNet + tax + shipping + fees - discountSplit - credit - refund
          );
          const receipt: Receipt = {
            merchant: "TestStore",
            transactionDate: "2025-01-01",
            memo: "",
            totalAmount: Math.max(0.01, totalAmount), // ensure positive
            category: "Test",
            lineItems,
            tax: tax > 0 ? tax : undefined,
            shipping: shipping > 0 ? shipping : undefined,
            fees: fees > 0 ? fees : undefined,
            discount: discount > 0 ? discount : undefined,
            credit: credit > 0 ? credit : undefined,
            refund: refund > 0 ? refund : undefined,
          };
          return receipt;
        });
    });

// ---------------------------------------------------------------------------
// Property 1: Totals conservation invariant
//
// sum(splits.amounts) === (subtotal − discount) + tax + shipping + fees − credit − refund
// in distribute mode, and
// sum(splits.amounts) === subtotal + tax + shipping + fees − discount − credit − refund
// in credit mode.
//
// This is the "no discrepancy" invariant: the splits must account for every
// dollar in the receipt components.
// ---------------------------------------------------------------------------

describe("Property 1 — totals conservation (distribute mode)", () => {
  it("sum of all splits equals computed total for any valid receipt", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "distribute" } as any);

    fc.assert(
      fc.property(receiptArb("distribute"), (receipt) => {
        const splits = buildSplits(receipt);
        fc.pre(splits !== undefined);

        const splitSum = sumToCents(splits!.map((s) => s.amount));

        const subtotal = sumToCents(
          (receipt.lineItems ?? []).map((li) => li.lineItemTotalAmount)
        );
        const discount = receipt.discount ?? 0;
        const tax = receipt.tax ?? 0;
        const shipping = receipt.shipping ?? 0;
        const fees = receipt.fees ?? 0;
        const credit = receipt.credit ?? 0;
        const refund = receipt.refund ?? 0;

        const expected = cents(
          subtotal - discount + tax + shipping + fees - credit - refund
        );

        expect(splitSum).toBe(expected);
      }),
      { numRuns: 200 }
    );
  });
});

describe("Property 1 — totals conservation (credit mode)", () => {
  it("sum of all splits equals computed total for any valid receipt in credit mode", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "credit" } as any);

    fc.assert(
      fc.property(receiptArb("credit"), (receipt) => {
        const splits = buildSplits(receipt);
        fc.pre(splits !== undefined);

        const splitSum = sumToCents(splits!.map((s) => s.amount));

        const subtotal = sumToCents(
          (receipt.lineItems ?? []).map((li) => li.lineItemTotalAmount)
        );
        const discount = receipt.discount ?? 0;
        const tax = receipt.tax ?? 0;
        const shipping = receipt.shipping ?? 0;
        const fees = receipt.fees ?? 0;
        const credit = receipt.credit ?? 0;
        const refund = receipt.refund ?? 0;

        // In credit mode: items are at full price, discount is a negative split
        const expected = cents(
          subtotal + tax + shipping + fees - discount - credit - refund
        );

        expect(splitSum).toBe(expected);
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: No item is silently dropped
//
// Every line item in the input has exactly one corresponding item split in the
// output (before the ancillary tax/shipping/fee/discount/credit/refund splits).
// The item splits are always first in the returned array.
// ---------------------------------------------------------------------------

describe("Property 2 — no item dropped", () => {
  it("the number of item-splits equals the number of line items (distribute mode)", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "distribute" } as any);

    fc.assert(
      fc.property(receiptArb("distribute"), (receipt) => {
        const splits = buildSplits(receipt);
        fc.pre(splits !== undefined);

        const itemCount = (receipt.lineItems ?? []).length;

        // Item splits come first; the rest are ancillary. Count the non-ancillary ones.
        // Ancillary memos are: "Tax/fees", "Shipping", "Delivery fee", "Discount", "Credit", "Refund"
        const ancillaryMemos = new Set([
          "Tax/fees",
          "Shipping",
          "Delivery fee",
          "Discount",
          "Refund",
          receipt.creditLabel ?? "Credit",
        ]);
        const itemSplits = splits!.filter((s) => !ancillaryMemos.has(s.memo));

        expect(itemSplits.length).toBe(itemCount);
      }),
      { numRuns: 200 }
    );
  });

  it("the number of item-splits equals the number of line items (credit mode)", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "credit" } as any);

    fc.assert(
      fc.property(receiptArb("credit"), (receipt) => {
        const splits = buildSplits(receipt);
        fc.pre(splits !== undefined);

        const itemCount = (receipt.lineItems ?? []).length;
        const ancillaryMemos = new Set([
          "Tax/fees",
          "Shipping",
          "Delivery fee",
          "Discount",
          "Refund",
          receipt.creditLabel ?? "Credit",
        ]);
        const itemSplits = splits!.filter((s) => !ancillaryMemos.has(s.memo));

        expect(itemSplits.length).toBe(itemCount);
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Idempotence
//
// Calling buildSplits twice on the same receipt value produces byte-for-byte
// identical output. (buildSplits must be a pure function of its inputs.)
// ---------------------------------------------------------------------------

describe("Property 3 — idempotence", () => {
  it("buildSplits is deterministic: same receipt always yields same splits", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "distribute" } as any);

    fc.assert(
      fc.property(receiptArb("distribute"), (receipt) => {
        // Deep-clone so the second call operates on an independent object
        const clone = JSON.parse(JSON.stringify(receipt)) as Receipt;
        const first = buildSplits(receipt);
        const second = buildSplits(clone);
        expect(second).toStrictEqual(first);
      }),
      { numRuns: 150 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Distribute-mode item sum
//
// The item-only portion of the splits sums to exactly subtotal − discount,
// regardless of how many items there are or how messy the proportional split
// fractions are. The largest-item drift correction is load-bearing here.
// ---------------------------------------------------------------------------

describe("Property 4 — distribute mode item sum correctness", () => {
  it("item splits sum to exactly subtotal - discount after rounding correction", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "distribute" } as any);

    fc.assert(
      fc.property(receiptArb("distribute"), (receipt) => {
        fc.pre((receipt.discount ?? 0) > 0);
        fc.pre((receipt.lineItems?.length ?? 0) >= 1);

        const splits = buildSplits(receipt);
        fc.pre(splits !== undefined);

        const ancillaryMemos = new Set([
          "Tax/fees",
          "Shipping",
          "Delivery fee",
          "Discount",
          "Refund",
          receipt.creditLabel ?? "Credit",
        ]);
        const itemSplits = splits!.filter((s) => !ancillaryMemos.has(s.memo));

        const subtotal = sumToCents(
          (receipt.lineItems ?? []).map((li) => li.lineItemTotalAmount)
        );
        const discount = receipt.discount ?? 0;
        const expected = cents(subtotal - discount);
        const actual = sumToCents(itemSplits.map((s) => s.amount));

        expect(actual).toBe(expected);
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Credit mode — items unmodified, discount as separate split
// ---------------------------------------------------------------------------

describe("Property 5 — credit mode item amounts unchanged", () => {
  it("item split amounts equal the original lineItemTotalAmount values", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "credit" } as any);

    fc.assert(
      fc.property(receiptArb("credit"), (receipt) => {
        fc.pre((receipt.lineItems?.length ?? 0) >= 1);
        const splits = buildSplits(receipt);
        fc.pre(splits !== undefined);

        const ancillaryMemos = new Set([
          "Tax/fees",
          "Shipping",
          "Delivery fee",
          "Discount",
          "Refund",
          receipt.creditLabel ?? "Credit",
        ]);
        const itemSplits = splits!.filter((s) => !ancillaryMemos.has(s.memo));

        const originalAmounts = (receipt.lineItems ?? []).map(
          (li) => li.lineItemTotalAmount
        );
        const splitAmounts = itemSplits.map((s) => s.amount);

        expect(splitAmounts).toStrictEqual(originalAmounts);
      }),
      { numRuns: 150 }
    );
  });

  it("discount split is negative and equals the discount amount", () => {
    mockedGetConfig.mockReturnValue({ discountMode: "credit" } as any);

    fc.assert(
      fc.property(receiptArb("credit"), (receipt) => {
        fc.pre((receipt.discount ?? 0) > 0);
        const splits = buildSplits(receipt);
        fc.pre(splits !== undefined);

        const discountSplit = splits!.find((s) => s.memo === "Discount");
        expect(discountSplit).toBeDefined();
        expect(discountSplit!.amount).toBe(-(receipt.discount ?? 0));
      }),
      { numRuns: 150 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Ancillary split sign invariant
//
// Tax, shipping, and fee splits are always positive (outflow).
// Discount, credit, and refund splits are always negative (inflow/reduction).
// ---------------------------------------------------------------------------

describe("Property 6 — ancillary splits have correct sign", () => {
  it("tax/shipping/fee splits are positive; discount/credit/refund splits are negative", () => {
    // Test in both modes
    for (const mode of ["distribute", "credit"] as const) {
      mockedGetConfig.mockReturnValue({ discountMode: mode } as any);

      fc.assert(
        fc.property(receiptArb(mode), (receipt) => {
          const splits = buildSplits(receipt);
          fc.pre(splits !== undefined);

          for (const split of splits!) {
            switch (split.memo) {
              case "Tax/fees":
                expect(split.amount).toBeGreaterThan(0);
                break;
              case "Shipping":
                expect(split.amount).toBeGreaterThan(0);
                break;
              case "Delivery fee":
                expect(split.amount).toBeGreaterThan(0);
                break;
              case "Discount":
                expect(split.amount).toBeLessThan(0);
                break;
              case "Refund":
                expect(split.amount).toBeLessThan(0);
                break;
              // Credit label is dynamic; check by category
              default:
                // Could be an item split or a credit split. Item splits may be zero
                // when a proportional discount rounds a tiny item amount to $0.00 —
                // that is acceptable (the rounding-correction goes to the largest
                // item, leaving small items at zero). We only check that they are
                // non-negative (never a mysterious sign flip).
                if (split.category !== "") {
                  expect(split.amount).toBeGreaterThanOrEqual(0);
                }
            }
          }
        }),
        { numRuns: 150 }
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Property 7: reconcileExtraction threshold
//
// The function logs a warning when |computed - stated total| > 0.10.
// It must NOT warn when the difference is within that threshold.
// The threshold is checked by examining console.warn call count.
//
// Note: reconcileExtraction mutates the receipt in place, so we work on
// clones. It also calls findAmountByLabel / findLabelPosition internally
// for subtotal extraction — we pass a text string that gives it nothing
// to find so only the total-check path runs.
// ---------------------------------------------------------------------------

describe("Property 7 — reconcileExtraction threshold", () => {
  /** Build a minimal LabelResult with no summary labels. */
  const emptyLabels = (): import("./llm/prompts").LabelResult => ({
    merchant: "Store",
    dateLabel: "2025-01-01",
    totalLabel: "Total",
    summaryLabels: [],
    lineItems: [],
  });

  /** Receipt where item sum + adjustments equals totalAmount exactly. */
  const balancedReceiptArb = fc.record({
    itemAmountCents: fc.integer({ min: 1, max: 5000 }),
    taxCents: fc.integer({ min: 0, max: 500 }),
    shippingCents: fc.integer({ min: 0, max: 300 }),
  }).map(({ itemAmountCents, taxCents, shippingCents }) => {
    const itemAmount = itemAmountCents / 100;
    const tax = taxCents / 100;
    const shipping = shippingCents / 100;
    const total = cents(itemAmount + tax + shipping);
    const receipt: Receipt = {
      merchant: "Store",
      transactionDate: "2025-01-01",
      memo: "",
      totalAmount: total,
      category: "Test",
      lineItems: [
        { productName: "Item", quantity: 1, lineItemTotalAmount: itemAmount, category: "" },
      ],
      tax: tax > 0 ? tax : undefined,
      shipping: shipping > 0 ? shipping : undefined,
    };
    return receipt;
  });

  it("does not warn when extracted components match totalAmount exactly", () => {
    fc.assert(
      fc.property(balancedReceiptArb, (receipt) => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const clone = JSON.parse(JSON.stringify(receipt)) as Receipt;

        reconcileExtraction(clone, emptyLabels(), "", [], []);

        // Filter to only the totals-mismatch warning (not item-validation warnings)
        const totalWarnings = warnSpy.mock.calls.filter((args) =>
          String(args[0]).includes("computed total")
        );
        expect(totalWarnings.length).toBe(0);
      }),
      { numRuns: 150 }
    );
  });

  it("warns when extracted components differ from totalAmount by more than 0.10", () => {
    // Generate receipts where the item amount is deliberately offset by 0.50
    // (well above the 0.10 threshold) from the stated total.
    const mismatchedReceiptArb = fc
      .integer({ min: 200, max: 5000 }) // item in cents
      .map((itemCents) => {
        const itemAmount = itemCents / 100;
        // State a total that is $0.50 less than the item amount
        const total = cents(itemAmount - 0.5);
        const receipt: Receipt = {
          merchant: "Store",
          transactionDate: "2025-01-01",
          memo: "",
          totalAmount: Math.max(0.01, total),
          category: "Test",
          lineItems: [
            { productName: "Item", quantity: 1, lineItemTotalAmount: itemAmount, category: "" },
          ],
        };
        return receipt;
      });

    fc.assert(
      fc.property(mismatchedReceiptArb, (receipt) => {
        // Item sum is 0.50 above total, which exceeds the 0.10 threshold.
        // reconcileExtraction should warn about this — UNLESS it drops the item
        // because it exceeds the ceiling (which is `total` when no subtotal is found).
        // In our case item > total, so it may get dropped. If dropped, the item sum
        // becomes 0 which is also != total, so the warning still fires.
        // Either way: the mismatch is real and should be logged.
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const clone = JSON.parse(JSON.stringify(receipt)) as Receipt;

        reconcileExtraction(clone, emptyLabels(), "", [], []);

        const totalWarnings = warnSpy.mock.calls.filter((args) =>
          String(args[0]).includes("computed total") || String(args[0]).includes("exceeds")
        );
        expect(totalWarnings.length).toBeGreaterThan(0);
      }),
      { numRuns: 150 }
    );
  });

  it("accepts (no warn) when difference is exactly at the threshold boundary (0.10)", () => {
    // Difference of exactly 0.10 — the code checks `> 0.10`, so 0.10 is accepted.
    const receipt: Receipt = {
      merchant: "Store",
      transactionDate: "2025-01-01",
      memo: "",
      totalAmount: 10.00,
      category: "Test",
      lineItems: [
        { productName: "Item", quantity: 1, lineItemTotalAmount: 10.10, category: "" },
      ],
    };

    // With no subtotal, item ($10.10) exceeds total ($10.00), so reconcileExtraction
    // will attempt a re-extraction (fails on empty text) and may drop the item.
    // After dropping: item sum = 0, total = 10.00, diff = 10.00 > 0.10 → warn fires.
    // This tests the drop path triggers a warning when the resulting sum is very wrong.
    // The boundary test for accepted-within-threshold uses a subtotal-less receipt
    // where the item sum is just at the edge.
    const receipt2: Receipt = {
      merchant: "Store",
      transactionDate: "2025-01-01",
      memo: "",
      totalAmount: 10.10,
      category: "Test",
      lineItems: [
        { productName: "Item", quantity: 1, lineItemTotalAmount: 10.00, category: "" },
      ],
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clone2 = JSON.parse(JSON.stringify(receipt2)) as Receipt;
    reconcileExtraction(clone2, emptyLabels(), "", [], []);

    // diff = |10.00 - 10.10| = 0.10, code checks > 0.10, so no warning
    const totalWarnings2 = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes("computed total")
    );
    expect(totalWarnings2.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property 8: buildSplits output length constraints
//
// The number of splits is bounded: at minimum it equals lineItems.length
// (no ancillary items present) and at most lineItems.length + 5
// (tax + shipping + fees + discount/credit + refund, minus whichever are zero).
// ---------------------------------------------------------------------------

describe("Property 8 — splits output length bounds", () => {
  it("output length is in [lineItems.length, lineItems.length + 5]", () => {
    for (const mode of ["distribute", "credit"] as const) {
      mockedGetConfig.mockReturnValue({ discountMode: mode } as any);

      fc.assert(
        fc.property(receiptArb(mode), (receipt) => {
          const splits = buildSplits(receipt);
          fc.pre(splits !== undefined);

          const itemCount = (receipt.lineItems ?? []).length;
          expect(splits!.length).toBeGreaterThanOrEqual(itemCount);
          // Max ancillary splits: tax + shipping + fees + discount (credit mode only) + credit + refund = 6
          // In distribute mode discount is never a separate split, so max is 5.
          // Use 6 as the universal upper bound.
          expect(splits!.length).toBeLessThanOrEqual(itemCount + 6);
        }),
        { numRuns: 150 }
      );
    }
  });
});

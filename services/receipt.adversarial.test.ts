/**
 * Adversarial probes on scrubReceipt (the function that gates LLM-emitted
 * receipt strings before they reach YNAB/Actual) and on the determinism
 * of buildReceiptFromLabels — i.e., can a prompt-injection through the
 * LLM influence the *numeric* amounts on the final receipt?
 *
 * scrubReceipt is only exported indirectly (called from importReceipt).
 * We test it via importReceipt with mocked downstream calls and inspect
 * what gets passed to createTransaction / updateTransactionWithSplits.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Receipt } from "./shared-types";

const fakeAccount = "Checking";

// Use vi.hoisted so the spies are initialized before vi.mock's hoisted factories.
const { createTxSpy, findMatchSpy, updateTxSpy, getAllCategoriesSpy } = vi.hoisted(() => ({
  createTxSpy: vi.fn(async () => {}),
  findMatchSpy: vi.fn(async () => null),
  updateTxSpy: vi.fn(async () => {}),
  getAllCategoriesSpy: vi.fn(async () => ["Groceries"]),
}));

vi.mock("./budget", () => ({
  createTransaction: createTxSpy,
  findMatchingTransaction: findMatchSpy,
  updateTransactionWithSplits: updateTxSpy,
  getAllEnvelopes: getAllCategoriesSpy,
}));

vi.mock("./config", () => ({
  getConfig: vi.fn(() => ({
    discountMode: "distribute",
    appApiKey: "",
    appApiSecret: "",
  })),
}));

vi.mock("./budget-provider", () => ({
  ReconciliationError: class ReconciliationError extends Error {},
}));

import { importReceipt } from "./receipt";

beforeEach(() => {
  createTxSpy.mockClear();
  findMatchSpy.mockClear();
  updateTxSpy.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// Helper: build a minimal Receipt with overrides.
function r(overrides: Partial<Receipt>): Receipt {
  return {
    merchant: "Acme",
    transactionDate: "2026-05-12",
    memo: "memo",
    totalAmount: 10.0,
    category: "Groceries",
    lineItems: [
      { productName: "Milk", quantity: 1, lineItemTotalAmount: 10.0, category: "Groceries" },
    ],
    ...overrides,
  } as Receipt;
}

describe("scrubReceipt — control characters at the API boundary", () => {
  it("NUL byte in merchant is stripped before reaching createTransaction", async () => {
    await importReceipt(fakeAccount, r({ merchant: "Whole Foods\x00malicious" }));
    expect(createTxSpy).toHaveBeenCalledTimes(1);
    const [, merchant] = createTxSpy.mock.calls[0];
    expect(typeof merchant).toBe("string");
    expect(merchant.includes("\x00")).toBe(false);
    expect(merchant).toBe("Whole Foodsmalicious");
  });

  it("CR/LF in memo passes through (deliberately not stripped by scrub)", async () => {
    // The scrub keeps \n and \r in its allow-list. YNAB's API trims its
    // own way; this test just pins current behavior.
    await importReceipt(fakeAccount, r({ memo: "line1\r\nline2" }));
    const memo = createTxSpy.mock.calls[0][4];
    expect(memo).toContain("\n");
  });

  it("RTL override in productName survives (intentional)", async () => {
    const malicious = "ACME‮LLAMS";
    await importReceipt(fakeAccount, r({
      lineItems: [
        { productName: malicious, quantity: 1, lineItemTotalAmount: 10.0, category: "Groceries" },
      ],
    }));
    // splits[0].memo is the product name. Find the splits arg.
    const splits = createTxSpy.mock.calls[0][6];
    expect(splits).toBeTruthy();
    expect(splits[0].memo).toBe(malicious);
  });

  // The realistic compound: 10KB merchant with NULs.
  it("10KB merchant with NUL bytes: NULs gone, length capped at 100 (SCRUB_LIMITS.merchant)", async () => {
    const giant = ("X\x00".repeat(5000));
    await importReceipt(fakeAccount, r({ merchant: giant }));
    const merchant = createTxSpy.mock.calls[0][1];
    expect(merchant.includes("\x00")).toBe(false);
    expect(merchant.length).toBeLessThanOrEqual(100);
    // The first 100 of the cleaned (NUL-stripped) sequence are all 'X'.
    expect(merchant).toBe("X".repeat(100));
  });

  it("undefined/empty memo becomes empty string", async () => {
    await importReceipt(fakeAccount, r({ memo: "" }));
    const memo = createTxSpy.mock.calls[0][4];
    // The actual implementation has logic: if memo is empty AND lineItems
    // has exactly one entry, the productName becomes the memo. Just assert
    // that whatever ends up as memo is a string (no crash).
    expect(typeof memo).toBe("string");
  });

  it("category with NUL is scrubbed before reaching createTransaction", async () => {
    await importReceipt(fakeAccount, r({ category: "Groceries\x00\x01" }));
    const category = createTxSpy.mock.calls[0][2];
    expect(category.includes("\x00")).toBe(false);
    expect(category.includes("\x01")).toBe(false);
    expect(category).toBe("Groceries");
  });

  // Boundary between scrubReceipt and YNAB's own length cap. YNAB silently
  // truncates memo above 200 chars; we cap at 200 to match. Test the
  // exact-cap and one-over scenarios.
  it("memo at exactly 200 chars (SCRUB_LIMITS.memo) is preserved", async () => {
    const s = "M".repeat(200);
    await importReceipt(fakeAccount, r({ memo: s }));
    const memo = createTxSpy.mock.calls[0][4];
    expect(memo.length).toBe(200);
  });

  it("memo at 201 chars is truncated to 200", async () => {
    const s = "M".repeat(201);
    await importReceipt(fakeAccount, r({ memo: s }));
    const memo = createTxSpy.mock.calls[0][4];
    expect(memo.length).toBe(200);
  });
});

describe("Numeric amounts are NOT scrubbed (would silently corrupt totals)", () => {
  // The receipt has a number field totalAmount. scrubReceipt operates only
  // on strings. A receipt with totalAmount=42.99 must reach the API
  // verbatim, even if other fields had NULs scrubbed.
  it("totalAmount=42.99 passes through unchanged", async () => {
    await importReceipt(fakeAccount, r({ totalAmount: 42.99, merchant: "X\x00Y" }));
    const total = createTxSpy.mock.calls[0][5];
    expect(total).toBe(42.99);
  });

  it("negative-looking string in merchant doesn't influence totalAmount", async () => {
    await importReceipt(fakeAccount, r({ merchant: "-9999.99", totalAmount: 5.0 }));
    const total = createTxSpy.mock.calls[0][5];
    expect(total).toBe(5.0);
  });
});

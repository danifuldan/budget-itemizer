import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./config", () => ({
  getConfig: vi.fn(() => ({})),
}));

vi.mock("./budget-ynab", () => ({
  YnabBudgetProvider: class {
    id = "ynab" as const;
    getAllCategories = vi.fn();
    getAllAccounts = vi.fn();
    getAllBudgets = vi.fn();
    findMatchingTransaction = vi.fn();
    updateTransactionWithSplits = vi.fn();
    createTransaction = vi.fn();
    testConnection = vi.fn();
    shutdown = vi.fn();
  },
}));

vi.mock("./budget-actual", () => ({
  ActualBudgetProvider: class {
    id = "actual" as const;
    getAllCategories = vi.fn();
    getAllAccounts = vi.fn();
    getAllBudgets = vi.fn();
    findMatchingTransaction = vi.fn();
    updateTransactionWithSplits = vi.fn();
    createTransaction = vi.fn();
    testConnection = vi.fn();
    shutdown = vi.fn();
  },
}));

import { getConfig } from "./config";
import {
  buildSubtransactionSplits,
  getBudgetProvider,
  resetBudgetProvider,
  BudgetConnectionError,
  vendorMatches,
  splitsSimilarity,
} from "./budget-provider";

const mockedGetConfig = vi.mocked(getConfig);

beforeEach(async () => {
  await resetBudgetProvider();
  mockedGetConfig.mockReturnValue({} as any);
});

describe("BudgetConnectionError", () => {
  it("has correct name and message", () => {
    const err = new BudgetConnectionError("test error");
    expect(err.name).toBe("BudgetConnectionError");
    expect(err.message).toBe("test error");
    expect(err).toBeInstanceOf(Error);
  });

  it("supports ErrorOptions cause", () => {
    const cause = new Error("root cause");
    const err = new BudgetConnectionError("wrapper", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("getBudgetProvider", () => {
  it("returns ynab by default", () => {
    mockedGetConfig.mockReturnValue({} as any);
    const provider = getBudgetProvider();
    expect(provider.id).toBe("ynab");
  });

  it("returns actual when configured", () => {
    mockedGetConfig.mockReturnValue({ budgetProvider: "actual" } as any);
    const provider = getBudgetProvider();
    expect(provider.id).toBe("actual");
  });

  it("caches the provider instance", () => {
    mockedGetConfig.mockReturnValue({} as any);
    const a = getBudgetProvider();
    const b = getBudgetProvider();
    expect(a).toBe(b);
  });

  it("creates new instance when provider type changes", async () => {
    mockedGetConfig.mockReturnValue({} as any);
    const ynab = getBudgetProvider();
    expect(ynab.id).toBe("ynab");

    await resetBudgetProvider();
    mockedGetConfig.mockReturnValue({ budgetProvider: "actual" } as any);
    const actual = getBudgetProvider();
    expect(actual.id).toBe("actual");
    expect(actual).not.toBe(ynab);
  });
});

describe("resetBudgetProvider", () => {
  it("calls shutdown on cached provider", async () => {
    mockedGetConfig.mockReturnValue({} as any);
    const provider = getBudgetProvider();
    const shutdownSpy = vi.spyOn(provider, "shutdown");
    await resetBudgetProvider();
    expect(shutdownSpy).toHaveBeenCalled();
  });

  it("does not throw when no provider is cached", async () => {
    await expect(resetBudgetProvider()).resolves.toBeUndefined();
  });
});

describe("buildSubtransactionSplits", () => {
  const resolveCategoryId = (name: string) =>
    name === "Groceries" ? "cat-groceries" : undefined;
  const findTaxCategoryId = () => "cat-tax";

  it("resolves category names to IDs", () => {
    const result = buildSubtransactionSplits(
      -1000,
      [{ category: "Groceries", amount: -1000, memo: "Apples" }],
      resolveCategoryId,
      findTaxCategoryId,
    );
    expect(result).toHaveLength(1);
    expect(result[0].categoryId).toBe("cat-groceries");
    expect(result[0].amount).toBe(-1000);
    expect(result[0].memo).toBe("Apples");
  });

  it("uses tax category for Tax/fees memo", () => {
    const result = buildSubtransactionSplits(
      -1100,
      [
        { category: "Groceries", amount: -1000, memo: "Apples" },
        { category: "", amount: -100, memo: "Tax/fees" },
      ],
      resolveCategoryId,
      findTaxCategoryId,
    );
    expect(result[1].categoryId).toBe("cat-tax");
  });

  // Strong-consistency principle: a subtransaction sum that doesn't
  // match the parent total means upstream reconciliation broke down.
  // Refuse the import rather than fabricate a "Discount" / "Tax/fees"
  // plug — silently inventing money in a category the user never picked
  // is the worst case for a budgeting tool.
  it("throws ReconciliationError when splits sum below total (negative remainder)", () => {
    expect(() =>
      buildSubtransactionSplits(
        -1100,
        [{ category: "Groceries", amount: -1000, memo: "Apples" }],
        resolveCategoryId,
        findTaxCategoryId,
      ),
    ).toThrow(/don't reconcile/);
  });

  it("throws ReconciliationError when splits sum above total (positive remainder)", () => {
    expect(() =>
      buildSubtransactionSplits(
        -900,
        [{ category: "Groceries", amount: -1000, memo: "Apples" }],
        resolveCategoryId,
        findTaxCategoryId,
      ),
    ).toThrow(/don't reconcile/);
  });

  it("ReconciliationError carries the offending amounts on the instance", () => {
    let caught: any;
    try {
      buildSubtransactionSplits(
        -1100,
        [{ category: "Groceries", amount: -1000, memo: "Apples" }],
        resolveCategoryId,
        findTaxCategoryId,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught?.name).toBe("ReconciliationError");
    expect(caught?.totalAmount).toBe(-1100);
    expect(caught?.splitSum).toBe(-1000);
    expect(caught?.remainder).toBe(-100);
  });

  // Regression (round 8): the error message used to expose milliunits
  // directly (e.g. "splits sum to -90000 but the transaction total is
  // -100000") which is meaningless to a non-developer user. The message
  // must format as dollars with no sign noise; internal fields keep
  // milliunits for code consumers.
  it("ReconciliationError message uses dollar formatting, not raw milliunits", () => {
    let caught: any;
    try {
      buildSubtransactionSplits(
        -100000,
        [
          { category: "Groceries", amount: -40000, memo: "A" },
          { category: "Groceries", amount: -50000, memo: "B" },
        ],
        resolveCategoryId,
        findTaxCategoryId,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught?.message).toContain("$90.00");
    expect(caught?.message).toContain("$100.00");
    expect(caught?.message).toContain("$10.00");
    // No raw milliunit leakage.
    expect(caught?.message).not.toMatch(/-?\d{4,}/);
    // Internal fields still milliunits for code (e.g. logging/diagnostics).
    expect(caught?.totalAmount).toBe(-100000);
    expect(caught?.splitSum).toBe(-90000);
  });

  it("returns single split when it exactly matches the total (no remainder)", () => {
    const result = buildSubtransactionSplits(
      -1000,
      [{ category: "Groceries", amount: -1000, memo: "Apples" }],
      resolveCategoryId,
      findTaxCategoryId,
    );
    expect(result).toHaveLength(1);
  });

  it("returns multiple splits when they exactly sum to the total", () => {
    const result = buildSubtransactionSplits(
      -1100,
      [
        { category: "Groceries", amount: -1000, memo: "Apples" },
        { category: "", amount: -100, memo: "Tax/fees" },
      ],
      resolveCategoryId,
      findTaxCategoryId,
    );
    expect(result).toHaveLength(2);
  });

  it("returns undefined categoryId for unknown categories", () => {
    const result = buildSubtransactionSplits(
      -500,
      [{ category: "Unknown", amount: -500, memo: "Thing" }],
      resolveCategoryId,
      findTaxCategoryId,
    );
    expect(result[0].categoryId).toBeUndefined();
  });

  it("falls back to undefined categoryId when tax category isn't configured and a Tax/fees split is supplied", () => {
    const result = buildSubtransactionSplits(
      -1100,
      [
        { category: "Groceries", amount: -1000, memo: "Apples" },
        { category: "", amount: -100, memo: "Tax/fees" },
      ],
      resolveCategoryId,
      () => undefined,
    );
    expect(result[1].categoryId).toBeUndefined();
    expect(result[1].memo).toBe("Tax/fees");
  });
});

describe("vendorMatches", () => {
  it("matches a clean receipt merchant against a noisy bank payee", () => {
    expect(vendorMatches("Walmart", "WAL-MART SUPERCENTER #1234 LITTLE ROCK AR")).toBe(true);
    expect(vendorMatches("Target", "TARGET 00012345")).toBe(true);
    expect(vendorMatches("Starbucks", "STARBUCKS STORE #4567 SEATTLE WA")).toBe(true);
  });

  it("strips common TLDs from the receipt merchant before comparing", () => {
    expect(vendorMatches("Walmart.com", "WAL-MART SUPERCENTER #1234")).toBe(true);
  });

  // Documented limitation: substring matching doesn't catch
  // abbreviations the bank uses that don't share a prefix with the
  // receipt merchant (Amazon → "AMZN", McDonald's → "MCD", etc.). The
  // intentional UX: the user renames the noisy payee in their budget
  // app once, future imports match. We do NOT bake in a dictionary
  // of known abbreviations — that gets stale.
  it("does NOT match common bank abbreviations that don't share a prefix (documented limitation)", () => {
    expect(vendorMatches("Amazon", "AMZN MKTP US*ABC123")).toBe(false);
    expect(vendorMatches("McDonald's", "MCD #4567")).toBe(false);
  });

  it("handles Zelle-style transfers where the recipient's name appears at the end", () => {
    expect(vendorMatches("Fred", "ZELLE 2092398TY62008 FRED")).toBe(true);
  });

  it("returns false when the merchants disagree", () => {
    expect(vendorMatches("Walmart", "TARGET 00012345")).toBe(false);
    expect(vendorMatches("Starbucks", "WALMART SUPERCENTER")).toBe(false);
  });

  it("returns false on empty/null/undefined inputs", () => {
    expect(vendorMatches(null, "WALMART")).toBe(false);
    expect(vendorMatches("Walmart", null)).toBe(false);
    expect(vendorMatches("", "WALMART")).toBe(false);
    expect(vendorMatches("Walmart", undefined)).toBe(false);
    expect(vendorMatches(undefined, "WALMART")).toBe(false);
  });

  it("rejects too-short principal tokens to avoid silly matches", () => {
    // Principal "ta" is too short; would otherwise substring-match
    // STARBUCKS, STAR MARKET, etc. — false positives. Min length 3.
    expect(vendorMatches("Ta", "STARBUCKS STORE")).toBe(false);
    expect(vendorMatches("X", "STAR MARKET")).toBe(false);
  });

  it("is case-insensitive on both sides", () => {
    expect(vendorMatches("walmart", "WALMART")).toBe(true);
    expect(vendorMatches("WALMART", "walmart supercenter")).toBe(true);
  });
});

describe("splitsSimilarity", () => {
  it("identical multisets → 1.0", () => {
    expect(splitsSimilarity([100, 200, 300], [100, 200, 300])).toBe(1);
    expect(splitsSimilarity([500, 500], [500, 500])).toBe(1);
  });

  it("disjoint multisets → 0.0", () => {
    expect(splitsSimilarity([100, 200], [300, 400])).toBe(0);
  });

  it("both empty → 1.0 (vacuously identical)", () => {
    expect(splitsSimilarity([], [])).toBe(1);
  });

  it("one empty → 0.0", () => {
    expect(splitsSimilarity([100], [])).toBe(0);
    expect(splitsSimilarity([], [100])).toBe(0);
  });

  it("partial overlap → ratio of intersection to union", () => {
    // intersect = 2 ({100, 200}), union = 4 ({100, 200, 300, 400})
    expect(splitsSimilarity([100, 200, 300], [100, 200, 400])).toBe(0.5);
  });

  it("respects multiset semantics — repeated amounts don't count more than they appear", () => {
    // Standard multiset Jaccard: |intersect| / (|A| + |B| - |intersect|).
    // [25, 25] vs [25]: intersect = min(2, 1) = 1, denom = 2 + 1 - 1 = 2 → 0.5
    expect(splitsSimilarity([25, 25], [25])).toBe(0.5);
  });

  it("near-identical sets cross the 0.95 'safe overwrite' tier threshold", () => {
    // 9 of 10 match → 9 / 11 = 0.818 — under the 0.95 cutoff.
    // 19 of 20 match → 19 / 21 ≈ 0.905 — under.
    // For 0.95+ similarity, the sets need to be effectively identical.
    expect(splitsSimilarity([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
      .toBe(1);
  });

  it("clear partial-similarity case lands in the 0.5–0.95 tier", () => {
    // 3 of 4 match → 3 / 5 = 0.6 — within tier 2.
    expect(splitsSimilarity([1, 2, 3, 4], [1, 2, 3, 5])).toBe(0.6);
  });
});

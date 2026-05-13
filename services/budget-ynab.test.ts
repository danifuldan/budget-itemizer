import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as ynab from "ynab";
import { retrieveSubtransactions } from "./budget-ynab";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

/**
 * Helper to build a minimal BudgetDetailResponse with categories.
 */
const makeBudget = (
  categories: { name: string; id: string }[]
): ynab.BudgetDetailResponse =>
  ({
    data: {
      budget: {
        categories: categories.map((c) => ({
          ...c,
          category_group_id: "group-1",
          budgeted: 0,
          activity: 0,
          balance: 0,
          hidden: false,
          deleted: false,
          note: null,
          goal_type: null,
          goal_creation_month: null,
          goal_target: null,
          goal_target_month: null,
          goal_percentage_complete: null,
          goal_months_to_budget: null,
          goal_under_funded: null,
          goal_overall_funded: null,
          goal_overall_left: null,
          original_category_group_id: null,
        })),
      },
      server_knowledge: 0,
    },
  }) as unknown as ynab.BudgetDetailResponse;

describe("retrieveSubtransactions", () => {
  it("returns splits that sum to total (no remainder)", () => {
    const budget = makeBudget([
      { name: "Groceries", id: "cat-1" },
      { name: "Personal Care", id: "cat-2" },
    ]);
    const splits = [
      { category: "Groceries", amount: -5000, memo: "Bread" },
      { category: "Personal Care", amount: -3000, memo: "Soap" },
    ];
    const result = retrieveSubtransactions(budget, -8000, splits);
    expect(result).toHaveLength(2);
    expect(result[0].amount).toBe(-5000);
    expect(result[0].category_id).toBe("cat-1");
    expect(result[1].amount).toBe(-3000);
    expect(result[1].category_id).toBe("cat-2");
  });

  // Strong-consistency principle: subtransaction sums must equal the
  // parent total. Previously, the splitter silently inserted a "Tax/fees"
  // or "Discount" plug to balance the books — but that fabricated phantom
  // money in categories the user never picked. The current behavior
  // refuses the import; the user must fix the line items first.
  it("throws when splits sum below total (caller fed mismatched data)", () => {
    const budget = makeBudget([
      { name: "Groceries", id: "cat-1" },
      { name: "Tax", id: "cat-tax" },
    ]);
    const splits = [{ category: "Groceries", amount: -7000, memo: "Food" }];
    expect(() => retrieveSubtransactions(budget, -8000, splits)).toThrow(/don't reconcile/);
  });

  it("sets category_id when category found", () => {
    const budget = makeBudget([{ name: "Electronics", id: "cat-e" }]);
    const splits = [
      { category: "Electronics", amount: -10000, memo: "Cable" },
    ];
    const result = retrieveSubtransactions(budget, -10000, splits);
    expect(result[0].category_id).toBe("cat-e");
  });

  it("sets undefined category_id when category not found and warns", () => {
    const budget = makeBudget([{ name: "Groceries", id: "cat-1" }]);
    const splits = [
      { category: "NonExistent", amount: -5000, memo: "Mystery" },
    ];
    const result = retrieveSubtransactions(budget, -5000, splits);
    expect(result[0].category_id).toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it("throws when splits exceed total (positive remainder)", () => {
    const budget = makeBudget([
      { name: "Food", id: "cat-f" },
      { name: "Tax", id: "cat-t" },
    ]);
    const splits = [{ category: "Food", amount: -11000, memo: "Lunch" }];
    expect(() => retrieveSubtransactions(budget, -10000, splits)).toThrow(/don't reconcile/);
  });

  it("accepts a 2-split set that exactly sums to total", () => {
    const budget = makeBudget([
      { name: "Food", id: "cat-f" },
      { name: "Tax", id: "cat-t" },
    ]);
    const splits = [
      { category: "Food", amount: -9500, memo: "Lunch" },
      { category: "", amount: -500, memo: "Tax/fees" },
    ];
    const result = retrieveSubtransactions(budget, -10000, splits);
    expect(result).toHaveLength(2);
    expect(result[0].amount).toBe(-9500);
    expect(result[1].amount).toBe(-500);
    expect(result[1].category_id).toBe("cat-t");
  });
});

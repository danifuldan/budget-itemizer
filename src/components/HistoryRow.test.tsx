// @vitest-environment happy-dom
// Regression: the swipe-to-delete background became a real <button> in
// the a11y pass (commit 3cc5d45). CSS keeps it `opacity: 0;
// pointer-events: none` until swipe-revealed, but pointer-events: none
// doesn't block focus or keyboard activation. A keyboard user could
// Tab to an invisible button and Enter through it — destroying a
// history record without confirmation. The fix toggles tabIndex/aria-
// hidden based on the `revealed` state.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import HistoryRow from "./HistoryRow";
import type { ImportRecord } from "../api/types";

const fakeRecord: ImportRecord = {
  id: "1",
  filename: "walmart.pdf",
  merchant: "Walmart",
  totalAmount: 42.99,
  itemCount: 3,
  transactionDate: "2026-05-01",
  importedAt: "2026-05-01T12:00:00Z",
  success: true,
} as any;

describe("HistoryRow — keyboard accessibility of the swipe-to-delete button", () => {
  it("delete button is not in the tab order while the row is collapsed (default)", () => {
    render(<HistoryRow record={fakeRecord} onClick={() => {}} onDelete={vi.fn()} />);
    const deleteButton = screen.getByLabelText("Delete Walmart record");
    expect(deleteButton.getAttribute("tabindex")).toBe("-1");
    expect(deleteButton.getAttribute("aria-hidden")).toBe("true");
  });
});

// Parse failures never produced a receipt, so merchant / totalAmount /
// itemCount are all empty/zero. Rendering them with the regular layout
// gives "" / $0.00 / 0 items — useless and ugly. The component switches
// to a filename + error-message layout for that shape.
describe("HistoryRow — parse-failure rendering", () => {
  const parseFailureRecord: ImportRecord = {
    id: "pf-1",
    filename: "broken-photo.jpg",
    merchant: "",
    totalAmount: 0,
    itemCount: 0,
    transactionDate: "",
    importedAt: "2026-05-27T12:00:00Z",
    success: false,
    error: "OCR couldn't extract any text from the image",
    // crucially: no `receipt` — that's the discriminator vs import failures
  } as any;

  it("shows the filename + error message (NOT $0.00 / 0 items)", () => {
    render(<HistoryRow record={parseFailureRecord} />);
    expect(screen.getByText("broken-photo.jpg")).toBeTruthy();
    expect(screen.getByText("OCR couldn't extract any text from the image")).toBeTruthy();
    // Negative assertions: the noisy "empty receipt" fields should NOT render
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText(/0 items/)).toBeNull();
  });

  it("still shows the Failed badge so the row is visually distinguishable", () => {
    render(<HistoryRow record={parseFailureRecord} />);
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  // Import failures (parse succeeded → import then failed) keep the
  // existing layout — they have a populated receipt + merchant/total.
  // The discriminator is `success: false && !receipt`; an import failure
  // has `receipt` set even though `success` is false.
  it("import-failure records (success=false but receipt present) keep the merchant + amount layout", () => {
    const importFailure: ImportRecord = {
      id: "if-1",
      filename: "costco.pdf",
      merchant: "Costco",
      totalAmount: 47.32,
      itemCount: 5,
      transactionDate: "2026-05-27",
      importedAt: "2026-05-27T12:00:00Z",
      success: false,
      error: "YNAB API: account not found",
      receipt: { merchant: "Costco" } as any,
    } as any;
    render(<HistoryRow record={importFailure} />);
    expect(screen.getByText("Costco")).toBeTruthy();
    expect(screen.getByText("$47.32")).toBeTruthy();
    expect(screen.getByText(/5 items/)).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    // The error string only shows in the parse-failure layout, NOT here.
    expect(screen.queryByText("YNAB API: account not found")).toBeNull();
  });
});

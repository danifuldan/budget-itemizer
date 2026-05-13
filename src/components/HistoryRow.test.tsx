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

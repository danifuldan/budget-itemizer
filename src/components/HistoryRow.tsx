import { useRef, useEffect, useCallback, useState } from "react";
import type { ImportRecord } from "../api/types";

interface HistoryRowProps {
  record: ImportRecord;
  onClick?: () => void;
  onDelete?: () => void;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr || "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function timeAgo(isoStr: string): string {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "";
  const now = Date.now();
  const sec = Math.round((now - d.getTime()) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return formatDate(isoStr);
}

function formatAmount(amount: number): string {
  return `$${Math.abs(amount).toFixed(2)}`;
}

const REVEAL_WIDTH = 80;
const SNAP_THRESHOLD = 40; // past halfway snaps open

export default function HistoryRow({ record, onClick, onDelete }: HistoryRowProps) {
  const monogram = record.merchant ? record.merchant.charAt(0).toUpperCase() : "?";

  const wrapperRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [revealed, setRevealed] = useState(false);

  // Apply transform without re-render
  const applyOffset = useCallback((value: number) => {
    offset.current = value;
    if (rowRef.current) {
      rowRef.current.style.transform = value ? `translateX(${-value}px)` : "";
    }
  }, []);

  // Snap to revealed or hidden
  const snapTo = useCallback((open: boolean) => {
    const row = rowRef.current;
    const wrapper = wrapperRef.current;
    if (!row) return;
    row.classList.remove("swiping");
    applyOffset(open ? REVEAL_WIDTH : 0);
    setRevealed(open);
    if (open) {
      wrapper?.classList.add("revealed");
    } else {
      wrapper?.classList.remove("revealed");
    }
  }, [applyOffset]);

  // Close when clicking outside
  useEffect(() => {
    if (!revealed) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        snapTo(false);
      }
    };
    document.addEventListener("pointerdown", handleClickOutside, true);
    return () => document.removeEventListener("pointerdown", handleClickOutside, true);
  }, [revealed, snapTo]);

  // Wheel-based swipe
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !onDelete) return;

    const handleWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) return;
      if (Math.abs(e.deltaX) < 3) return;

      e.preventDefault();

      // Accumulate but clamp to [0, REVEAL_WIDTH]
      const next = Math.max(0, Math.min(REVEAL_WIDTH, offset.current + e.deltaX));
      applyOffset(next);
      row.classList.add("swiping");
      if (next > 0) wrapperRef.current?.classList.add("revealed");

      // Settle when scrolling stops
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        snapTo(offset.current >= SNAP_THRESHOLD);
      }, 150);
    };

    row.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      row.removeEventListener("wheel", handleWheel);
      if (settleTimer.current) {
        clearTimeout(settleTimer.current);
        // Settle timer was cleared before it could reset — clean up now
        offset.current = 0;
        row.style.transform = "";
        row.classList.remove("swiping");
        wrapperRef.current?.classList.remove("revealed");
      }
    };
  }, [onDelete, applyOffset, snapTo]);

  const handleClick = useCallback(() => {
    // Only suppress click when delete zone is visually revealed —
    // check DOM class, not React state, to avoid stale state from HMR
    if (wrapperRef.current?.classList.contains("revealed")) {
      snapTo(false);
      return;
    }
    onClick?.();
  }, [onClick, snapTo]);

  const handleDelete = useCallback(() => {
    const row = rowRef.current;
    const wrapper = wrapperRef.current;
    if (!row || !wrapper) { onDelete?.(); return; }

    row.classList.remove("swiping");
    row.classList.add("slide-out-left");
    wrapper.classList.add("collapsing");
    wrapper.addEventListener("animationend", () => onDelete?.(), { once: true });
  }, [onDelete]);

  const ariaLabel = `${record.merchant}, ${formatAmount(record.totalAmount)}, ${record.itemCount} items, ${record.success ? "imported" : "failed"}`;

  return (
    <div className="history-row-wrapper" ref={wrapperRef}>
      <button
        type="button"
        className="history-row-delete-bg"
        onClick={handleDelete}
        aria-label={`Delete ${record.merchant} record`}
        // Hidden behind the row (CSS opacity:0, pointer-events:none) until
        // the user swipes to reveal. pointer-events:none doesn't block
        // keyboard focus, so without this a Tab user lands on an invisible
        // delete button and Enter destroys the record without confirmation.
        tabIndex={revealed ? 0 : -1}
        aria-hidden={!revealed}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        </svg>
      </button>
      <div
        ref={rowRef}
        className={`history-row${onClick ? " clickable" : ""}`}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (!onClick) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        aria-label={onClick ? ariaLabel : undefined}
      >
        <div className="history-icon" aria-hidden="true">{monogram}</div>
        <div className="history-info">
          <div className="history-merchant">{record.merchant}</div>
          <div className="history-meta">
            {formatDate(record.transactionDate)}
            {record.importedAt && (
              <span className="history-time-ago">{timeAgo(record.importedAt)}</span>
            )}
            <span className={`badge ${record.success ? "badge-green" : "badge-red"}`}>
              {record.success ? "Imported" : "Failed"}
            </span>
          </div>
        </div>
        <div className="history-amount">
          <div className="history-amount-value">{formatAmount(record.totalAmount)}</div>
          <div className="history-amount-detail">
            {record.itemCount} item{record.itemCount !== 1 ? "s" : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

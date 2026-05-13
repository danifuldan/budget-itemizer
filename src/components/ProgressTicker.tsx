interface ProgressTickerProps {
  status: string;
  itemCount: number;
  done: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  "reading-pdf": "Reading PDF...",
  "label-extraction": "Extracting vendor & date...",
  "extracting-items": "Finding line items...",
  "extracting-totals": "Calculating totals...",
  "categorizing": "Assigning categories...",
};

export default function ProgressTicker({ status, itemCount, done }: ProgressTickerProps) {
  if (done) return null;

  const label = STATUS_LABELS[status] || "Processing...";

  const percent =
    status === "reading-pdf" ? 10 :
    status === "label-extraction" ? 20 :
    status === "extracting-items" ? Math.min(30 + itemCount * 10, 70) :
    status === "extracting-totals" ? 75 :
    status === "categorizing" ? 90 :
    Math.min(itemCount * 15, 75);

  const itemText = itemCount > 0 ? `, ${itemCount} item${itemCount !== 1 ? "s" : ""}` : "";

  return (
    <>
      <div className="progress-ticker" role="status" aria-live="polite" aria-atomic="true">
        <div className="ticker-inner">
          <div className="ticker-left">
            <div className="ticker-spinner" aria-hidden="true" />
            <span className="ticker-text">{label}</span>
          </div>
          {itemCount > 0 && (
            <span className="ticker-count">
              {itemCount} item{itemCount !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        {/* Visually hidden combined announcement so screen readers get one
            coherent update per status change instead of two split spans. */}
        <span className="visually-hidden">{label}{itemText}</span>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={label}
      >
        <div
          className="progress-fill"
          style={{ width: `${percent}%` }}
        />
      </div>
    </>
  );
}

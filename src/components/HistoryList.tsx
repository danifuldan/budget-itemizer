import type { ImportRecord } from "../api/types";
import HistoryRow from "./HistoryRow";

interface HistoryListProps {
  history: ImportRecord[];
  onView: (record: ImportRecord) => void;
  onRemove?: (id: string) => void;
}

export default function HistoryList({ history, onView, onRemove }: HistoryListProps) {
  return (
    <section className="history" aria-labelledby="history-heading">
      <div className="history-head">
        <h2 id="history-heading" className="history-title">Recent Imports</h2>
        <span className="history-count" aria-label={`${history.length} imports`}>{history.length}</span>
      </div>
      {history.length === 0 ? (
        <div className="empty-history">
          <svg className="empty-history-icon" width="36" height="36" viewBox="0 0 36 36" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="6" y="4" width="24" height="28" rx="3" />
            <line x1="12" y1="12" x2="24" y2="12" />
            <line x1="12" y1="18" x2="20" y2="18" />
            <line x1="12" y1="24" x2="22" y2="24" />
          </svg>
          <div className="empty-history-text">No imports yet</div>
          <div className="empty-history-hint">Drop a receipt PDF above to get started</div>
        </div>
      ) : (
        history.map((record) => (
          <HistoryRow
            key={record.id}
            record={record}
            onClick={record.receipt ? () => onView(record) : undefined}
            onDelete={onRemove ? () => onRemove(record.id) : undefined}
          />
        ))
      )}
    </section>
  );
}

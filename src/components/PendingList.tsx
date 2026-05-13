import { useRef, useEffect } from "react";
import type { PendingFileInfo } from "../hooks/useWatcherEvents";

interface PendingListProps {
  files: PendingFileInfo[];
  onReview: (filename: string) => void;
  onSkip: (filename: string, detectedAt: string) => void;
  onImport: (filename: string) => void;
  importingFile: string | null;
  progressMap?: Record<string, number>;
}

/** Track which filenames have already been rendered so only new ones animate. */
function useNewItemKeys(files: PendingFileInfo[]): Set<string> {
  const seen = useRef<Set<string>>(new Set());
  const newKeys = new Set<string>();

  for (const f of files) {
    if (!seen.current.has(f.filename)) {
      newKeys.add(f.filename);
    }
  }

  useEffect(() => {
    for (const f of files) {
      seen.current.add(f.filename);
    }
  });

  return newKeys;
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatAmount(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export default function PendingList({ files, onReview, onSkip, onImport, importingFile, progressMap = {} }: PendingListProps) {
  const newKeys = useNewItemKeys(files);

  if (files.length === 0) return null;

  return (
    <section className="pending-list" aria-labelledby="pending-list-heading">
      <div className="pending-head">
        <h2 id="pending-list-heading" className="history-title">Pending Review</h2>
        <span className="history-count" aria-label={`${files.length} pending`}>{files.length}</span>
      </div>
      {files.map((file) => {
        const progress = progressMap[file.filename];
        const isClickable = file.status !== "error";
        const ariaLabel = file.status === "ready" && file.receipt
          ? `Review ${file.receipt.merchant}, ${formatAmount(file.receipt.totalAmount)}`
          : `Review ${file.filename}`;
        return (
          <div key={file.filename} className={`pending-item${newKeys.has(file.filename) ? " animate-in" : ""}`}>
            {progress != null && progress < 1 && (
              <div
                className="pending-progress-fill"
                style={{ width: `${Math.round(progress * 100)}%` }}
                aria-hidden="true"
              />
            )}
            {isClickable ? (
              <button
                type="button"
                className="pending-item-info clickable"
                onClick={() => onReview(file.filename)}
                aria-label={ariaLabel}
              >
                <PendingItemBody file={file} />
              </button>
            ) : (
              <div className="pending-item-info">
                <PendingItemBody file={file} />
              </div>
            )}
            <div className="pending-item-actions">
              <button className="btn btn-sm btn-secondary" onClick={() => onSkip(file.filename, file.detectedAt)}>
                {file.status === "parsing" ? "Cancel" : "Discard"}
              </button>
              <button className="btn btn-sm btn-outline" onClick={() => onReview(file.filename)}>
                View
              </button>
              {file.status === "ready" && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => onImport(file.filename)}
                  disabled={importingFile === file.filename}
                >
                  {importingFile === file.filename ? "Importing..." : "Import"}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function PendingItemBody({ file }: { file: PendingFileInfo }) {
  if (file.status === "ready" && file.receipt) {
    return (
      <>
        <div className="pending-item-name">{file.receipt.merchant}</div>
        <div className="pending-item-detail">
          {formatAmount(file.receipt.totalAmount)}
          {file.receipt.lineItems && file.receipt.lineItems.length > 0 && (
            <> &middot; {file.receipt.lineItems.length} item{file.receipt.lineItems.length !== 1 ? "s" : ""}</>
          )}
          <> &middot; {timeAgo(file.detectedAt)}</>
        </div>
      </>
    );
  }
  if (file.status === "error") {
    return (
      <>
        <div className="pending-item-name">{file.filename}</div>
        <div className="pending-item-error">{file.parseError || "Parse failed"}</div>
      </>
    );
  }
  return (
    <>
      <div className="pending-item-name">{file.filename}</div>
      <div className="pending-item-detail pending-parsing" aria-live="polite">
        Parsing&hellip;
      </div>
    </>
  );
}

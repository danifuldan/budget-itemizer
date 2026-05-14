import { useState, useRef, type DragEvent, type KeyboardEvent } from "react";

interface DropZoneProps {
  onFile: (file: File) => void;
  /** When false, the drop zone shows a non-actionable "AI model loading"
   *  state — drops bounce, the file picker doesn't open. Prevents drops
   *  from reaching the parse endpoint before llama-server is up (which
   *  would surface as a confusing error). */
  llmReady: boolean;
}

export default function DropZone({ onFile, llmReady }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const disabled = !llmReady;

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (disabled) return;
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files[0];
    if (file?.type === "application/pdf") {
      onFile(file);
    }
  };

  const handleClick = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFile(file);
      e.target.value = "";
    }
  };

  return (
    <div className="dropzone-area">
      <button
        type="button"
        className={`dropzone${isDragging ? " dragging" : ""}${disabled ? " disabled" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-label={
          disabled
            ? "Loading AI model. Drops will be accepted once the model is ready."
            : "Drop a receipt PDF or click to browse for a file"
        }
        aria-disabled={disabled}
      >
        <svg
          className="dropzone-icon"
          viewBox="0 0 52 52"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="13" y="5" width="26" height="34" rx="4" />
          <line x1="19" y1="14" x2="33" y2="14" />
          <line x1="19" y1="20" x2="33" y2="20" />
          <line x1="19" y1="26" x2="28" y2="26" />
          <path d="M26 39v9" />
          <path d="M22 44l4 4 4-4" />
        </svg>
        <span className="dropzone-label">
          {disabled ? "Loading AI model…" : "Drop a receipt PDF here"}
        </span>
        <span className="dropzone-hint">
          {disabled ? "Drops accepted once the model is ready" : "or click to browse"}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        onChange={handleChange}
        style={{ display: "none" }}
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}

import { useState, useEffect } from "react";

interface ItemRowProps {
  name: string;
  quantity?: number;
  amount: number;
  category?: string;
  availableCategories: string[];
  onCategoryChange: (category: string) => void;
  onNameChange: (name: string) => void;
  onAmountChange: (amount: number) => void;
  onDelete: () => void;
}

export default function ItemRow({
  name,
  quantity,
  amount,
  category,
  availableCategories,
  onCategoryChange,
  onNameChange,
  onAmountChange,
  onDelete,
}: ItemRowProps) {
  const [amountStr, setAmountStr] = useState(amount.toFixed(2));

  useEffect(() => setAmountStr(amount.toFixed(2)), [amount]);

  const itemLabel = name || "Line item";

  return (
    <div className={`item-row${!category ? " missing" : ""}`}>
      <div className="item-info">
        <div className="item-name">
          <input
            className="item-name-input"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            aria-label={`Item name: ${itemLabel}`}
          />
          {quantity && quantity > 1 && (
            <span className="item-qty"> &times; {quantity}</span>
          )}
        </div>
        <select
          className={`item-category-select${!category ? " placeholder" : ""}`}
          value={category || ""}
          onChange={(e) => onCategoryChange(e.target.value)}
          aria-label={`Category for ${itemLabel}`}
        >
          <option value="" disabled>
            Select category...
          </option>
          {availableCategories.map((cat) => (
            <option key={cat} value={cat}>
              {cat}
            </option>
          ))}
        </select>
      </div>
      <input
        className="item-amount-input"
        value={amountStr}
        onChange={(e) => setAmountStr(e.target.value)}
        onBlur={() => {
          const parsed = parseFloat(amountStr);
          if (!isNaN(parsed)) onAmountChange(parsed);
          else setAmountStr(amount.toFixed(2));
        }}
        aria-label={`Amount for ${itemLabel}`}
        inputMode="decimal"
      />
      <button
        className="item-del"
        onClick={onDelete}
        type="button"
        aria-label={`Remove ${itemLabel}`}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.5" />
          <path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" />
        </svg>
      </button>
    </div>
  );
}

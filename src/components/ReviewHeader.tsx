interface ReviewHeaderProps {
  merchant: string;
  transactionDate: string;
  onMerchantChange: (merchant: string) => void;
  onDateChange: (date: string) => void;
}

export default function ReviewHeader({
  merchant,
  transactionDate,
  onMerchantChange,
  onDateChange,
}: ReviewHeaderProps) {
  return (
    <div className="review-header">
      <input
        id="review-merchant"
        type="text"
        className="merchant-input"
        value={merchant}
        onChange={(e) => onMerchantChange(e.target.value)}
        aria-label="Merchant name"
      />
      <div className="meta-grid">
        <div>
          <label className="meta-label" htmlFor="review-date">Date</label>
          <input
            id="review-date"
            type="date"
            className="meta-input"
            value={transactionDate}
            onChange={(e) => onDateChange(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

interface ReviewFooterProps {
  accounts: string[];
  selectedAccount: string;
  onAccountChange: (account: string) => void;
  onDiscard?: () => void;
  onImport: () => void;
  importDisabled: boolean;
  importing: boolean;
}

export default function ReviewFooter({
  accounts,
  selectedAccount,
  onAccountChange,
  onDiscard,
  onImport,
  importDisabled,
  importing,
}: ReviewFooterProps) {
  return (
    <div className="review-footer">
      <div className="account-row">
        <label className="account-label" htmlFor="review-account">Import to</label>
        <select
          id="review-account"
          className="account-select"
          value={selectedAccount}
          onChange={(e) => onAccountChange(e.target.value)}
        >
          {accounts.length === 0 && <option value="">Loading accounts...</option>}
          {accounts.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <div className="actions-row">
        {onDiscard && (
          <button className="btn btn-danger" onClick={onDiscard}>
            Discard
          </button>
        )}
        <button
          className="btn btn-primary"
          onClick={onImport}
          disabled={importDisabled || importing}
        >
          {importing ? "Importing..." : "Import to YNAB"}
        </button>
      </div>
    </div>
  );
}

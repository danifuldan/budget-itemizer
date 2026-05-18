import type { AccountRef } from "../api/types";

interface ReviewFooterProps {
  accounts: AccountRef[];
  /** The selected account *id* (identity), not its display name. */
  selectedAccount: string;
  onAccountChange: (accountId: string) => void;
  /** Fired when the account picker is about to open — used to resync the
   *  list so a YNAB-side rename shows immediately. */
  onOpen?: () => void;
  onDiscard?: () => void;
  onImport: () => void;
  importDisabled: boolean;
  importing: boolean;
}

export default function ReviewFooter({
  accounts,
  selectedAccount,
  onAccountChange,
  onOpen,
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
          onMouseDown={onOpen}
          onFocus={onOpen}
        >
          {accounts.length === 0 && <option value="">Loading accounts...</option>}
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
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

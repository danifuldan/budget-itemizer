// Cross-tier types shared between the Node sidecar (services/, app/) and
// the Tauri frontend (src/). Anything defined here must be safe to import
// from both sides — no Node-only or browser-only references.
//
// History before this file: Receipt and ReceiptLineItem lived in two
// separate copies (services/shared-types.ts + src/api/types.ts), and
// ImportRecord lived in three (services/history.ts + src/api/types.ts +
// the duplicate of ReceiptLineItem on each side). The copies were
// identical-but-independent and drifted in practice. This is the single
// source.

export interface Receipt {
  merchant: string;
  transactionDate: string;
  memo: string;
  totalAmount: number;
  category: string;
  lineItems?: ReceiptLineItem[];
  tax?: number;
  shipping?: number;
  fees?: number;
  discount?: number;
  credit?: number;
  creditLabel?: string;
  refund?: number;
  /** SHA-256 (hex) of the source PDF/image bytes. Computed once at parse
   *  time, used by the budget provider as a per-receipt fingerprint so
   *  two genuinely-distinct receipts with identical merchant+date+amount
   *  cannot collide on YNAB's dedupe key (and cannot mis-match each other
   *  in `findMatchingTransaction`). Optional: omitted on receipts parsed
   *  before this field existed, or in tests that don't have a source file. */
  sourceHash?: string;
}

export interface ReceiptLineItem {
  productName: string;
  quantity?: number;
  lineItemTotalAmount: number;
  category: string;
}

/** An account's stable id plus its current display name. Identity is the
 *  id — a provider-side rename changes `name`, never `id`. */
export interface AccountRef {
  id: string;
  name: string;
}

export interface ImportRecord {
  id: string;
  filename: string;
  merchant: string;
  totalAmount: number;
  itemCount: number;
  transactionDate: string;
  importedAt: string;
  success: boolean;
  error?: string;
  receipt?: Receipt;
}

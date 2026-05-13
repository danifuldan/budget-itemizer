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
}

export interface ReceiptLineItem {
  productName: string;
  quantity?: number;
  lineItemTotalAmount: number;
  category: string;
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

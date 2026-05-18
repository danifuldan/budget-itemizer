// Cross-tier shapes (Receipt, ReceiptLineItem, ImportRecord) live in
// `shared/types`. Re-export from the frontend side so existing callsites
// under src/ keep working without a sweep.
export type { Receipt, ReceiptLineItem, ImportRecord, AccountRef } from "../../shared/types";
import type { Receipt } from "../../shared/types";

// SSE event payloads from /parse-image/stream
export interface SSEHeader {
  merchant: string;
  transactionDate: string;
}

export interface SSEItem {
  productName: string;
  quantity?: number;
  amount: number;
}

export interface SSETotal {
  totalAmount: number;
  tax?: number;
  shipping?: number;
  fees?: number;
  discount?: number;
  credit?: number;
  creditLabel?: string;
  refund?: number;
}

export interface SSECategories {
  categories: Record<string, string> | string[];
}

export interface SSEStatus {
  step: string;
  [key: string]: unknown;
}

export interface SSEDone {
  receipt: Receipt;
}

export interface SSEError {
  message: string;
  step: string;
}

export type SSEEvent =
  | { event: "status"; data: SSEStatus }
  | { event: "header"; data: SSEHeader }
  | { event: "item"; data: SSEItem }
  | { event: "total"; data: SSETotal }
  | { event: "categories"; data: SSECategories }
  | { event: "done"; data: SSEDone }
  | { event: "error"; data: SSEError };

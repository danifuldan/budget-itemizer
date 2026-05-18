export const labelPrompt = `You are a receipt structure analyzer. Your job is to identify the LABELS and LAYOUT of a receipt — NOT to extract dollar amounts. Dollar amounts will be extracted separately by exact text matching.

Analyze the receipt and return:
- merchant: The store/company name. For marketplace receipts (Amazon, eBay, Walmart.com, etc.), use the PLATFORM name, not the individual seller/vendor name. Otherwise use the store name from the header, logo, or URL.
- dateLabel: The purchase/order date as printed on the receipt (e.g. "January 15, 2024", "01/15/2025", "Nov 29, 2025"). Return ONLY the date, not surrounding label text. Use the actual transaction/purchase/order date — ignore page timestamps, print dates, "viewed on" dates, delivery dates, and shipping dates. The date MUST include the year.
- totalLabel: The EXACT label text next to the final total on the receipt (e.g. "Grand Total", "Total", "Amount Due"). Do NOT include the dollar amount — just the label word(s).
- summaryLabels: An array of ALL other financial summary labels you see on the receipt (subtotal, tax, shipping, discounts, fees, credits, refunds). For each, give the exact label text as printed and what type of field it is. Give only the label text, not the amount. If shipping is free, still include it with label "Shipping" or "Shipping Free". Use "refund" for returned items or money back; use "discount" for savings, coupons, or price reductions. ANY summary line that carries a price is a charge or adjustment — classify it by what it represents, never skip it because its label contains no fee/tax word. In particular, a line whose label is a delivery speed or tier rather than a fee word (e.g. "Express delivery", "Priority", "Same-day", "2-hour") is an expedited-delivery "fee". Do NOT include payment method labels (e.g. "Payment method", "Paid with", "Visa ending in ****") — these describe how the customer paid, not charges or adjustments.
- lineItems: For each purchased item:
  - productName: A human-readable name. Expand abbreviations (e.g. "PROGRSO SOU" → "Progresso Soup").
  - quantity: The quantity if shown, otherwise 1.
  - lineText: A short EXACT snippet of text from that receipt line that uniquely identifies this item (enough to locate it in the text). Use 3-8 words from the product description as printed. Do NOT include the price.

CRITICAL: Do NOT include any dollar amounts (like $16.25 or $0.00) in totalLabel, summaryLabels labels, or lineText. Only identify labels, text snippets, and structure — amounts are extracted by code.

IMPORTANT: ONLY include items that were actually PURCHASED and FULFILLED in this order. Exclude:
- Items marked "Unavailable", "Out of stock", "Canceled", or "Refunded" — these were NOT delivered or charged.
- Product recommendations, "customers also bought", "inspired by your browsing", "frequently bought together", sponsored products, ads, and any other suggested or related items.
Items marked "Substitutions" or "Substituted" WERE delivered (as a replacement) and SHOULD be included. Items marked "Shopped" were fulfilled normally and should be included.`;

export const labelSchema = () => ({
  type: "object" as const,
  properties: {
    merchant: { type: "string" as const },
    dateLabel: { type: "string" as const },
    totalLabel: { type: "string" as const },
    summaryLabels: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          label: { type: "string" as const },
          type: { type: "string" as const, enum: ["subtotal", "tax", "shipping", "discount", "fee", "credit", "refund"] },
        },
        required: ["label", "type"],
      },
    },
    lineItems: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          productName: { type: "string" as const },
          quantity: { type: "number" as const },
          lineText: { type: "string" as const },
        },
        required: ["productName", "quantity", "lineText"],
      },
    },
  },
  required: ["merchant", "dateLabel", "totalLabel", "summaryLabels", "lineItems"],
});

export interface LabelResult {
  merchant: string;
  dateLabel: string;
  totalLabel: string;
  summaryLabels: { label: string; type: string }[];
  lineItems: { productName: string; quantity: number; lineText: string }[];
}

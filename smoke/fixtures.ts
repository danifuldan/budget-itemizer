// Synthetic-receipt PDF generators for the Tier A use-path smoke test.
// All merchants, line items, addresses, and totals are made up. No real
// receipts in this directory — see TODO.md "Smoke tests" for the design
// rationale.
//
// To regenerate the fixture PDFs after editing a generator:
//   npx tsx smoke/fixtures.ts
// They'll be (re-)written into smoke/fixtures/*.pdf.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const _here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(_here, "fixtures");

interface LineItem {
  qty?: number;
  description: string;
  amount: number; // dollars
}

interface ReceiptShape {
  merchant: string;
  storeAddress?: string;
  orderDate: string; // human-readable
  items: LineItem[];
  subtotal?: number;
  tax?: number;
  shipping?: number;
  fees?: number;
  total: number;
  paidWith?: string;
  orderNumber?: string;
}

async function renderReceiptPdf(receipt: ReceiptShape): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // US Letter
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = 750;
  const left = 56;
  const right = 556;
  const black = rgb(0, 0, 0);

  const drawLine = (text: string, opts: { font?: typeof font; size?: number; x?: number; align?: "left" | "right" } = {}) => {
    const f = opts.font ?? font;
    const size = opts.size ?? 11;
    const width = f.widthOfTextAtSize(text, size);
    const x = opts.align === "right" ? right - width : (opts.x ?? left);
    page.drawText(text, { x, y, size, font: f, color: black });
  };

  const newline = (dy = 16) => { y -= dy; };

  // Header
  drawLine(receipt.merchant, { font: bold, size: 16 });
  newline(20);
  if (receipt.storeAddress) {
    drawLine(receipt.storeAddress, { size: 9 });
    newline(14);
  }
  drawLine(`Order date: ${receipt.orderDate}`, { size: 10 });
  if (receipt.orderNumber) {
    drawLine(`Order #: ${receipt.orderNumber}`, { size: 10, align: "right" });
  }
  newline(20);

  // Items header
  drawLine("Items", { font: bold, size: 12 });
  newline(18);

  for (const item of receipt.items) {
    const qty = item.qty && item.qty > 1 ? `${item.qty}  ` : "";
    const left = `${qty}${item.description}`;
    const amt = `$${item.amount.toFixed(2)}`;
    drawLine(left, { size: 10 });
    drawLine(amt, { size: 10, align: "right" });
    newline(15);
  }

  newline(8);

  // Totals
  const totalLine = (label: string, value: number, opts: { bold?: boolean } = {}) => {
    drawLine(label, { font: opts.bold ? bold : font, size: 11, x: 320 });
    drawLine(`$${value.toFixed(2)}`, { font: opts.bold ? bold : font, size: 11, align: "right" });
    newline(15);
  };

  if (receipt.subtotal !== undefined) totalLine("Subtotal", receipt.subtotal);
  if (receipt.shipping !== undefined) totalLine("Shipping", receipt.shipping);
  if (receipt.fees !== undefined) totalLine("Fees", receipt.fees);
  if (receipt.tax !== undefined) totalLine("Tax", receipt.tax);
  newline(4);
  totalLine("Total", receipt.total, { bold: true });

  if (receipt.paidWith) {
    newline(20);
    drawLine(`Paid with: ${receipt.paidWith}`, { size: 9 });
  }

  return doc.save();
}

// ── Fixtures ────────────────────────────────────────────────────────────

export const fixtures: Array<{ filename: string; receipt: ReceiptShape }> = [
  {
    filename: "groceries-walmart-shaped.pdf",
    receipt: {
      merchant: "Walmart",
      storeAddress: "789 Imaginary Lane, Springfield, IL",
      orderDate: "November 7, 2026",
      orderNumber: "SYN-1001",
      items: [
        { qty: 2, description: "Whole milk gallon", amount: 7.98 },
        { qty: 1, description: "Sourdough loaf", amount: 4.49 },
        { qty: 3, description: "Bananas (per bunch)", amount: 5.97 },
        { qty: 1, description: "Black beans 15oz can", amount: 1.29 },
        { qty: 2, description: "Greek yogurt 32oz", amount: 11.98 },
      ],
      subtotal: 31.71,
      tax: 1.95,
      total: 33.66,
      paidWith: "Visa ending in 0000",
    },
  },
  {
    filename: "warehouse-costco-shaped.pdf",
    receipt: {
      merchant: "Costco Wholesale",
      storeAddress: "Warehouse #404 — 12 Fictional Way, Lakebrook, OR",
      orderDate: "October 22, 2026",
      orderNumber: "MEMBER 999000-0",
      items: [
        { qty: 1, description: "1138422 KS PAPER TOWELS 12RL", amount: 21.99 },
        { qty: 2, description: "9123456 KS BTL WATER 35PK", amount: 7.98 },
        { qty: 1, description: "8801234 ROTISSERIE CHICKEN", amount: 4.99 },
        { qty: 1, description: "7717733 KS PEANUTS 64OZ", amount: 12.49 },
        { qty: 3, description: "4441288 KS BANANAS 3LB", amount: 4.47 },
      ],
      subtotal: 51.92,
      tax: 1.32,
      total: 53.24,
      paidWith: "Costco Visa",
    },
  },
  {
    filename: "online-amazon-shaped.pdf",
    receipt: {
      merchant: "Amazon.com",
      storeAddress: "Order shipped to: 42 Pretend Street, Apt 3, Capital City",
      orderDate: "October 5, 2026",
      orderNumber: "112-7000000-0000000",
      items: [
        { qty: 1, description: "Cotton bed sheet set, queen, slate blue", amount: 38.45 },
        { qty: 2, description: "Stainless steel water bottle, 24oz", amount: 31.98 },
        { qty: 1, description: "USB-C cable, braided, 6ft", amount: 8.99 },
      ],
      subtotal: 79.42,
      shipping: 0.00,
      tax: 6.86,
      total: 86.28,
      paidWith: "Mastercard ending in 1111",
    },
  },
  {
    filename: "sparse-no-line-items.pdf",
    receipt: {
      merchant: "Imaginary Coffee Roasters",
      storeAddress: "13 Made-Up Boulevard, Bayshore",
      orderDate: "September 18, 2026",
      orderNumber: "RCPT-22",
      items: [],
      total: 6.75,
      paidWith: "Apple Pay",
    },
  },
];

// ── CLI entry ───────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const { filename, receipt } of fixtures) {
    const bytes = await renderReceiptPdf(receipt);
    const outPath = path.join(FIXTURES_DIR, filename);
    fs.writeFileSync(outPath, bytes);
    console.log(`Wrote ${outPath} (${bytes.length} bytes)`);
  }
}

// Entry-point check: only run main() when this file is executed directly,
// not when imported by the smoke test runner.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

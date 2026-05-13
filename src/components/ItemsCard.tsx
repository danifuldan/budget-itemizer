import ItemRow from "./ItemRow";
import SkeletonRow from "./SkeletonRow";

interface Item {
  productName: string;
  quantity?: number;
  lineItemTotalAmount: number;
  category: string;
}

interface ItemsCardProps {
  items: Item[];
  streaming: boolean;
  totalAmount: number;
  tax: number;
  shipping: number;
  fees: number;
  discount: number;
  credit: number;
  creditLabel?: string;
  refund: number;
  discountMode?: "distribute" | "credit";
  availableCategories: string[];
  onDeleteItem: (index: number) => void;
  onUpdateCategory: (index: number, category: string) => void;
  onUpdateName: (index: number, name: string) => void;
  onUpdateAmount: (index: number, amount: number) => void;
}

function fmt(n: number): string {
  return `$${Math.abs(n).toFixed(2)}`;
}

// Figure out which breakdown line(s) the discrepancy maps to.
// If removing a single line makes the math work, that line is "not in total".
function findUnaccounted(
  diff: number,
  lines: { key: string; value: number }[],
): Set<string> {
  const tolerance = 0.02;
  for (const line of lines) {
    if (Math.abs(diff - line.value) < tolerance) return new Set([line.key]);
    if (Math.abs(diff + line.value) < tolerance) return new Set([line.key]);
  }
  return new Set();
}

export default function ItemsCard({
  items,
  streaming,
  totalAmount,
  tax,
  shipping,
  fees,
  discount,
  credit,
  creditLabel,
  refund,
  discountMode = "distribute",
  availableCategories,
  onDeleteItem,
  onUpdateCategory,
  onUpdateName,
  onUpdateAmount,
}: ItemsCardProps) {
  const subtotal = items.reduce((sum, item) => sum + item.lineItemTotalAmount, 0);
  const showTotals = !streaming && items.length > 0;

  // If LLM reported tax=0 but there's a positive gap, treat the gap as implied tax
  const impliedTax = tax > 0 ? tax : Math.round((totalAmount - subtotal - shipping - fees + discount + credit) * 100) / 100;
  const displayTax = impliedTax > 0.01 ? impliedTax : tax;

  // Reconciliation: does the breakdown add up to the receipt total?
  const expected = Math.round((subtotal + displayTax + shipping + fees - discount - credit - refund) * 100) / 100;
  const diff = Math.round((totalAmount - expected) * 100) / 100;
  const hasDiscrepancy = showTotals && Math.abs(diff) > 0.02;

  // Identify which line the discrepancy belongs to
  const unaccounted = hasDiscrepancy
    ? findUnaccounted(diff, [
        { key: "refund", value: refund },
        { key: "credit", value: credit },
        { key: "discount", value: discount },
        { key: "shipping", value: shipping },
        { key: "fees", value: fees },
        { key: "tax", value: displayTax },
      ])
    : new Set<string>();

  const tag = (key: string) =>
    unaccounted.has(key) ? " totals-flagged" : "";

  const note = (key: string) =>
    unaccounted.has(key)
      ? <span className="totals-note">not in receipt total</span>
      : null;

  return (
    <div className="items-card">
      <div className="items-head">
        <span className="items-head-label">Items</span>
        <span className="items-head-amount">Amount</span>
        <span className="items-head-edit" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7.5 1.5l3 3L3.5 11.5H.5v-3z" />
            <path d="M6 3l3 3" />
          </svg>
        </span>
      </div>
      {items.map((item, i) => (
        <ItemRow
          key={i}
          name={item.productName}
          quantity={item.quantity}
          amount={item.lineItemTotalAmount}
          category={item.category}
          availableCategories={availableCategories}
          onCategoryChange={(cat) => onUpdateCategory(i, cat)}
          onNameChange={(name) => onUpdateName(i, name)}
          onAmountChange={(amount) => onUpdateAmount(i, amount)}
          onDelete={() => onDeleteItem(i)}
        />
      ))}
      {streaming && (
        <>
          <SkeletonRow />
          <SkeletonRow nameWidth="42%" />
        </>
      )}
      {showTotals && (
        <div className="items-totals">
          <div className="totals-line">
            <span>Subtotal</span>
            <span>{fmt(subtotal)}</span>
          </div>
          {displayTax > 0 && (
            <div className={`totals-line${tag("tax")}`}>
              <span>Tax {note("tax")}</span>
              <span>{fmt(displayTax)}</span>
            </div>
          )}
          {shipping > 0 && (
            <div className={`totals-line${tag("shipping")}`}>
              <span>Shipping {note("shipping")}</span>
              <span>{fmt(shipping)}</span>
            </div>
          )}
          {fees > 0 && (
            <div className={`totals-line${tag("fees")}`}>
              <span>Delivery fee {note("fees")}</span>
              <span>{fmt(fees)}</span>
            </div>
          )}
          {discount > 0 && (
            <div className={`totals-line${tag("discount")}`}>
              <span>Discount {note("discount")}{discountMode === "distribute" && <span className="totals-hint">applied to items</span>}</span>
              <span>-{fmt(discount)}</span>
            </div>
          )}
          {credit > 0 && (
            <div className={`totals-line${tag("credit")}`}>
              <span>{creditLabel || "Credit"} {note("credit")}</span>
              <span>-{fmt(credit)}</span>
            </div>
          )}
          {refund > 0 && (
            <div className={`totals-line${tag("refund")}`}>
              <span>Refund {note("refund")}</span>
              <span>-{fmt(refund)}</span>
            </div>
          )}
          <div className="totals-line totals-total">
            <span>Total</span>
            <span>{fmt(totalAmount)}</span>
          </div>
          {!hasDiscrepancy && totalAmount > 0 && (
            <div className="totals-check" role="status">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4 6.5L5.8 8.3L9 4.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Numbers add up
            </div>
          )}
        </div>
      )}
    </div>
  );
}

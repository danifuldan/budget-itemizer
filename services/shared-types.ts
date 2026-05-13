// Re-export from the cross-tier source. Kept as a backend-side shim so the
// many `import from "./shared-types"` callsites under services/ continue
// to resolve without sweeping every one. New code should prefer the
// `shared/types` path directly.
export type { Receipt, ReceiptLineItem } from "../shared/types";

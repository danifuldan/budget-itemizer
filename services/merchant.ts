// ============================================================
// Merchant name resolution — shared across all understanding providers
// ============================================================
//
// Post-extraction refinement: compares the LLM/FM merchant guess against
// the source URL domain and OCR footer/copyright text to pick the best name.

/**
 * Normalize a merchant name for fuzzy comparison: lowercase, strip suffixes
 * like ".com", "inc", "llc", "corp", trailing punctuation, and extra whitespace.
 */
function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]+$/, "")
    .replace(/\b(inc|llc|corp|ltd|co)\b\.?/g, "")
    .replace(/\.com\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if two normalized names match via substring containment.
 * Both directions: "amazon" ⊂ "amazon com" or vice versa.
 */
function fuzzyMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

/**
 * Extract a readable brand from a URL hostname.
 * e.g. "www.amazon.com" → "Amazon", "order.target.com" → "Target"
 */
export function brandFromUrl(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    // Strip "www." and common subdomains, take the main domain segment
    const parts = hostname.replace(/^www\./, "").split(".");
    if (parts.length < 2) return null;
    const brand = parts[parts.length - 2]; // e.g. "amazon" from "order.amazon.com"
    if (!brand || brand.length < 2) return null;
    // Capitalize first letter
    return brand.charAt(0).toUpperCase() + brand.slice(1);
  } catch {
    return null;
  }
}

/**
 * Extract a company name from copyright/footer patterns in the last portion
 * of OCR text. Looks for patterns like:
 *   © 2024 Amazon.com    /    © 2023-2024, Target    /    Amazon, Inc.
 */
export function footerCandidate(text: string): string | null {
  if (!text) return null;
  const tail = text.slice(-300);

  // Pattern 1a: © year Name, Inc/LLC/etc.
  // Uses bounded word groups ({0,4}) instead of space-in-class to avoid backtracking
  const withSuffix = tail.match(
    /©\s{0,3}\d{4}(?:\s{0,3}[-–]\s{0,3}\d{4})?\s{0,3},?\s{0,3}([A-Z][A-Za-z0-9.]+(?:\s[A-Za-z0-9.]+){0,4})\s{0,3}[,.]?\s{0,3}(?:Inc|LLC|Corp|Ltd|Co|All\s+rights)/,
  );
  if (withSuffix) return withSuffix[1].trim();

  // Pattern 1b: © year Name (at end of text, no suffix)
  const atEnd = tail.match(
    /©\s{0,3}\d{4}(?:\s{0,3}[-–]\s{0,3}\d{4})?\s{0,3},?\s{0,3}([A-Z][A-Za-z0-9.]+(?:\s[A-Za-z0-9.]+){0,4})\s{0,5}$/,
  );
  if (atEnd) return atEnd[1].trim();

  // Pattern 2: Name, Inc. / Name Inc.
  const incMatch = tail.match(
    /([A-Z][A-Za-z0-9.]+(?:\s[A-Z][A-Za-z0-9.]+){0,4})\s{0,3},?\s{1,3}Inc\.?/,
  );
  if (incMatch) return incMatch[1].trim();

  return null;
}

/**
 * Post-extraction merchant refinement: compare the model's guess against the
 * source URL domain and OCR footer/copyright to pick the consensus merchant name.
 *
 * Weights: footer (2) > URL (1) = model (1).
 * When two sources agree, the more readable form wins.
 */
export function refineMerchant(
  modelMerchant: string,
  sourceUrl?: string,
  text?: string,
): string {
  const urlBrand = sourceUrl ? brandFromUrl(sourceUrl) : null;
  const footer = text ? footerCandidate(text) : null;

  const nModel = normalizeMerchant(modelMerchant);
  const nUrl = urlBrand ? normalizeMerchant(urlBrand) : "";
  const nFooter = footer ? normalizeMerchant(footer) : "";

  // Check pairwise agreement
  const footerUrlAgree = nFooter && nUrl && fuzzyMatch(nFooter, nUrl);
  const footerModelAgree = nFooter && fuzzyMatch(nFooter, nModel);
  const urlModelAgree = nUrl && fuzzyMatch(nUrl, nModel);

  let result: string;
  let reason: string;

  if (footerUrlAgree) {
    // Footer + URL agree → use footer form (strongest signal, most readable)
    result = footer!;
    reason = `footer+URL agree ("${footer}" ≈ "${urlBrand}"), overriding model "${modelMerchant}"`;
  } else if (footerModelAgree) {
    // Footer + model agree → keep model
    result = modelMerchant;
    reason = `footer+model agree ("${footer}" ≈ "${modelMerchant}")`;
  } else if (urlModelAgree) {
    // URL + model agree → keep model
    result = modelMerchant;
    reason = `URL+model agree ("${urlBrand}" ≈ "${modelMerchant}")`;
  } else {
    // No agreement → keep model (it's all we've got)
    result = modelMerchant;
    reason = `no agreement (model="${modelMerchant}", URL="${urlBrand}", footer="${footer}") — keeping model`;
  }

  console.log(`[merchant] refineMerchant: ${reason} → "${result}"`);
  return result;
}

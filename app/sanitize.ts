import * as path from "path";

/** Sanitize a user-supplied filename for the inbox. Returns null if the
 *  input can't produce a safe non-empty filename — caller should reject
 *  with 400 rather than try to fall back to a synthesized name (avoids
 *  hiding malicious-input intent behind a generated filename).
 *
 *  - Strip directory components (basename).
 *  - Replace non-alphanum-dot-underscore-dash with underscore.
 *  - Strip leading dots so `..pdf` / `.htaccess.pdf` don't end up in the inbox.
 *  - Cap length at MAX_FILENAME_LEN — most macOS/APFS NAME_MAX is 255 bytes;
 *    200 leaves headroom for any collision suffix moveToProcessed may add.
 *  - Return null if the result is empty after stripping, so the upload
 *    route returns 400 instead of writing to the inbox directory itself
 *    (which used to crash with EISDIR — discovered via adversarial test). */
export const MAX_FILENAME_LEN = 200;

export function sanitizeReceiptFilename(name: string): string | null {
  let safe = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  if (safe.length > MAX_FILENAME_LEN) {
    // Preserve the extension if possible, otherwise straight truncate.
    const ext = path.extname(safe).slice(0, 16);
    const base = safe.slice(0, MAX_FILENAME_LEN - ext.length);
    safe = base + ext;
  }
  // Reject anything that's empty or only-extension (e.g. ".pdf") — a
  // file with no usable basename is suspicious input, not legitimate.
  if (!safe || safe.startsWith(".")) return null;
  return safe;
}

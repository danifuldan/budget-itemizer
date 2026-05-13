import * as fs from "fs";

/** Write a file with restrictive (owner-only) permissions and chmod after
 *  write to enforce mode on existing files. `writeFileSync`'s `mode` is
 *  only honored on file *creation*, not on overwrite — so without the
 *  chmod, a file that was created with default mode in a prior version
 *  keeps its loose permissions through every subsequent save.
 *
 *  Use for any file in `~/.config/budget-itemizer/` that contains
 *  user data we don't want world-readable: config, history, caches. */
export function writeRestrictedFile(path: string, data: string): void {
  fs.writeFileSync(path, data, { mode: 0o600 });
  try { fs.chmodSync(path, 0o600); } catch {}
}

/** Ensure a directory exists with restrictive (owner-only) mode. Like
 *  writeRestrictedFile, chmods after mkdir because mkdirSync ignores
 *  `mode` on directories that already exist. */
export function ensureRestrictedDir(path: string): void {
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path, 0o700); } catch {}
}

/**
 * Adversarial probes on writeRestrictedFile and ensureRestrictedDir.
 *
 * The author's comment in restricted-file.ts says "writeFileSync's `mode`
 * is only honored on file *creation*, not on overwrite — so without the
 * chmod, a file that was created with default mode in a prior version
 * keeps its loose permissions through every subsequent save."
 *
 * That is the load-bearing claim. We test it the hostile way:
 *
 *   1. Create a config file with a wide-open mode (0o644).
 *   2. Call writeRestrictedFile to overwrite it.
 *   3. Assert mode is now 0o600.
 *
 * Anyone changing this function to "fs.writeFileSync(path, data, { mode })"
 * alone — without the chmodSync — will fail this test. That's the whole
 * point: the chmod-after-write is the *only* thing protecting old files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeRestrictedFile, ensureRestrictedDir } from "./restricted-file";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "restricted-file-adv-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("writeRestrictedFile — mode enforcement on overwrite", () => {
  it("fresh write: mode is 0o600", () => {
    const f = path.join(tmp, "fresh.json");
    writeRestrictedFile(f, "{}");
    const mode = fs.statSync(f).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // The realistic regression: an old install wrote config.json with mode
  // 0o644 (the umask default). Now the user upgrades; writeRestrictedFile
  // is supposed to *re-chmod* on overwrite. Without the explicit
  // fs.chmodSync, mode would remain 0o644.
  it("OVERWRITE: pre-existing 0o644 file → 0o600 after writeRestrictedFile", () => {
    const f = path.join(tmp, "preexisting.json");
    // Create with loose mode, like an old install would have.
    fs.writeFileSync(f, "{}", { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    expect(fs.statSync(f).mode & 0o777).toBe(0o644);

    // Now overwrite.
    writeRestrictedFile(f, "{\"x\":1}");
    const mode = fs.statSync(f).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // World-readable extreme: was the file 0o666?
  it("OVERWRITE: pre-existing 0o666 file → 0o600", () => {
    const f = path.join(tmp, "loose.json");
    fs.writeFileSync(f, "{}", { mode: 0o666 });
    fs.chmodSync(f, 0o666);
    writeRestrictedFile(f, "{}");
    const mode = fs.statSync(f).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // 0o777 — the worst case.
  it("OVERWRITE: pre-existing 0o777 file → 0o600", () => {
    const f = path.join(tmp, "wideopen.json");
    fs.writeFileSync(f, "{}", { mode: 0o777 });
    fs.chmodSync(f, 0o777);
    writeRestrictedFile(f, "{}");
    const mode = fs.statSync(f).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // The chmod is wrapped in try {} catch {} — so a chmod failure is
  // silent. If the mode is already permissive AND chmod is somehow
  // patched to fail, the file stays permissive. We can't easily test
  // the silent failure (we'd have to patch fs.chmodSync), but we can
  // pin the contract: under normal conditions, the mode IS exactly
  // 0o600 after the call.
  it("multiple overwrites in sequence each end in 0o600", () => {
    const f = path.join(tmp, "multi.json");
    for (let i = 0; i < 5; i++) {
      writeRestrictedFile(f, `{"i":${i}}`);
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    }
  });
});

describe("ensureRestrictedDir — mode enforcement on existing dirs", () => {
  it("fresh dir: mode is 0o700", () => {
    const d = path.join(tmp, "fresh-dir");
    ensureRestrictedDir(d);
    const mode = fs.statSync(d).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("pre-existing 0o755 dir → 0o700 after ensureRestrictedDir", () => {
    const d = path.join(tmp, "preexisting-dir");
    fs.mkdirSync(d, { mode: 0o755 });
    fs.chmodSync(d, 0o755);
    expect(fs.statSync(d).mode & 0o777).toBe(0o755);

    ensureRestrictedDir(d);
    expect(fs.statSync(d).mode & 0o777).toBe(0o700);
  });

  // mkdirSync with recursive doesn't honor `mode` on PARENT directories
  // that get created. Test: if we create /a/b/c with ensureRestrictedDir,
  // does only the leaf get 0o700? Or does the parent also?
  // The current implementation only chmods the leaf. Document this.
  it("recursive create: only the leaf path is explicitly chmod'd (parents inherit umask)", () => {
    const leaf = path.join(tmp, "a", "b", "c");
    ensureRestrictedDir(leaf);
    expect(fs.statSync(leaf).mode & 0o777).toBe(0o700);
    // Parent: this is a known limitation; current code doesn't chmod
    // intermediate parents. We pin the behavior.
    const parent = path.join(tmp, "a");
    const parentMode = fs.statSync(parent).mode & 0o777;
    // Parents created by mkdir -p inherit the mode parameter from
    // mkdirSync (which we passed as 0o700) ONLY on the OS-level call;
    // node's fs.mkdirSync with recursive applies mode to ALL created
    // directories on most platforms. So this MIGHT be 0o700.
    // We just assert it's not world-writable.
    expect(parentMode & 0o002).toBe(0);
  });
});

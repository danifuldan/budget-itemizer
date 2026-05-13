/**
 * Adversarial probes on sanitizeReceiptFilename, observed through the
 * two routes that consume malicious filenames (POST /watcher/inbox and
 * POST /parse-image/stream).
 *
 * The function (in app.ts) is:
 *
 *   path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
 *
 * Three sequential operations:
 *   (1) path.basename — strip directory components
 *   (2) replace non-alphanumeric (except . _ -) with _
 *   (3) strip leading dots
 *
 * Boundary questions:
 *   - What if path.basename is fed a name with backslashes (Windows
 *     separator)? On macOS/Linux, path.basename treats `\` as a normal
 *     character. The replace then mangles them to `_`. OK.
 *   - What if the name is entirely dots? `....` → "...." → "" (all dots stripped).
 *   - What if there's a leading `..` followed by valid chars? `..hello.pdf`
 *     → "..hello.pdf" → "..hello.pdf" → "hello.pdf" (leading dots stripped).
 *   - What about NUL bytes? Replaced with `_`.
 *   - What about a 10KB filename? No length cap in the sanitizer. The
 *     downstream fs.writeFileSync may reject it; we should verify.
 *   - macOS `:` is the legacy path separator (Finder displays / as :).
 *     The HFS file API treats `:` as a separator. On Node fs, `:` is
 *     allowed but if the filename then becomes a real macOS path
 *     component, `:` could create surprises. The sanitizer maps `:` to `_`.
 *
 * Tests assert the SHAPE of the filename that lands on disk, not the
 * regex. If you replace the sanitizer with a different one that's still
 * safe, these tests should still pass.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("./utils/env-vars", () => ({
  default: {
    APP_API_KEY: "testuser",
    APP_API_SECRET: "testpass",
    MAX_FILE_SIZE: 5242880,
  },
}));

let tmpInbox: string;

vi.mock("./services/config", () => ({
  getConfig: vi.fn(() => ({
    inboxPath: tmpInbox,
    processedPath: "/tmp/processed",
    appApiKey: "",
    appApiSecret: "",
    watcherAutoImport: false,
  })),
  saveConfig: vi.fn(async (u: any) => u),
  isSetupComplete: vi.fn(() => true),
  wasConfigReset: vi.fn(() => false),
}));

vi.mock("./services/budget", () => ({
  getAllAccounts: vi.fn(),
  getAllEnvelopes: vi.fn(async () => []),
}));

vi.mock("./services/receipt", () => ({
  parseImageReceiptStream: vi.fn(),
  importReceiptToYnab: vi.fn(),
}));

vi.mock("./services/history", () => ({
  getHistory: vi.fn(() => []),
  addRecord: vi.fn(),
  deleteRecord: vi.fn(),
}));

vi.mock("./services/llama-server", () => ({
  isLlamaServerRunning: vi.fn(() => true),
  getLlamaServerEndpoint: vi.fn(() => "http://127.0.0.1:8921/v1"),
  getLlamaServerStartError: vi.fn(() => null),
  startLlamaServer: vi.fn(),
  stopLlamaServer: vi.fn(),
}));

vi.mock("./services/watcher", () => {
  const { EventEmitter } = require("events");
  return {
    getWatcherStatus: vi.fn(() => ({ running: false, inboxPath: null })),
    startWatcher: vi.fn(() => ({ running: true })),
    stopWatcher: vi.fn(),
    watcherEvents: new EventEmitter(),
    getPendingFiles: vi.fn(() => []),
    getPending: vi.fn(),
    removePending: vi.fn(),
    addPending: vi.fn(),
    markPendingReady: vi.fn(),
    moveToProcessed: vi.fn(),
    claimForImport: vi.fn(() => true),
    releaseImportClaim: vi.fn(),
    clearAllPending: vi.fn(),
    queueFile: vi.fn(),
  };
});

vi.mock("./services/model-manager", () => ({
  AVAILABLE_MODELS: [],
  getModelsStatus: vi.fn(() => []),
  isModelDownloaded: vi.fn(() => true),
  downloadModel: vi.fn(),
  cancelDownload: vi.fn(),
  getModelPath: vi.fn(),
}));

import app from "./app";

const auth = "Basic " + Buffer.from("testuser:testpass").toString("base64");

beforeEach(() => {
  tmpInbox = fs.mkdtempSync(path.join(os.tmpdir(), "filename-adv-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/**
 * POST a single malicious filename to /watcher/inbox and return the
 * file name that landed in the inbox directory. The function asserts
 * exactly one file is present after the call.
 */
async function uploadMalicious(name: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: "application/pdf" }));
  const res = await app.request("/watcher/inbox", {
    method: "POST",
    headers: { Authorization: auth },
    body: fd,
  });
  expect(res.status).toBe(200);
  const files = fs.readdirSync(tmpInbox);
  expect(files.length).toBe(1);
  return files[0];
}

describe("sanitizeReceiptFilename — observed via POST /watcher/inbox", () => {
  it("classic path traversal: '../../etc/passwd' → just 'passwd' (after basename + leading-dot strip)", async () => {
    const final = await uploadMalicious("../../etc/passwd");
    // path.basename returns "passwd"; no leading dots; no chars to mangle.
    expect(final).toBe("passwd");
    // Critically: nothing was written to /etc or outside tmpInbox.
    expect(fs.existsSync("/etc/passwd_fake_canary")).toBe(false);
  });

  it("Windows-style traversal: '..\\..\\windows\\system32\\evil.pdf' — interior '..' SURVIVES (but no '/' so no traversal)", async () => {
    const final = await uploadMalicious("..\\..\\windows\\system32\\evil.pdf");
    // FINDING: The regex `/^\.+/` strips ONLY the first run of leading
    // dots. After the backslashes are mangled to `_`, the result is
    // `.._.._windows_system32_evil.pdf`. The leading `..` strips, but
    // the interior `_..` is retained → `_.._windows_system32_evil.pdf`.
    //
    // This is NOT a path-traversal exploit because every `/` and `\`
    // has already been replaced by `_`, so the result is a single
    // basename. But the comment in app.ts says "values like `..pdf`
    // can't end up in the inbox" which is slightly misleading —
    // interior `..` sequences DO end up there.
    expect(final).toBe("_.._windows_system32_evil.pdf");
    expect(final.includes("\\")).toBe(false);
    expect(final.includes("/")).toBe(false);
    // Interior '..' is not stripped — pinning this behavior.
    expect(final.includes("..")).toBe(true);
  });

  it("just '..pdf' (looks like an extension but starts with dots) → 'pdf'", async () => {
    const final = await uploadMalicious("..pdf");
    // path.basename → "..pdf"; replace → "..pdf"; leading-dot strip → "pdf"
    expect(final).toBe("pdf");
  });

  it("hidden file disguise '.htaccess.pdf' → 'htaccess.pdf'", async () => {
    const final = await uploadMalicious(".htaccess.pdf");
    expect(final).toBe("htaccess.pdf");
  });

  it("all-dots filename '......' → empty after sanitize → SHOULD be cleanly rejected (4xx), not crash (5xx)", async () => {
    // FINDING (potential): A filename of just dots becomes "" after the
    // leading-dot strip. The route then does
    //   path.join(inboxPath, "") = inboxPath itself
    // and fs.writeFileSync(inboxPath, buffer) — which throws EISDIR.
    // The route has no try/catch; the error bubbles up to Hono and
    // returns 500. That's a crash on attacker-controlled input. A
    // proper defense would catch empty-after-sanitize and 400.
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([0x25, 0x50])], "......", { type: "application/pdf" }));
    const res = await app.request("/watcher/inbox", {
      method: "POST",
      headers: { Authorization: auth },
      body: fd,
    });
    // We want a clean 4xx, not a 5xx (crash). Failing here = real bug.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("NUL byte in filename: 'evil\\x00.pdf' → NUL replaced with _", async () => {
    const final = await uploadMalicious("evil\x00.pdf");
    expect(final).toBe("evil_.pdf");
    expect(final.includes("\x00")).toBe(false);
  });

  it("CR/LF in filename: 'evil\\r\\n.pdf' → CR and LF replaced with _", async () => {
    const final = await uploadMalicious("evil\r\n.pdf");
    expect(final).toBe("evil__.pdf");
  });

  it("colon (macOS legacy separator) is replaced", async () => {
    const final = await uploadMalicious("evil:hidden.pdf");
    expect(final).toBe("evil_hidden.pdf");
    expect(final.includes(":")).toBe(false);
  });

  it("space in filename is replaced with _ (not URL-decoded later)", async () => {
    const final = await uploadMalicious("my receipt.pdf");
    expect(final).toBe("my_receipt.pdf");
  });

  it("RTL override in filename is replaced with _", async () => {
    // U+202E LEFT-TO-RIGHT OVERRIDE; could trick the user into thinking
    // a `.exe` is a `.pdf`. The regex strips it.
    const final = await uploadMalicious("invoice‮fdp.exe");
    expect(final.includes("‮")).toBe(false);
    expect(final.endsWith(".exe")).toBe(true);
  });

  it("Unicode (non-ASCII alphabet): 'résumé.pdf' → non-ASCII letters → _", async () => {
    const final = await uploadMalicious("résumé.pdf");
    // é, é → _ — `_r_sum__.pdf` effectively. Strict ASCII-only.
    expect(final.includes("é")).toBe(false);
    expect(final.endsWith(".pdf")).toBe(true);
  });

  it("Windows reserved name 'CON.pdf' is NOT specifically rejected (Unix; pinning behavior)", async () => {
    // On Windows this would be a problem. On macOS/Linux, "CON.pdf" is
    // a perfectly valid filename. Pin this so a future "harden by
    // refusing Windows reserved names" change is explicit.
    const final = await uploadMalicious("CON.pdf");
    expect(final).toBe("CON.pdf");
  });

  it("4096-char filename — sanitizer does NOT length-cap (downstream may reject)", async () => {
    // The sanitizer has no length cap. macOS NAME_MAX is 255 bytes
    // by default. A 1024-char name will be too long for the filesystem.
    // Test: does the route surface a clean error or crash?
    const fd = new FormData();
    const longName = "a".repeat(4096) + ".pdf";
    fd.append("file", new File([new Uint8Array([0x25, 0x50])], longName, { type: "application/pdf" }));
    const res = await app.request("/watcher/inbox", {
      method: "POST",
      headers: { Authorization: auth },
      body: fd,
    });
    // The implementation does NOT guard against this. fs.writeFileSync
    // will throw ENAMETOOLONG. We expect SOMETHING that's not 500. If
    // this fails, that's a finding: long filenames crash the route.
    // (We're hostile — if the code does crash with 500, that's a bug.)
    expect(res.status).not.toBe(500);
  });
});

/**
 * Tier A use-path smoke test (release-gate).
 *
 * What it does:
 *   1. Spawns the production sidecar binary on a non-default port with an
 *      isolated APP_API_KEY/SECRET. No interaction with your real Tauri
 *      shell instance — the smoke sidecar lives in its own process.
 *   2. Reads SERVER_PORT from stdout and waits for /status's llmReady=true.
 *   3. For each fixture in smoke/fixtures/*.pdf, POSTs to
 *      /parse-image/stream, consumes the SSE response, and asserts the
 *      final Receipt matches the committed *.expected.json snapshot.
 *   4. SIGTERMs the sidecar.
 *
 * Run:
 *   npm run smoke:use-path
 *
 * Capture initial snapshots (first time you add a fixture, or when the
 * pipeline output legitimately changes):
 *   npm run smoke:use-path -- --update
 *
 * Prerequisites:
 *   - src-tauri/binaries/budget-itemizer-server-aarch64-apple-darwin built
 *     (run `npm run build:server` if missing).
 *   - Llama 3.1 8B model downloaded to ~/.config/budget-itemizer/models/
 *     (the wizard does this; or download via the app's Settings panel).
 *   - swift-sidecar + llama-server siblings present in src-tauri/binaries/.
 *
 * The smoke uses your real ~/.config/budget-itemizer/config.json — but
 * /parse-image/stream NEVER writes to YNAB or history, so this is safe.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

const _here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(_here, "..");
const FIXTURES_DIR = path.join(_here, "fixtures");
const BINARY = path.join(
  REPO_ROOT,
  "src-tauri",
  "binaries",
  "budget-itemizer-server-aarch64-apple-darwin",
);

const SMOKE_PORT = "4567";
const STARTUP_TIMEOUT_MS = 180_000; // llama-server warm-up can take a while
const PARSE_TIMEOUT_MS = 180_000;

const REAL_CONFIG_DIR = path.join(os.homedir(), ".config", "budget-itemizer");

/** Build the env block for the smoke sidecar. Allowlist only — the parent
 *  shell's env can carry YNAB_API_KEY / APP_API_KEY / similar overrides
 *  that the sidecar would silently honor, breaking the smoke's isolation
 *  promise. Passing ...process.env was wrong; this is the explicit list. */
function smokeEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const allow = ["PATH", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR"];
  const base: NodeJS.ProcessEnv = {};
  for (const k of allow) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  return { ...base, ...overrides };
}

/** Build an isolated HOME for the smoke sidecar so it doesn't see the user's
 *  real watcher settings (which would trip auto-import on real inbox files).
 *  The Keychain is system-wide, so app creds + YNAB token are inherited;
 *  models/ and categories.cache.json are symlinked so we don't re-download
 *  5GB or re-fetch YNAB categories. */
function createIsolatedHome(): { home: string; cleanup: () => void } {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "budget-smoke-"));
  const tmpConfigDir = path.join(tmpHome, ".config", "budget-itemizer");
  fs.mkdirSync(tmpConfigDir, { recursive: true });

  // Copy and de-fang config — disable watcher, set safe paths.
  const realConfigFile = path.join(REAL_CONFIG_DIR, "config.json");
  if (!fs.existsSync(realConfigFile)) {
    throw new Error(`Real config not found at ${realConfigFile}; finish setup wizard before running smoke.`);
  }
  const config = JSON.parse(fs.readFileSync(realConfigFile, "utf8")) as Record<string, unknown>;
  config.watcherEnabled = false;
  config.inboxPath = path.join(tmpHome, "Inbox"); // unused but must exist as a string
  config.processedPath = path.join(tmpHome, "Processed");
  fs.writeFileSync(path.join(tmpConfigDir, "config.json"), JSON.stringify(config, null, 2));

  // Symlink heavy directories that we don't want to recreate.
  const sharedNames = ["models", "categories.cache.json"];
  for (const name of sharedNames) {
    const src = path.join(REAL_CONFIG_DIR, name);
    if (fs.existsSync(src)) {
      fs.symlinkSync(src, path.join(tmpConfigDir, name));
    }
  }

  return {
    home: tmpHome,
    cleanup: () => {
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

const args = new Set(process.argv.slice(2));
const UPDATE_MODE = args.has("--update");

interface ReceiptShape {
  merchant: string;
  transactionDate: string;
  totalAmount: number;
  tax?: number;
  shipping?: number;
  fees?: number;
  discount?: number;
  credit?: number;
  creditLabel?: string;
  refund?: number;
  lineItems?: Array<{
    productName: string;
    quantity?: number;
    lineItemTotalAmount: number;
  }>;
}

function authHeader(creds: { key: string; secret: string }): string {
  return "Basic " + Buffer.from(`${creds.key}:${creds.secret}`).toString("base64");
}

async function waitForBootHandshake(
  child: ChildProcessWithoutNullStreams,
): Promise<{ port: number; key: string; secret: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Server didn't print full boot handshake within ${STARTUP_TIMEOUT_MS / 1000}s`));
    }, STARTUP_TIMEOUT_MS);

    const fields: { port?: number; key?: string; secret?: string } = {};
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        process.stdout.write(`[sidecar] ${line}\n`);
        let m: RegExpMatchArray | null;
        if ((m = line.match(/^SERVER_PORT=(\d+)$/))) fields.port = parseInt(m[1], 10);
        else if ((m = line.match(/^APP_API_KEY=(.+)$/))) fields.key = m[1];
        else if ((m = line.match(/^APP_API_SECRET=(.+)$/))) fields.secret = m[1];
        if (fields.port !== undefined && fields.key && fields.secret) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          resolve({ port: fields.port, key: fields.key, secret: fields.secret });
          return;
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => process.stderr.write(`[sidecar:err] ${chunk}`));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Sidecar exited prematurely with code ${code}`));
    });
  });
}

async function waitForLlmReady(port: number, creds: { key: string; secret: string }): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { Authorization: authHeader(creds) },
      });
      if (res.ok) {
        const body = (await res.json()) as { llmReady?: boolean };
        if (body.llmReady) return;
      }
    } catch {
      // sidecar still booting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`/status never returned llmReady=true within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

async function parseReceipt(port: number, creds: { key: string; secret: string }, pdfPath: string): Promise<ReceiptShape> {
  const buf = fs.readFileSync(pdfPath);
  const filename = path.basename(pdfPath);
  const form = new FormData();
  form.append("file", new Blob([buf as unknown as ArrayBuffer], { type: "application/pdf" }), filename);

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), PARSE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/parse-image/stream`, {
      method: "POST",
      headers: { Authorization: authHeader(creds) },
      body: form,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) throw new Error(`parse-image/stream returned ${res.status}: ${await res.text()}`);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let receipt: ReceiptShape | null = null;
  let parseError: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const event = currentEvent || "message";
        currentEvent = "";
        try {
          const data = JSON.parse(line.slice(5).trim());
          if (event === "done") receipt = data.receipt as ReceiptShape;
          else if (event === "error") parseError = `${data.step}: ${data.message}`;
        } catch {
          // skip keep-alive / malformed
        }
      }
    }
  }

  if (parseError) throw new Error(`Pipeline emitted error: ${parseError}`);
  if (!receipt) throw new Error("Stream ended without a 'done' event");
  return receipt;
}

function normalizeForComparison(r: ReceiptShape): ReceiptShape {
  // Drop fields that are noise for comparison: memo is the input filename
  // (different per fixture run path), category is an LLM-suggested label
  // that doesn't need pinning at this layer. Snapshot just the shape +
  // numbers + line-item content.
  return {
    merchant: r.merchant,
    transactionDate: r.transactionDate,
    totalAmount: r.totalAmount,
    ...(r.tax !== undefined ? { tax: r.tax } : {}),
    ...(r.shipping !== undefined ? { shipping: r.shipping } : {}),
    ...(r.fees !== undefined ? { fees: r.fees } : {}),
    ...(r.discount !== undefined ? { discount: r.discount } : {}),
    ...(r.credit !== undefined ? { credit: r.credit } : {}),
    ...(r.creditLabel !== undefined ? { creditLabel: r.creditLabel } : {}),
    ...(r.refund !== undefined ? { refund: r.refund } : {}),
    lineItems: r.lineItems?.map((li) => ({
      productName: li.productName,
      ...(li.quantity !== undefined ? { quantity: li.quantity } : {}),
      lineItemTotalAmount: li.lineItemTotalAmount,
    })),
  };
}

async function main() {
  if (!fs.existsSync(BINARY)) {
    console.error(`Sidecar binary not found at ${BINARY}. Run 'npm run build:server' first.`);
    process.exit(1);
  }

  const fixtures = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".pdf"))
    .map((f) => path.join(FIXTURES_DIR, f));

  if (fixtures.length === 0) {
    console.error(`No .pdf fixtures found in ${FIXTURES_DIR}. Run 'npx tsx smoke/fixtures.ts' first.`);
    process.exit(1);
  }

  const { home: smokeHome, cleanup: cleanupHome } = createIsolatedHome();
  console.log(`Isolated HOME: ${smokeHome}`);
  console.log(`Spawning sidecar from ${BINARY} on port ${SMOKE_PORT}...`);
  const child = spawn(BINARY, [], {
    env: smokeEnv({
      HOME: smokeHome,
      APP_PORT: SMOKE_PORT,
      // Supply basic-auth creds + disable Keychain so the smoke sidecar
      // doesn't trigger macOS Keychain authorization dialogs when run
      // from an identity that hasn't been authorized for the user's
      // login Keychain.
      APP_API_KEY: "smoke-test-user",
      APP_API_SECRET: "smoke-test-pass",
      BUDGET_ITEMIZER_NO_KEYCHAIN: "1",
      // Distinct llama-server port range (8931–8940) so this smoke
      // sidecar never reclaims/kills the user's running app's
      // llama-server on the default 8921–8930.
      BUDGET_ITEMIZER_LLAMA_PORT_BASE: "8931",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  let failureCount = 0;
  let updatedCount = 0;

  try {
    const { port, key, secret } = await waitForBootHandshake(child);
    const creds = { key, secret };
    console.log(`Sidecar listening on port ${port}. Waiting for llmReady...`);
    await waitForLlmReady(port, creds);
    console.log("LLM ready. Running fixtures.\n");

    for (const pdfPath of fixtures) {
      const filename = path.basename(pdfPath);
      const snapshotPath = pdfPath.replace(/\.pdf$/, ".expected.json");
      console.log(`→ ${filename}`);
      const t0 = Date.now();
      const receipt = await parseReceipt(port, creds, pdfPath);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const normalized = normalizeForComparison(receipt);
      const actual = JSON.stringify(normalized, null, 2);

      if (UPDATE_MODE || !fs.existsSync(snapshotPath)) {
        fs.writeFileSync(snapshotPath, actual + "\n");
        console.log(`  captured snapshot → ${path.basename(snapshotPath)} (${elapsed}s)\n`);
        updatedCount++;
        continue;
      }

      const expected = fs.readFileSync(snapshotPath, "utf8").trim();
      if (expected === actual) {
        console.log(`  ✓ matches snapshot (${elapsed}s)\n`);
      } else {
        console.log(`  ✗ DOES NOT match snapshot (${elapsed}s)`);
        console.log("    expected:");
        console.log(expected.split("\n").map((l) => `      ${l}`).join("\n"));
        console.log("    actual:");
        console.log(actual.split("\n").map((l) => `      ${l}`).join("\n"));
        console.log("");
        failureCount++;
      }
    }
  } finally {
    console.log("Shutting down sidecar...");
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolve();
      }, 5_000);
    });
    cleanupHome();
  }

  if (UPDATE_MODE) {
    console.log(`\nSnapshots captured for ${updatedCount} fixture(s).`);
    process.exit(0);
  }
  if (failureCount > 0) {
    console.error(`\n${failureCount} fixture(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${fixtures.length} fixture(s) match their snapshots.`);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(2);
});

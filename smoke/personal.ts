/**
 * Tier B personal smoke (release-gate; user-only).
 *
 * What it does:
 *   1. Reads your fixture PDFs from BUDGET_ITEMIZER_SMOKE_FIXTURES.
 *   2. Reads your YNAB token + Test Budget ID from the local config + Keychain
 *      so the smoke writes to the same YNAB budget your app is already
 *      pointed at. (Yes, this is destructive — see "Why this is safe" below.)
 *   3. Snapshots existing transaction IDs in that budget for today's date.
 *   4. Spawns the production sidecar against an isolated HOME copy of your
 *      config with watcher disabled.
 *   5. For each fixture: parse via /parse-image/stream, then /import.
 *   6. Snapshots transaction IDs again, computes the diff, DELETES the
 *      newly-created transactions via YNAB API.
 *   7. SIGTERMs the sidecar; tears down temp HOME.
 *
 * Why this is safe:
 *   This runner does NOT verify your budget is a Test Budget by name.
 *   It uses whatever budget your local config points at. If you point
 *   your app at a real budget, this smoke WILL write+delete in that
 *   budget. By design — the smoke is "use the same config the user has."
 *   Run only when your app is configured against a budget you're
 *   comfortable having transactions appear/disappear in.
 *
 *   Cleanup: the runner deletes only transaction IDs that DIDN'T exist
 *   before the run. If your YNAB write fails between import and delete
 *   (the runner crashes hard, or YNAB rejects the delete), you'll need
 *   to clean up manually. Run again — it's idempotent.
 *
 * Run:
 *   BUDGET_ITEMIZER_SMOKE_FIXTURES=/path/to/your/private/fixtures \
 *     npm run smoke:personal
 *
 * No fixture snapshots — Tier A has those for the synthetic-PDF case.
 * Tier B's job is exercising the real /import → YNAB → delete loop, not
 * pinning parse output.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const _here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(_here, "..");
const BINARY = path.join(
  REPO_ROOT,
  "src-tauri",
  "binaries",
  "budget-itemizer-server-aarch64-apple-darwin",
);
const REAL_CONFIG_DIR = path.join(os.homedir(), ".config", "budget-itemizer");

/** Allowlist-only env for the smoke sidecar. See smoke/use-path.ts. */
function smokeEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const allow = ["PATH", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR"];
  const base: NodeJS.ProcessEnv = {};
  for (const k of allow) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  return { ...base, ...overrides };
}

const SMOKE_PORT = "4569";
const SMOKE_API_KEY = "personal-smoke-user";
const SMOKE_API_SECRET = "personal-smoke-pass";
const STARTUP_TIMEOUT_MS = 180_000;
const PARSE_TIMEOUT_MS = 180_000;
const IMPORT_TIMEOUT_MS = 60_000;

interface ReceiptShape {
  merchant: string;
  transactionDate: string;
  memo?: string;
  totalAmount: number;
  category?: string;
  lineItems?: Array<{
    productName: string;
    quantity?: number;
    lineItemTotalAmount: number;
    category?: string;
  }>;
  tax?: number;
  shipping?: number;
  fees?: number;
  discount?: number;
  refund?: number;
}

function authHeader(): string {
  return "Basic " + Buffer.from(`${SMOKE_API_KEY}:${SMOKE_API_SECRET}`).toString("base64");
}

async function getKeychainSecret(key: string): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/security", [
    "find-generic-password",
    "-s", `com.budget-itemizer.${key}`,
    "-w",
  ]);
  return stdout.replace(/\n$/, "");
}

async function ynabFetch<T>(token: string, route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.ynab.com/v1${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YNAB ${init?.method ?? "GET"} ${route} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

interface YnabTransaction {
  id: string;
  memo: string | null;
  import_id?: string | null;
  deleted?: boolean;
}

async function listTransactionsSince(token: string, budgetId: string, sinceDate: string): Promise<YnabTransaction[]> {
  const body = await ynabFetch<{ data: { transactions: YnabTransaction[] } }>(
    token,
    `/budgets/${budgetId}/transactions?since_date=${sinceDate}`,
  );
  return body.data.transactions;
}

// Full history (no date window). The memo-marker teardown was unreliable:
// YNAB (correctly) blanks the PARENT memo on split transactions, so a
// multi-item create never carries the marker. The robust signal is a
// snapshot diff — anything present after the run but not before was
// created BY the run, regardless of memo or receipt date.
async function listAllTransactions(token: string, budgetId: string): Promise<YnabTransaction[]> {
  return listTransactionsSince(token, budgetId, "2000-01-01");
}

function isoNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function deleteTransaction(token: string, budgetId: string, txId: string): Promise<void> {
  await ynabFetch(token, `/budgets/${budgetId}/transactions/${txId}`, { method: "DELETE" });
}

function createIsolatedHome(): { home: string; cleanup: () => void } {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "budget-personal-"));
  const tmpConfigDir = path.join(tmpHome, ".config", "budget-itemizer");
  fs.mkdirSync(tmpConfigDir, { recursive: true });

  const config = JSON.parse(
    fs.readFileSync(path.join(REAL_CONFIG_DIR, "config.json"), "utf8"),
  ) as Record<string, unknown>;
  config.watcherEnabled = false;
  config.inboxPath = path.join(tmpHome, "Inbox");
  config.processedPath = path.join(tmpHome, "Processed");
  fs.writeFileSync(path.join(tmpConfigDir, "config.json"), JSON.stringify(config, null, 2));

  for (const name of ["models", "categories.cache.json"]) {
    const src = path.join(REAL_CONFIG_DIR, name);
    if (fs.existsSync(src)) fs.symlinkSync(src, path.join(tmpConfigDir, name));
  }

  return {
    home: tmpHome,
    cleanup: () => {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    },
  };
}

async function waitForBootHandshake(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Server didn't print SERVER_PORT within ${STARTUP_TIMEOUT_MS / 1000}s`));
    }, STARTUP_TIMEOUT_MS);

    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        process.stdout.write(`[sidecar] ${line}\n`);
        const m = line.match(/^SERVER_PORT=(\d+)$/);
        if (m) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          resolve(parseInt(m[1], 10));
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

async function waitForLlmReady(port: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { Authorization: authHeader() },
      });
      if (res.ok) {
        const body = (await res.json()) as { llmReady?: boolean };
        if (body.llmReady) return;
      }
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`/status never returned llmReady=true within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

async function parseReceipt(port: number, pdfPath: string): Promise<ReceiptShape> {
  const buf = fs.readFileSync(pdfPath);
  const filename = path.basename(pdfPath);
  const form = new FormData();
  form.append("file", new Blob([buf as unknown as ArrayBuffer], { type: "application/pdf" }), filename);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PARSE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/parse-image/stream`, {
      method: "POST",
      headers: { Authorization: authHeader() },
      body: form,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }

  if (!res.ok) throw new Error(`parse-image/stream → ${res.status}: ${await res.text()}`);

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
      if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const event = currentEvent || "message";
        currentEvent = "";
        try {
          const data = JSON.parse(line.slice(5).trim());
          if (event === "done") receipt = data.receipt as ReceiptShape;
          else if (event === "error") parseError = `${data.step}: ${data.message}`;
        } catch { /* keep-alive */ }
      }
    }
  }

  if (parseError) throw new Error(parseError);
  if (!receipt) throw new Error("Stream ended without 'done'");
  return receipt;
}

interface AccountRefShape { id: string; name: string }

// Resolve the account *id* the same way the app now does: account
// identity is the stable id, not the mutable display name. This also
// makes Tier B the gold test for the renamed-account path — when
// config.defaultAccount no longer matches any live account name (a YNAB
// rename), we fall back to the sole account, exactly as the reducer's
// provisional pick does for a single-account budget.
async function resolveAccountId(
  port: number,
  cfg: { ynabAccountId?: string; defaultAccount?: string },
): Promise<AccountRefShape> {
  const res = await fetch(`http://127.0.0.1:${port}/accounts`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) throw new Error(`/accounts → ${res.status}: ${await res.text()}`);
  const accounts = (await res.json()) as AccountRefShape[];
  if (accounts.length === 0) throw new Error("/accounts returned no accounts");

  const byId = cfg.ynabAccountId && accounts.find((a) => a.id === cfg.ynabAccountId);
  if (byId) return byId;
  const byName = cfg.defaultAccount && accounts.find((a) => a.name === cfg.defaultAccount);
  if (byName) return byName;
  if (accounts.length === 1) return accounts[0]; // rename: name no longer resolves
  throw new Error(
    `Cannot resolve a target account: config has no ynabAccountId, defaultAccount ` +
    `${JSON.stringify(cfg.defaultAccount)} matches no live account, and the budget ` +
    `has ${accounts.length} accounts. Re-select the account in Settings.`,
  );
}

// The server saves the upload under sanitizeReceiptFilename(file.name)
// and keys the pending/claim entry by THAT name — not the raw basename.
// The real FE learns the registered name from the pending list; mirror
// that here (snapshot before/after parse) so /import's claim matches.
// Reimplementing the sanitizer here would just drift from it.
async function pendingFilenames(port: number): Promise<Set<string>> {
  const res = await fetch(`http://127.0.0.1:${port}/watcher/pending`, {
    headers: { Authorization: authHeader() },
  });
  if (!res.ok) return new Set();
  const list = (await res.json()) as Array<{ filename: string }>;
  return new Set(list.map((p) => p.filename));
}

async function importReceipt(port: number, account: string, receipt: ReceiptShape, sourceFilename: string, marker: string): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), IMPORT_TIMEOUT_MS);
  // Prepend the smoke-run marker to memo. Teardown queries YNAB and deletes
  // every transaction whose memo starts with this marker — works for both
  // create and update paths (findMatchingTransaction reassigns memo on the
  // matched transaction). Receipts dated in the past are still found because
  // we use a wide since_date window, not today's date.
  const memo = `${marker} ${receipt.memo ?? sourceFilename}`;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/import`, {
      method: "POST",
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({
        account,
        receipt: {
          merchant: receipt.merchant,
          transactionDate: receipt.transactionDate,
          memo,
          totalAmount: receipt.totalAmount,
          category: receipt.category ?? "Uncategorized",
          lineItems: (receipt.lineItems ?? []).map((li) => ({
            productName: li.productName,
            quantity: li.quantity,
            lineItemTotalAmount: li.lineItemTotalAmount,
            category: li.category ?? receipt.category ?? "Uncategorized",
          })),
          tax: receipt.tax,
          shipping: receipt.shipping,
          fees: receipt.fees,
          discount: receipt.discount,
          refund: receipt.refund,
        },
        sourceFilename,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`/import → ${res.status}: ${await res.text()}`);
    }
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const fixturesDir = process.env.BUDGET_ITEMIZER_SMOKE_FIXTURES;
  if (!fixturesDir) {
    console.error("Set BUDGET_ITEMIZER_SMOKE_FIXTURES to a directory of PDF receipts.");
    process.exit(1);
  }
  if (!fs.existsSync(fixturesDir) || !fs.statSync(fixturesDir).isDirectory()) {
    console.error(`Not a directory: ${fixturesDir}`);
    process.exit(1);
  }
  if (!fs.existsSync(BINARY)) {
    console.error(`Sidecar not found at ${BINARY}. Run 'npm run build:server'.`);
    process.exit(1);
  }

  const fixtures = fs.readdirSync(fixturesDir)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .map((f) => path.join(fixturesDir, f));
  if (fixtures.length === 0) {
    console.error(`No .pdf files in ${fixturesDir}.`);
    process.exit(1);
  }

  // Pull YNAB credentials from your real config + Keychain.
  const realConfig = JSON.parse(
    fs.readFileSync(path.join(REAL_CONFIG_DIR, "config.json"), "utf8"),
  );
  const budgetId: string = realConfig.ynabBudgetId;
  if (!budgetId) {
    console.error("config.ynabBudgetId is empty. Finish setup wizard first.");
    process.exit(1);
  }
  // The account id is resolved from the live /accounts list AFTER boot
  // (it reflects YNAB renames); config alone can be stale.
  const ynabToken = await getKeychainSecret("ynab-api-key");

  // Tag every smoke-imported transaction with a unique marker. Teardown
  // queries YNAB and deletes by memo prefix — robust to receipt-dated
  // transactions, concurrent user activity, and find-matching updates
  // that modify an existing tx instead of creating one. The runId is
  // long enough that a collision with a real memo would be deliberate.
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Marker still goes in the memo (useful for manual spotting), but
  // teardown no longer relies on it — snapshot diff is authoritative.
  const marker = `[SMOKE ${runId}]`;

  console.log(`Budget: ${budgetId}`);
  console.log(`Fixtures: ${fixtures.length} from ${fixturesDir}`);
  console.log(`Smoke marker: ${marker}\n`);

  // Bed prep: clear prior-run smoke artifacts so this run genuinely
  // CREATES (otherwise findMatchingTransaction matches a leftover and
  // updates in place — nothing to verify-then-delete). Every app-created
  // transaction carries a deterministic "BI:" import_id; the user's
  // manual Test Budget scaffolding has import_id=null and is never
  // touched. This is the dedicated smoke budget.
  const preRun = await listAllTransactions(ynabToken, budgetId);
  const priorArtifacts = preRun.filter(
    (t) => !t.deleted && typeof t.import_id === "string" && t.import_id.startsWith("BI:"),
  );
  if (priorArtifacts.length > 0) {
    console.log(`Clearing ${priorArtifacts.length} prior smoke artifact(s) (BI: import_id) for a clean bed...`);
    for (const t of priorArtifacts) {
      try {
        await deleteTransaction(ynabToken, budgetId, t.id);
      } catch (err) {
        console.log(`  ✗ could not clear ${t.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Snapshot AFTER the bed clear: any non-deleted id present after the
  // run but absent here was created BY the run — the reliable teardown
  // signal (memo markers don't survive YNAB's split-parent-memo rule).
  const afterClear = await listAllTransactions(ynabToken, budgetId);
  const beforeIds = new Set(
    afterClear.filter((t) => !t.deleted).map((t) => t.id),
  );
  console.log(`Pre-run snapshot: ${beforeIds.size} existing transaction(s) (left untouched).\n`);

  const { home: smokeHome, cleanup: cleanupHome } = createIsolatedHome();

  const child = spawn(BINARY, [], {
    env: smokeEnv({
      HOME: smokeHome,
      APP_PORT: SMOKE_PORT,
      APP_API_KEY: SMOKE_API_KEY,
      APP_API_SECRET: SMOKE_API_SECRET,
      BUDGET_ITEMIZER_NO_KEYCHAIN: "1",
      // Distinct llama-server port range (8931–8940) so this smoke
      // sidecar never reclaims/kills the user's running app's
      // llama-server on the default 8921–8930.
      BUDGET_ITEMIZER_LLAMA_PORT_BASE: "8931",
      // The sidecar's category fetch needs the YNAB token; supply via env
      // since we're running with NO_KEYCHAIN.
      YNAB_API_KEY: ynabToken,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  let failureCount = 0;
  let importedCount = 0;

  try {
    const port = await waitForBootHandshake(child);
    console.log(`Sidecar listening on ${port}. Waiting for llmReady...`);
    await waitForLlmReady(port);
    console.log("LLM ready.");

    const target = await resolveAccountId(port, {
      ynabAccountId: realConfig.ynabAccountId,
      defaultAccount: realConfig.defaultAccount,
    });
    const account = target.id;
    console.log(
      `Account: ${target.name} (id ${account})` +
      (realConfig.defaultAccount && realConfig.defaultAccount !== target.name
        ? ` — config.defaultAccount=${JSON.stringify(realConfig.defaultAccount)} no longer matches (rename); resolved via /accounts`
        : ""),
    );
    console.log();

    for (const pdfPath of fixtures) {
      const filename = path.basename(pdfPath);
      console.log(`→ ${filename}`);
      const t0 = Date.now();
      try {
        const before = await pendingFilenames(port);
        const receipt = await parseReceipt(port, pdfPath);
        const after = await pendingFilenames(port);
        const registered = [...after].find((n) => !before.has(n)) ?? filename;
        await importReceipt(port, account, receipt, registered, marker);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  ✓ parsed + imported (${elapsed}s) — total $${receipt.totalAmount.toFixed(2)}, ${receipt.lineItems?.length ?? 0} items\n`);
        importedCount++;
      } catch (err) {
        console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
        failureCount++;
      }
    }
  } finally {
    console.log("Shutting down sidecar...");
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); resolve(); }, 5_000);
    });
    cleanupHome();

    // Teardown by snapshot diff: anything non-deleted that exists now but
    // wasn't in the pre-run snapshot was created by this run. Reliable
    // regardless of receipt date or YNAB's split-parent-memo blanking.
    // Runs in finally{} so a half-failed run still cleans up. Never
    // touches a pre-existing id (the user's manual scaffolding is safe).
    console.log("\nTeardown: diffing against pre-run snapshot...");
    try {
      const post = await listAllTransactions(ynabToken, budgetId);
      const created = post.filter((t) => !t.deleted && !beforeIds.has(t.id));
      console.log(`Found ${created.length} transaction(s) created by this run. Deleting...`);
      let deleteFailures = 0;
      for (const t of created) {
        try {
          await deleteTransaction(ynabToken, budgetId, t.id);
        } catch (err) {
          console.log(`  ✗ delete ${t.id}: ${err instanceof Error ? err.message : String(err)}`);
          deleteFailures++;
        }
      }
      if (deleteFailures > 0) {
        console.error(`\n${deleteFailures} transaction(s) could not be deleted automatically — search budget ${budgetId} for import_id starting with "BI:".`);
      } else if (created.length > 0) {
        console.log(`All ${created.length} run-created transactions deleted.`);
      } else {
        console.log("Nothing to delete (no transactions were created).");
      }
    } catch (err) {
      console.error(`Teardown failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`Search budget ${budgetId} manually for import_id starting with "BI:".`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Imported: ${importedCount}/${fixtures.length}`);
  console.log(`Failed:   ${failureCount}/${fixtures.length}`);
  if (failureCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Smoke crashed:", err);
  process.exit(2);
});

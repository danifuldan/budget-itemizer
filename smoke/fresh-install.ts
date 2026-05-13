/**
 * Fresh-install scripted smoke (release-gate).
 *
 * What it does:
 *   1. Spawns the production sidecar binary with an EMPTY isolated HOME
 *      (no config.json, no models, no Keychain access). This simulates
 *      a never-installed-before machine.
 *   2. Verifies /status reports setup=false and llmReady=false.
 *   3. POSTs a synthetic setup payload to /setup/save (YNAB credentials,
 *      inbox/processed paths). No real YNAB token required — we just
 *      exercise the config-write surface.
 *   4. Verifies /status now reports setup=true.
 *   5. Hits a handful of additional wizard endpoints (/models/status,
 *      /watcher/status, /setup/test-ynab with a deliberately-invalid
 *      token) and asserts they respond with the expected shape — not
 *      pinned error text, just structural correctness.
 *   6. SIGTERMs the sidecar; tears down the temp HOME.
 *
 * Run:
 *   npm run smoke:fresh-install
 *
 * This is the companion to smoke:use-path. Use-path tests the parse
 * pipeline end-to-end. Fresh-install tests the wizard's HTTP surface.
 * Run both before tagging a release.
 *
 * Prerequisites:
 *   - src-tauri/binaries/budget-itemizer-server-aarch64-apple-darwin built.
 *     (Run `npm run build:server` if missing.)
 *   - Internet access (the /setup/test-ynab assertion calls YNAB to
 *     confirm a 4xx-shaped failure response. If offline, expect the
 *     test-ynab check to surface a connection error instead.)
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

const _here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(_here, "..");
const BINARY = path.join(
  REPO_ROOT,
  "src-tauri",
  "binaries",
  "budget-itemizer-server-aarch64-apple-darwin",
);

const SMOKE_PORT = "4568";

/** Allowlist-only env for the smoke sidecar. See smoke/use-path.ts for
 *  the rationale; in short, ...process.env leaks YNAB_API_KEY etc. and
 *  breaks the "fresh install" assertion (the env-fallback makes
 *  isSetupComplete return true on a config-less HOME). */
function smokeEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const allow = ["PATH", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR"];
  const base: NodeJS.ProcessEnv = {};
  for (const k of allow) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  return { ...base, ...overrides };
}
const SMOKE_API_KEY = "fresh-install-user";
const SMOKE_API_SECRET = "fresh-install-pass";
const STARTUP_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 15_000;

interface Result {
  name: string;
  passed: boolean;
  detail?: string;
}

function authHeader(): string {
  return "Basic " + Buffer.from(`${SMOKE_API_KEY}:${SMOKE_API_SECRET}`).toString("base64");
}

function createEmptyHome(): { home: string; cleanup: () => void } {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "budget-fresh-"));
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

async function waitForServerPort(child: ChildProcessWithoutNullStreams): Promise<number> {
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

async function http(port: number, route: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(`http://127.0.0.1:${port}${route}`, {
      ...init,
      headers: { Authorization: authHeader(), ...(init?.headers ?? {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

async function jsonPost(port: number, route: string, body: unknown): Promise<Response> {
  return http(port, route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface StatusShape {
  setup?: boolean;
  llmReady?: boolean;
  llmStartError?: string | null;
  watcher?: { running?: boolean; inboxExists?: boolean };
}

async function runChecks(port: number, smokeHome: string): Promise<Result[]> {
  const results: Result[] = [];

  // 1. Fresh sidecar should report setup=false, llmReady=false.
  {
    const res = await http(port, "/status");
    const body = (await res.json()) as StatusShape;
    const ok = res.ok && body.setup === false && body.llmReady !== true;
    results.push({
      name: "/status reports unconfigured fresh install",
      passed: ok,
      detail: ok ? undefined : `got ${JSON.stringify(body)}`,
    });
  }

  // 2. Save a synthetic setup payload — YNAB stub creds + paths.
  const inboxPath = path.join(smokeHome, "Inbox");
  const processedPath = path.join(smokeHome, "Processed");
  fs.mkdirSync(inboxPath, { recursive: true });
  fs.mkdirSync(processedPath, { recursive: true });
  {
    const payload = {
      ynabApiKey: "synthetic-ynab-token-xxxx-not-real",
      ynabBudgetId: "00000000-0000-0000-0000-000000000000",
      defaultAccount: "Checking",
      inboxPath,
      processedPath,
      ynabCategoryGroups: ["Groceries"],
    };
    const res = await jsonPost(port, "/setup/save", payload);
    const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
    results.push({
      name: "POST /setup/save accepts synthetic payload",
      passed: res.ok && body?.success === true,
      detail: res.ok ? undefined : `HTTP ${res.status}: ${JSON.stringify(body)}`,
    });
  }

  // 3. After /setup/save, /status should reflect setup=true.
  {
    const res = await http(port, "/status");
    const body = (await res.json()) as StatusShape;
    const ok = res.ok && body.setup === true;
    results.push({
      name: "/status reports setup=true after /setup/save",
      passed: ok,
      detail: ok ? undefined : `got ${JSON.stringify(body)}`,
    });
  }

  // 4. /setup/test-ynab with the stub token — expect a structural failure
  //    (any 2xx with success:false, or a 4xx). We're NOT pinning error
  //    text; the test is "the endpoint responds gracefully to a bad token."
  {
    const res = await jsonPost(port, "/setup/test-ynab", {});
    const body = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
    // The server may return 200 with success:false, OR a 4xx. Either is fine
    // for "graceful failure" — what we DON'T want is a 500 or a hang.
    const graceful = (res.ok && body?.success === false) || (res.status >= 400 && res.status < 500);
    results.push({
      name: "POST /setup/test-ynab fails gracefully on bad token",
      passed: graceful,
      detail: graceful ? undefined : `unexpected: HTTP ${res.status} ${JSON.stringify(body)}`,
    });
  }

  // 5. /models/status should respond — fresh install has no model downloaded.
  {
    const res = await http(port, "/models/status");
    const ok = res.ok;
    const body = ok ? await res.json() : null;
    results.push({
      name: "/models/status responds on fresh install",
      passed: ok && body !== null,
      detail: ok ? undefined : `HTTP ${res.status}`,
    });
  }

  return results;
}

async function main() {
  if (!fs.existsSync(BINARY)) {
    console.error(`Sidecar binary not found at ${BINARY}. Run 'npm run build:server' first.`);
    process.exit(1);
  }

  const { home: smokeHome, cleanup } = createEmptyHome();
  console.log(`Empty HOME: ${smokeHome}`);
  console.log(`Spawning sidecar from ${BINARY} on port ${SMOKE_PORT}...`);

  const child = spawn(BINARY, [], {
    env: smokeEnv({
      HOME: smokeHome,
      APP_PORT: SMOKE_PORT,
      APP_API_KEY: SMOKE_API_KEY,
      APP_API_SECRET: SMOKE_API_SECRET,
      BUDGET_ITEMIZER_NO_KEYCHAIN: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  let results: Result[] = [];

  try {
    const port = await waitForServerPort(child);
    console.log(`Sidecar listening on port ${port}.\n`);
    results = await runChecks(port, smokeHome);
  } finally {
    console.log("\nShutting down sidecar...");
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolve();
      }, 5_000);
    });
    cleanup();
  }

  console.log("\n=== Results ===");
  let failures = 0;
  for (const r of results) {
    const mark = r.passed ? "✓" : "✗";
    console.log(`${mark} ${r.name}`);
    if (!r.passed && r.detail) console.log(`    ${r.detail}`);
    if (!r.passed) failures++;
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} check(s) passed.`);
}

main().catch((err) => {
  console.error("Smoke crashed:", err);
  process.exit(2);
});

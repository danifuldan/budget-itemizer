import { spawn, execFileSync, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import { fileURLToPath } from "url";

const _currentDir = typeof import.meta.url === "string"
  ? path.dirname(fileURLToPath(import.meta.url))
  : __dirname;

// ── Singleton instance ─────────────────────────────────────────────

interface ServerInstance {
  process: ChildProcess;
  port: number;
  modelPath: string;
}

let instance: ServerInstance | null = null;
let starting = false;

// Last failed start. Used by /status so the FE can surface a recoverable
// error UI instead of spinning forever on a splash screen when the spawn
// or health-check fails. Cleared on the next successful start.
let lastStartError: string | null = null;

const PORT_BASE = 8921;

// ── Shared helpers ─────────────────────────────────────────────────

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

/** Kill any orphaned llama-server listening on a port — cleans up
 *  processes left behind when Tauri kills the sidecar with SIGKILL.
 *
 *  Important: only processes whose command name is exactly
 *  `llama-server` are killed. The port range (8921–8930) is arbitrary
 *  and may collide with other dev services on the user's machine; an
 *  earlier version blanket-killed everything on the port, which would
 *  SIGTERM e.g. a Postgres or Redis instance on every sidecar boot.
 *  Validating the command name also narrows the PID-reuse window
 *  between `lsof` and `kill` — if the orphan exits and the kernel
 *  reassigns the PID, `ps` reports a different command and we skip. */
export function killProcessOnPort(port: number): void {
  let pids: string[];
  try {
    // execFileSync avoids shell interpolation entirely; even if `port`
    // were somehow a string with metacharacters (it isn't — typed as
    // number), it'd be passed as a single argv element to lsof.
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf-8" }).trim();
    pids = out.split("\n").filter(Boolean);
  } catch {
    // No process on port — nothing to clean up
    return;
  }
  if (pids.length === 0) return;

  const ours: string[] = [];
  for (const pid of pids) {
    let cmd = "";
    try {
      cmd = execFileSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf-8" }).trim();
    } catch {
      // ps -p fails (no such process) → exited between lsof and ps.
      continue;
    }
    // ps comm= reports the basename even when spawned with an absolute
    // path. We additionally basename() to be safe across shells/ps
    // variants. The bundled binary is named "llama-server".
    if (path.basename(cmd) === "llama-server") {
      ours.push(pid);
    } else {
      console.warn(
        `[llama-server] Refusing to kill PID ${pid} on port ${port}: process is "${cmd}", not llama-server`,
      );
    }
  }
  if (ours.length === 0) return;

  console.log(`[llama-server] Killing orphaned llama-server(s) on port ${port}: ${ours.join(", ")}`);
  try {
    // execFileSync with argv array — `ours` is verified above to be
    // entries whose `ps comm=` resolved to "llama-server", so each
    // element is a numeric PID by construction. argv form avoids
    // shell interpolation regardless.
    execFileSync("kill", ours);
  } catch {
    // Race: process exited between ps and kill — ignore.
  }
}

async function findFreePort(preferred: number, attempts = 10): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = preferred + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found (tried ${preferred}–${preferred + attempts - 1})`);
}

/** Resolve llama-server binary path — bundled sibling in prod, PATH lookup in dev. */
function findBinary(): string {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    // Prod: sibling to the running binary (Contents/MacOS/)
    path.join(execDir, "llama-server"),
    // Dev: source directory
    path.join(_currentDir, "llama-server"),
    // Dev: in src-tauri/binaries with target triple suffix
    path.join(_currentDir, "..", "src-tauri", "binaries", "llama-server-aarch64-apple-darwin"),
    path.join(_currentDir, "src-tauri", "binaries", "llama-server-aarch64-apple-darwin"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("llama-server binary not found");
}

async function pollHealth(port: number, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server health check timed out after ${timeoutMs / 1000}s`);
}

// ── Public API ─────────────────────────────────────────────────────

export async function startLlamaServer(modelPath: string): Promise<string> {
  // Fast path: the requested model is already running — no start needed.
  if (instance && instance.modelPath === modelPath) {
    return `http://127.0.0.1:${instance.port}/v1`;
  }

  if (starting) {
    throw new Error("llama-server is already starting");
  }
  starting = true;

  try {
    // A different model is running — stop it first. This is part of the
    // start: `starting` stays true across the stop so callers that gate
    // on isLlamaServerStarting() (e.g. the watcher's warmup wait) don't
    // see a false "no start underway" gap during the ~stop window and
    // abort a freshly-dropped file mid-restart.
    if (instance) {
      await stopLlamaServer();
    }

    // Optimistically clear the prior failure — if we throw on this
    // attempt, the catch below will refresh it.
    lastStartError = null;

    // Kill any orphaned llama-server from a previous unclean exit
    // before checking port availability
    for (let i = 0; i < 10; i++) {
      if (await isPortFree(PORT_BASE + i)) break;
      killProcessOnPort(PORT_BASE + i);
      // Brief wait for the port to free up
      await new Promise((r) => setTimeout(r, 200));
    }
    const port = await findFreePort(PORT_BASE);
    const bin = findBinary();

    const args = [
      "--model", modelPath,
      "--port", String(port),
      "--host", "127.0.0.1",
      "--ctx-size", "4096",
      "--n-gpu-layers", "99",
    ];

    console.log(`[llama-server] Starting: ${bin} ${args.join(" ")}`);

    const binDir = path.dirname(bin);
    // In Tauri prod builds, dylibs are in Contents/Resources/binaries/
    // while the binary is in Contents/MacOS/. Include both paths.
    const resourcesDir = path.join(binDir, "..", "Resources", "binaries");
    const dylibPaths = [binDir, resourcesDir].filter(d => fs.existsSync(d)).join(":");
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DYLD_LIBRARY_PATH: dylibPaths },
    });

    child.stdout?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[llama-server] ${line}`);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[llama-server] ${line}`);
    });

    child.on("exit", (code) => {
      console.log(`[llama-server] exited with code ${code}`);
      instance = null;
    });

    await pollHealth(port);

    instance = { process: child, port, modelPath };
    console.log(`[llama-server] ready on port ${port}`);
    return `http://127.0.0.1:${port}/v1`;
  } catch (err: any) {
    // Record so /status can surface a recoverable error UI rather than
    // leaving the FE stuck on a "Loading AI model…" splash forever.
    lastStartError = err?.message ?? String(err);
    throw err;
  } finally {
    starting = false;
  }
}

/** Returns the last failed start message, or null if the most recent
 *  attempt succeeded (or there was no attempt). */
export function getLlamaServerStartError(): string | null {
  return lastStartError;
}

/** True while a start attempt is underway (including the stop of a
 *  previously-running model). Callers waiting on warmup use this to tell
 *  "permanently failed, give up" from "a restart is in progress, keep
 *  waiting" — lastStartError alone can't, since it lingers across the
 *  gap between a failed attempt and the next one. */
export function isLlamaServerStarting(): boolean {
  return starting;
}

export function stopLlamaServer(): Promise<void> {
  if (!instance) return Promise.resolve();
  console.log("[llama-server] Stopping...");
  const proc = instance.process;
  instance = null;
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once("exit", finish);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      finish();
      return;
    }
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (done) return;
      console.warn("[llama-server] didn't exit in 3s, sending SIGKILL");
      try { proc.kill("SIGKILL"); } catch {}
      // Final safety net so callers waiting on shutdown don't hang forever.
      setTimeout(finish, 1000);
    }, 3000);
  });
}

export function getLlamaServerEndpoint(): string | null {
  return instance ? `http://127.0.0.1:${instance.port}/v1` : null;
}

export function isLlamaServerRunning(): boolean {
  return instance !== null;
}

export async function stopAll(): Promise<void> {
  await stopLlamaServer();
}

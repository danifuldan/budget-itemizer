import { serve } from "@hono/node-server";
import * as net from "net";
import env from "./utils/env-vars";
import { startWatcher, startWatcherOnBoot, revalidatePendingCategories } from "./services/watcher";
import { loadConfig, getConfig, saveConfig, isSetupComplete } from "./services/config";
import { runStartupAccountMigration } from "./services/account-identity";
import { getAllAccounts } from "./services/budget";
import { getModelPath } from "./services/model-manager";
import { startLlamaServer, stopAll as stopAllLlamaServers } from "./services/llama-server";
import { setCategoriesReconnectCallback } from "./services/budget-ynab";
import { installProcessGuards } from "./services/process-guards";
import app from "./app";

// Install the process-level safety net at module scope — as early as possible,
// before any module side effect or async work runs — so a detached rejection
// (e.g. @actual-app/api's _fullSync on a missing Sync ID) can never crash the
// sidecar. See services/process-guards.ts.
installProcessGuards();

// Wire YNAB-reconnect → revalidate-pending-receipts at module load. The
// callback fires once when a real YNAB fetch succeeds AFTER the previous
// fetch fell back to the offline disk stash — i.e., the user just came
// back online. Receipts currently in pending may have been categorized
// against an older list, so we clear stale categories.
setCategoriesReconnectCallback((freshCategories) => {
  revalidatePendingCategories(freshCategories);
});

// Loopback-only host — server must not be reachable from the LAN. Probe
// the same address the real bind uses so EADDRINUSE detection matches.
const SERVER_HOST = "127.0.0.1";

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, SERVER_HOST);
  });
}

async function findAvailablePort(preferred: number, maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferred + i;
    if (await isPortFree(port)) return port;
    console.log(`Port ${port} in use, trying next...`);
  }
  throw new Error(`No available port found (tried ${preferred}–${preferred + maxAttempts - 1})`);
}

async function main() {
  const config = await loadConfig();

  // Start the bundled llama-server. Fire-and-forget: nothing in boot
  // awaits readiness — the watcher starts immediately (queueFile waits
  // for the server before parsing) and the FE polls /status for llmReady.
  const modelPath = getModelPath(config.embeddedModel);
  if (modelPath) {
    startLlamaServer(modelPath).catch((err) => {
      console.error("Failed to start llama-server:", err);
    });
  } else {
    console.log("Local model not downloaded yet — skipping llama-server start.");
  }

  // Graceful shutdown — stop llama-server children first so they don't get
  // orphaned and hold the bundled binary open, then close budget provider
  // connections. The Tauri shell sends SIGTERM with a 3s grace period.
  let shuttingDown = false;
  const gracefulShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await stopAllLlamaServers();
    } catch (err) {
      console.error("Error stopping llama-server:", err);
    }
    try {
      const { getBudgetProvider } = await import("./services/budget-provider");
      await getBudgetProvider().shutdown();
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", gracefulShutdown);
  process.on("SIGINT", gracefulShutdown);

  const port = await findAvailablePort(env.APP_PORT);

  // Hand the basic-auth credentials to the Tauri shell over stdout. The
  // pipe is private to the parent process; same-user attackers can't
  // read another process's stdout. Tauri parses these lines and exposes
  // them to the webview via the `get_app_credentials` IPC command — so
  // the credentials never travel over HTTP. Replaces the old
  // `/setup/status` cred-handout, which leaked them to any reachable
  // client. The Rust side redacts these lines from the log file.
  const appApiKey = config.appApiKey || env.APP_API_KEY || "";
  const appApiSecret = config.appApiSecret || env.APP_API_SECRET || "";
  if (appApiKey && appApiSecret) {
    console.log(`APP_API_KEY=${appApiKey}`);
    console.log(`APP_API_SECRET=${appApiSecret}`);
  }

  serve(
    {
      fetch: app.fetch,
      port,
      hostname: SERVER_HOST,
    },
    async (info) => {
      // Machine-readable line for Tauri sidecar to parse
      console.log(`SERVER_PORT=${info.port}`);
      console.log(`Server running on http://localhost:${info.port}`);

      // Start the inbox watcher as soon as the server binds. It does NOT
      // depend on the LLM: queueFile waits for llama-server before
      // parsing, so a receipt dropped during model warmup is queued and
      // shown as "Loading AI model…", not lost. Gating the watcher on
      // llmReady previously produced a false "inbox unreachable" status
      // and no pending entry for the whole warmup window. (llmReady's
      // failure is already logged via its .catch above; nothing after
      // this point needs to await it.)
      startWatcherOnBoot({
        isSetupComplete,
        getConfig: () => getConfig(),
        startWatcher,
      });

      // Non-blocking: reconcile account identity from the mutable display
      // NAME to the stable YNAB id. Runs AFTER serve binds so it never
      // delays boot; steady-state (id already resolved, no name-keyed
      // hidden entries) early-returns without a YNAB call.
      void runStartupAccountMigration({
        getConfig: () => getConfig(),
        resolveAccounts: getAllAccounts,
        persist: (u) => { void saveConfig(u); },
      });
    }
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

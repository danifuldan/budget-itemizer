import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock all service modules before importing app
vi.mock("./utils/env-vars", () => ({
  default: {
    LLM_ENDPOINT: "http://localhost:11434/v1",
    LLM_TEXT_MODEL: "llama3.1:latest",
    LLM_API_KEY: "",
    YNAB_API_KEY: "test-ynab-key",
    YNAB_BUDGET_ID: "test-budget-id",
    YNAB_CATEGORY_GROUPS: [],
    APP_PORT: 3000,
    APP_API_KEY: "testuser",
    APP_API_SECRET: "testpass",
    MAX_FILE_SIZE: 5242880,
  },
}));

vi.mock("./services/budget", () => ({
  getAllAccounts: vi.fn(),
  getAllEnvelopes: vi.fn(),
}));

vi.mock("./services/receipt", () => ({
  parseImageReceiptStream: vi.fn(),
  importReceiptToYnab: vi.fn(),
}));

vi.mock("./services/config", () => ({
  getConfig: vi.fn(() => ({
    ynabApiKey: "test-key",
    ynabBudgetId: "test-budget",
    ynabCategoryGroups: [],
    defaultAccount: "Checking",
    inboxPath: "/inbox",
    processedPath: "/processed",
    appPort: 3000,
    appApiKey: "",
    appApiSecret: "",
    watcherEnabled: true,
    watcherAutoImport: false,
    watcherNotify: true,
    watcherFocusApp: true,
    minimizeToTray: true,
    matchAcrossAccounts: true,
    hiddenAccounts: [],
  })),
  saveConfig: vi.fn((updates: any) => ({ ...updates })),
  isSetupComplete: vi.fn(() => true),
}));

vi.mock("./services/history", () => ({
  getHistory: vi.fn(() => []),
  addRecord: vi.fn(),
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
    startWatcher: vi.fn(() => ({ running: true, inboxPath: "/inbox" })),
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

import app from "./app";
import { getAllAccounts, getAllEnvelopes } from "./services/budget";
import { importReceiptToYnab } from "./services/receipt";
import { saveConfig, isSetupComplete } from "./services/config";
import { claimForImport, releaseImportClaim, getPending, removePending, clearAllPending, getWatcherStatus, stopWatcher, startWatcher, queueFile, addPending } from "./services/watcher";
import { getConfig } from "./services/config";
import { getLlamaServerStartError } from "./services/llama-server";

const authHeader = "Basic " + Buffer.from("testuser:testpass").toString("base64");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("Hono app integration", () => {
  it("GET /healthz returns 200 OK", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("GET /status returns server status JSON", async () => {
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.server).toBe("running");
    expect(body).toHaveProperty("setup");
    expect(body).toHaveProperty("watcher");
  });

  // Regression: when the builtin llama-server fails to start, /status used
  // to report only `llmReady: false` with no way for the FE to distinguish
  // "still loading" from "failed permanently." The FE then sat on a
  // "Loading local AI model…" splash forever. /status now surfaces the
  // start error so the FE can render a recoverable error UI.
  it("GET /status surfaces llmStartError when llama-server failed to start", async () => {
    vi.mocked(getLlamaServerStartError).mockReturnValueOnce("llama-server health check timed out after 180s");

    const res = await app.request("/status");
    const body = await res.json();
    expect(body.llmStartError).toBe("llama-server health check timed out after 180s");
    expect(body.llmReady).toBe(true); // still reports running because we mocked it true
  });

  it("GET /history returns JSON array", async () => {
    const res = await app.request("/history", {
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it("GET /accounts without auth returns 401", async () => {
    const res = await app.request("/accounts");
    expect(res.status).toBe(401);
  });

  it("GET /accounts with auth returns accounts", async () => {
    vi.mocked(getAllAccounts).mockResolvedValue(["Checking", "Savings"]);
    const res = await app.request("/accounts", {
      headers: { Authorization: authHeader },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(["Checking", "Savings"]);
  });

  it("POST /import with valid body returns success", async () => {
    vi.mocked(importReceiptToYnab).mockResolvedValue(undefined);
    const res = await app.request("/import", {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        account: "Checking",
        receipt: {
          merchant: "Walmart",
          transactionDate: "2024-01-01",
          memo: "Groceries",
          totalAmount: 42.99,
          category: "Groceries",
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("POST /import is idempotent: a second concurrent call for the same sourceFilename is rejected with 409", async () => {
    // First call gets the claim; second sees `false` and short-circuits.
    vi.mocked(claimForImport).mockReturnValueOnce(true).mockReturnValueOnce(false);
    // Make the YNAB submit slow enough that both requests overlap.
    vi.mocked(importReceiptToYnab).mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 50)),
    );

    const body = JSON.stringify({
      account: "Checking",
      sourceFilename: "walmart-receipt.pdf",
      receipt: {
        merchant: "Walmart",
        transactionDate: "2024-01-01",
        memo: "Groceries",
        totalAmount: 42.99,
        category: "Groceries",
      },
    });
    const opts = {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body,
    };

    const [first, second] = await Promise.all([
      app.request("/import", opts),
      app.request("/import", opts),
    ]);

    // Exactly one of the two responses succeeded; the other was 409.
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    // YNAB submit was called exactly once — the duplicate never reached it.
    expect(importReceiptToYnab).toHaveBeenCalledTimes(1);
  });

  // Regression: DELETE-vs-POST race used to silently destroy data. A
  // concurrent re-upload could overwrite the file on disk while a stale
  // FE clicked Discard; the DELETE handler then unlinked the new file
  // and the system returned 200 to both. The fix is a `detectedAt`
  // version token: the FE supplies the token it rendered, the server
  // compares it against the current entry, and refuses on mismatch.
  it("DELETE /watcher/pending refuses when detectedAt token doesn't match (409)", async () => {
    vi.mocked(getPending).mockReturnValue({
      filename: "foo.pdf",
      filePath: "/inbox/foo.pdf",
      detectedAt: "2026-01-01T00:00:01.000Z",
      status: "ready",
    } as any);

    const res = await app.request(
      "/watcher/pending/foo.pdf?detectedAt=2026-01-01T00%3A00%3A00.000Z",
      { method: "DELETE", headers: { Authorization: authHeader } },
    );

    expect(res.status).toBe(409);
    expect(removePending).not.toHaveBeenCalled();
  });

  it("DELETE /watcher/pending succeeds when detectedAt token matches", async () => {
    vi.mocked(getPending).mockReturnValue({
      filename: "foo.pdf",
      filePath: "/inbox/nonexistent-foo.pdf", // unlinkSync will throw, caught by try
      detectedAt: "2026-01-01T00:00:00.000Z",
      status: "ready",
    } as any);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await app.request(
      "/watcher/pending/foo.pdf?detectedAt=2026-01-01T00%3A00%3A00.000Z",
      { method: "DELETE", headers: { Authorization: authHeader } },
    );

    expect(res.status).toBe(200);
    expect(removePending).toHaveBeenCalledWith("foo.pdf");
  });

  // Regression: when a brand-new user finished the SetupWizard, the
  // watcher stayed dead. index.ts main() only auto-starts at boot, and
  // the wizard's onComplete doesn't POST /watcher/start (verified by
  // grep — only SettingsView's Watch-inbox toggle calls it). End-state
  // for a fresh install: user finishes wizard, drops a receipt, nothing
  // happens. Fix in /config detects isSetupComplete false→true and
  // starts the watcher.
  it("POST /config starts the watcher on isSetupComplete false→true transition", async () => {
    vi.mocked(saveConfig).mockResolvedValue({} as any);
    // isSetupComplete returns false before the save (incomplete config),
    // true after — simulating the wizard's final save landing.
    vi.mocked(isSetupComplete).mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.mocked(getWatcherStatus).mockReturnValue({ running: false } as any);

    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAccount: "Checking" }),
    });

    expect(res.status).toBe(200);
    expect(startWatcher).toHaveBeenCalledTimes(1);
    // Not the path-change branch — stopWatcher should NOT have fired.
    expect(stopWatcher).not.toHaveBeenCalled();
  });

  it("POST /config does NOT start the watcher when setup was already complete", async () => {
    vi.mocked(saveConfig).mockResolvedValue({} as any);
    vi.mocked(isSetupComplete).mockReturnValue(true);
    vi.mocked(getWatcherStatus).mockReturnValue({ running: true } as any);

    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ defaultAccount: "Checking" }),
    });

    expect(res.status).toBe(200);
    expect(startWatcher).not.toHaveBeenCalled();
  });

  it("POST /config clears pending when inboxPath changes", async () => {
    vi.mocked(saveConfig).mockResolvedValue({} as any);
    vi.mocked(getWatcherStatus).mockReturnValue({ running: true } as any);

    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ inboxPath: "/Users/me/NewInbox" }),
    });

    expect(res.status).toBe(200);
    expect(stopWatcher).toHaveBeenCalled();
    expect(clearAllPending).toHaveBeenCalled();
    expect(startWatcher).toHaveBeenCalled();
  });

  it("POST /config does NOT clear pending when only processedPath changes", async () => {
    vi.mocked(saveConfig).mockResolvedValue({} as any);
    vi.mocked(getWatcherStatus).mockReturnValue({ running: true } as any);

    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ processedPath: "/Users/me/NewProcessed" }),
    });

    expect(res.status).toBe(200);
    expect(stopWatcher).toHaveBeenCalled();
    expect(clearAllPending).not.toHaveBeenCalled();
    expect(startWatcher).toHaveBeenCalled();
  });

  it("DELETE /watcher/pending without a token still works (back-compat)", async () => {
    vi.mocked(getPending).mockReturnValue({
      filename: "foo.pdf",
      filePath: "/inbox/nonexistent-foo.pdf",
      detectedAt: "2026-01-01T00:00:00.000Z",
      status: "ready",
    } as any);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await app.request("/watcher/pending/foo.pdf", {
      method: "DELETE",
      headers: { Authorization: authHeader },
    });

    expect(res.status).toBe(200);
    expect(removePending).toHaveBeenCalledWith("foo.pdf");
  });

  it("POST /import surfaces YNAB rate-limit as 429 with Retry-After header", async () => {
    const { RateLimitError } = await import("./services/budget-provider");
    vi.mocked(claimForImport).mockReturnValue(true);
    vi.mocked(importReceiptToYnab).mockRejectedValue(
      new RateLimitError("YNAB rate limit hit.", 60),
    );

    const res = await app.request("/import", {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        account: "Checking",
        sourceFilename: "walmart-receipt.pdf",
        receipt: {
          merchant: "Walmart",
          transactionDate: "2024-01-01",
          memo: "Groceries",
          totalAmount: 42.99,
          category: "Groceries",
        },
      }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(releaseImportClaim).toHaveBeenCalledWith("walmart-receipt.pdf");
  });

  it("POST /import releases the import claim if the budget submit throws", async () => {
    vi.mocked(claimForImport).mockReturnValue(true);
    vi.mocked(importReceiptToYnab).mockRejectedValue(new Error("YNAB unreachable"));

    const res = await app.request("/import", {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({
        account: "Checking",
        sourceFilename: "walmart-receipt.pdf",
        receipt: {
          merchant: "Walmart",
          transactionDate: "2024-01-01",
          memo: "Groceries",
          totalAmount: 42.99,
          category: "Groceries",
        },
      }),
    });

    expect(res.status).toBe(500);
    expect(releaseImportClaim).toHaveBeenCalledWith("walmart-receipt.pdf");
  });

  // Regression: round-7 scenario testing showed POST /config with a
  // 100KB inboxPath was accepted and persisted to disk, ballooning
  // config.json to 100KB and breaking downstream fs.watch / OS path
  // operations. The Zod schema now caps every string field.
  it("POST /config rejects an oversized inboxPath", async () => {
    const huge = "a".repeat(5000); // > PATH_MAX (4096)
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ inboxPath: huge }),
    });
    expect(res.status).toBe(400);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  // Regression: round-7 scenario testing showed POST /watcher/inbox
  // created zombie pending entries — addPending inserted status="parsing"
  // which then blocked the watcher's queueFile from running the actual
  // parse pipeline (queueFile bails on `pendingFiles.has(filename)`).
  // Files sat at "parsing" forever. Fix invokes queueFile directly.
  it("POST /watcher/inbox triggers queueFile (drives the parse), not just addPending", async () => {
    // /watcher/inbox writes to disk + invokes queueFile. Point at a
    // real tmp dir so the write succeeds; default mock has inboxPath:
    // "/inbox" which fs.mkdirSync would refuse with EACCES.
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpInbox = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-inbox-test-"));
    // Override every getConfig call for the duration of this test (auth
    // middleware reads getConfig too, so mockReturnValueOnce burns on
    // the wrong call). Empty appApiKey so basic-auth falls through to
    // the env-vars mock (testuser/testpass) that other tests rely on.
    vi.mocked(getConfig).mockReturnValue({
      inboxPath: tmpInbox,
      watcherAutoImport: false,
      appApiKey: "",
      appApiSecret: "",
    } as any);

    try {
      const res = await app.request("/watcher/inbox", {
        method: "POST",
        headers: { Authorization: authHeader },
        body: (() => {
          const fd = new FormData();
          fd.append("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "x.pdf", { type: "application/pdf" }));
          return fd;
        })(),
      });
      expect(res.status).toBe(200);
      expect(queueFile).toHaveBeenCalledTimes(1);
      const [calledPath, calledAutoImport] = (queueFile as any).mock.calls[0];
      expect(calledPath).toMatch(/x\.pdf$/);
      expect(calledAutoImport).toBe(false);
      // Critical: addPending is NOT called (it was the zombie source).
      expect(addPending).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpInbox, { recursive: true, force: true });
    }
  });

  it("POST /config accepts a normal-length inboxPath", async () => {
    vi.mocked(saveConfig).mockResolvedValue({} as any);
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ inboxPath: "/Users/me/Receipts/inbox" }),
    });
    expect(res.status).toBe(200);
  });

  it("POST /setup/save without auth returns 401 even when setup is incomplete", async () => {
    // Pre-hardening, /setup/save was open during the first-run window so
    // any unauth caller could write `ynabApiKey` into Keychain and
    // redirect the user's future imports. Now requires auth always —
    // the Tauri IPC bootstrap gives the FE its creds before the
    // wizard ever POSTs.
    vi.mocked(isSetupComplete).mockReturnValue(false);
    const res = await app.request("/setup/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ynabApiKey: "new-key" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /parse-image/stream without auth returns 401", async () => {
    const res = await app.request("/parse-image/stream", {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});

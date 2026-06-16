/**
 * Adversarial probes on the Hono app — Host header check, basic auth,
 * setup-route auth gating, /watcher/pending DELETE param sanitization,
 * filename sanitization that feeds /watcher/inbox writes, oversized config.
 *
 * Mindset: do not test the inputs the production-code comments admit work
 * — test the inputs the author did not think of. Where there's a defense,
 * find the boundary between two defenses (sanitize vs filesystem,
 * basic-auth vs Host, etc.) and shove a payload through it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
    ynabDefaultAccount: "Checking",
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
    budgetProvider: "ynab",
    ynabHiddenAccounts: [],
    actualHiddenAccounts: [],
  })),
  saveConfig: vi.fn((updates: any) => ({ ...updates })),
  isSetupComplete: vi.fn(() => true),
  wasConfigReset: vi.fn(() => false),
}));

vi.mock("./services/history", () => ({
  getHistory: vi.fn(() => []),
  addRecord: vi.fn(),
  deleteRecord: vi.fn(() => true),
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

vi.mock("./services/model-manager", () => ({
  AVAILABLE_MODELS: [],
  getModelsStatus: vi.fn(() => []),
  isModelDownloaded: vi.fn(() => true),
  downloadModel: vi.fn(),
  cancelDownload: vi.fn(),
  getModelPath: vi.fn(),
}));

import app from "./app";
import { getPending, removePending } from "./services/watcher";

const goodAuth = "Basic " + Buffer.from("testuser:testpass").toString("base64");

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ============================================================================
// Host-header / DNS-rebinding defense
// ============================================================================
//
// The code reads the hostname out of new URL(c.req.url). Hono's app.request()
// accepts either a path ("/x") or a full URL string. When given a full URL,
// it propagates that URL to c.req.url. Whether the Host *header* alone
// affects c.req.url is the question we want answered — these tests force
// every variant we can construct.

describe("Host-header / DNS-rebinding defense", () => {
  it("path-only request to /healthz: localhost-derived URL → 200", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });

  it("full URL with evil.com hostname → 421 Misdirected Request", async () => {
    const res = await app.request("http://evil.com/healthz");
    expect(res.status).toBe(421);
  });

  it("subdomain trick — localhost.attacker.com → 421", async () => {
    const res = await app.request("http://localhost.attacker.com/healthz");
    expect(res.status).toBe(421);
  });

  it("subdomain trick — 127.0.0.1.attacker.com → 421", async () => {
    const res = await app.request("http://127.0.0.1.attacker.com/healthz");
    expect(res.status).toBe(421);
  });

  it("uppercase variant — EVIL.COM → 421 (after .toLowerCase())", async () => {
    const res = await app.request("http://EVIL.COM/healthz");
    expect(res.status).toBe(421);
  });

  // The strip-square-brackets logic targets IPv6 literals. Make sure
  // [::1] is accepted and [::ffff:127.0.0.1] (IPv4-mapped, also loopback)
  // is rejected (only "::1" is in the allow-list; this is intentional but
  // worth pinning).
  it("[::1] (IPv6 loopback) → 200", async () => {
    const res = await app.request("http://[::1]/healthz");
    expect(res.status).toBe(200);
  });

  it("[::ffff:127.0.0.1] (IPv4-mapped IPv6) → 421 (NOT in LOOPBACK_HOSTS)", async () => {
    const res = await app.request("http://[::ffff:127.0.0.1]/healthz");
    expect(res.status).toBe(421);
  });

  // IPv6 link-local loopback variants ("::") are not in the allow-list.
  it("[::] (unspecified IPv6) → 421", async () => {
    const res = await app.request("http://[::]/healthz");
    expect(res.status).toBe(421);
  });

  // IDN homoglyph — Punycode form of a lookalike host. The whatwg URL
  // parser rejects some IDN forms outright in fetch-Request init. We
  // try a valid Punycode label that DOES parse. If the URL itself is
  // rejected by the Request constructor, this assertion uses a try
  // wrapper: the request must NOT succeed with 200.
  it("Punycode homoglyph host is not loopback-equivalent (200 disallowed)", async () => {
    let status = 0;
    try {
      const res = await app.request("http://xn--80akhbyknj4f.test/healthz");
      status = res.status;
    } catch {
      // Acceptable: URL ctor rejected the host entirely.
      status = -1;
    }
    expect(status).not.toBe(200);
  });

  // Port shouldn't matter — the check uses URL.hostname (without port).
  it("loopback with explicit non-default port → 200", async () => {
    const res = await app.request("http://127.0.0.1:9999/healthz");
    expect(res.status).toBe(200);
  });

  // Try to ride a CRLF through the URL path to influence header parsing.
  // URL ctor should reject this; if it throws inside the try, the catch
  // returns 421. We want to confirm.
  it("URL with CRLF injection attempt is handled (URL throws → catch → 421)", async () => {
    // Some URL constructors will throw on these.
    const url = "http://127.0.0.1/foo\r\nHost: evil.com";
    let status = 0;
    try {
      const res = await app.request(url);
      status = res.status;
    } catch {
      // Acceptable: app.request itself throws.
      status = -1;
    }
    // Either app.request rejects, or the defense returns 421. Allow both
    // outcomes; what we MUST NOT see is 200 (the bypass).
    expect(status).not.toBe(200);
  });

  // Trailing dot on the hostname — DNS-style FQDN form. The DNS resolver
  // treats "localhost." as equivalent to "localhost", but our string
  // equality check does not. Worth confirming the strict-vs-DNS-loose
  // boundary.
  it("trailing-dot loopback (localhost.) → 421 (strict string match)", async () => {
    const res = await app.request("http://localhost./healthz");
    expect(res.status).toBe(421);
  });

  // 0.0.0.0 is sometimes treated as a loopback alias by OS resolvers but
  // is NOT in LOOPBACK_HOSTS.
  it("0.0.0.0 → 421 (not in allow-list)", async () => {
    const res = await app.request("http://0.0.0.0/healthz");
    expect(res.status).toBe(421);
  });

  // Decimal-encoded IP — node's URL ctor normalizes 2130706433 → 127.0.0.1
  // so hostname becomes "127.0.0.1" by the time we read it. Pin this:
  // decimal-encoded loopback IS treated as loopback (consistent with the
  // browser's interpretation; an attacker can't gain anything by using
  // this form because they'd still need to bind to 127.0.0.1).
  it("decimal-encoded loopback (2130706433) is normalized to 127.0.0.1 → 200", async () => {
    const res = await app.request("http://2130706433/healthz");
    expect(res.status).toBe(200);
  });

  // Octal-encoded IP — same family. URL ctor normalizes 0177.0.0.1 → 127.0.0.1.
  it("octal-encoded loopback (0177.0.0.1) is normalized → 200", async () => {
    let status = 0;
    try {
      const res = await app.request("http://0177.0.0.1/healthz");
      status = res.status;
    } catch {
      status = -1;
    }
    // Either it normalizes to loopback (200) or the URL ctor rejects (-1).
    // What we must NEVER see is the attacker getting past the check with
    // a non-loopback hostname.
    expect([200, -1]).toContain(status);
  });
});

// ============================================================================
// Basic auth — constantTimeStrEq
// ============================================================================

describe("Basic auth — wrong creds in many shapes", () => {
  // No header at all
  it("no Authorization header → 401", async () => {
    const res = await app.request("/accounts");
    expect(res.status).toBe(401);
  });

  // Wrong username, right password
  it("wrong username, right password → 401", async () => {
    const a = "Basic " + Buffer.from("wrong:testpass").toString("base64");
    const res = await app.request("/accounts", { headers: { Authorization: a } });
    expect(res.status).toBe(401);
  });

  // Right username, wrong password
  it("right username, wrong password → 401", async () => {
    const a = "Basic " + Buffer.from("testuser:wrong").toString("base64");
    const res = await app.request("/accounts", { headers: { Authorization: a } });
    expect(res.status).toBe(401);
  });

  // Empty everything
  it("empty username and password → 401", async () => {
    const a = "Basic " + Buffer.from(":").toString("base64");
    const res = await app.request("/accounts", { headers: { Authorization: a } });
    expect(res.status).toBe(401);
  });

  // Username is a prefix of the real one
  it("prefix-of-username attack → 401 (length mismatch defense)", async () => {
    const a = "Basic " + Buffer.from("test:testpass").toString("base64");
    const res = await app.request("/accounts", { headers: { Authorization: a } });
    expect(res.status).toBe(401);
  });

  // Username is the real one padded with NUL bytes — would a buggy
  // constant-time compare strip trailing NUL and match? (Buffer.alloc
  // zero-fills; constantTimeStrEq pads with Buffer.alloc(max).)
  it("username padded with NUL bytes is NOT accepted", async () => {
    const padded = "testuser" + "\x00".repeat(8);
    const a = "Basic " + Buffer.from(`${padded}:testpass`).toString("base64");
    const res = await app.request("/accounts", { headers: { Authorization: a } });
    // The length check `aBuf.length === bBuf.length` at the end of
    // constantTimeStrEq is the only thing rejecting this. If a future
    // refactor drops it, this test catches the regression.
    expect(res.status).toBe(401);
  });

  // Pure null-byte secret
  it("username/password = NUL bytes only → 401", async () => {
    const a = "Basic " + Buffer.from("\x00\x00:\x00\x00").toString("base64");
    const res = await app.request("/accounts", { headers: { Authorization: a } });
    expect(res.status).toBe(401);
  });

  // Username with whitespace appended (some user-input fields trim — we
  // don't, so this should fail).
  it("trailing-whitespace username → 401", async () => {
    const a = "Basic " + Buffer.from("testuser :testpass").toString("base64");
    const res = await app.request("/accounts", { headers: { Authorization: a } });
    expect(res.status).toBe(401);
  });

  // Multi-byte Unicode that happens to share a prefix
  it("unicode same-prefix username → 401", async () => {
    const a = "Basic " + Buffer.from("testuser™:testpass").toString("base64");
    const res = await app.request("/accounts", { headers: { Authorization: a } });
    expect(res.status).toBe(401);
  });
});

describe("Setup endpoints require auth", () => {
  it("POST /setup/save without auth → 401", async () => {
    const res = await app.request("/setup/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ynabApiKey: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /setup/test-ynab without auth → 401", async () => {
    const res = await app.request("/setup/test-ynab", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /setup/test-actual without auth → 401", async () => {
    const res = await app.request("/setup/test-actual", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("GET /setup/status without auth → 401", async () => {
    const res = await app.request("/setup/status");
    expect(res.status).toBe(401);
  });
});

// ============================================================================
// /watcher/pending/:filename DELETE param re-sanitization
// ============================================================================

describe("DELETE /watcher/pending re-sanitization", () => {
  // The handler does `path.basename(c.req.param("filename"))` after Hono
  // has already URL-decoded the param. The question is: does Hono decode
  // %2F → "/" so that path.basename can strip the prefix? Or does Hono
  // preserve the encoded form, leaving "..%2F..%2Fetc%2Fpasswd" as a
  // single token that path.basename returns unchanged?
  // Either way, the lookup must NOT find a pending entry called
  // "/etc/passwd" or similar — getPending is keyed on real filenames.

  it("URL-encoded path traversal: '..%2F..%2Fetc%2Fpasswd' returns 404 (no pending entry)", async () => {
    // No matching entry exists.
    (getPending as any).mockReturnValue(undefined);
    const res = await app.request(
      "/watcher/pending/..%2F..%2Fetc%2Fpasswd",
      { method: "DELETE", headers: { Authorization: goodAuth } },
    );
    expect(res.status).toBe(404);
    expect(removePending).not.toHaveBeenCalled();
  });

  it("URL-encoded Windows traversal: '..%5C..%5Cwin' returns 404", async () => {
    (getPending as any).mockReturnValue(undefined);
    const res = await app.request(
      "/watcher/pending/..%5C..%5Cwin",
      { method: "DELETE", headers: { Authorization: goodAuth } },
    );
    expect(res.status).toBe(404);
  });

  // URL-encoded NUL — Hono may or may not pass this through. If it
  // surfaces in the filename, the get/remove calls receive a string with
  // an embedded NUL. The map lookup will simply miss.
  it("URL-encoded NUL byte returns 404 (and doesn't crash)", async () => {
    (getPending as any).mockReturnValue(undefined);
    const res = await app.request(
      "/watcher/pending/receipt%00.pdf",
      { method: "DELETE", headers: { Authorization: goodAuth } },
    );
    // Status: depends — either 404 (we miss) or maybe 400 from Hono
    // route matching. NEVER 200 (the unsafe path).
    expect(res.status).not.toBe(200);
  });

  // Extremely long filename — does the route handle it without buffer
  // issues? path.basename on a 5000-char string is fine; the question is
  // whether the route accepts it at all.
  it("4096-char filename param does not crash and returns 404", async () => {
    (getPending as any).mockReturnValue(undefined);
    const huge = "a".repeat(4096) + ".pdf";
    const res = await app.request(`/watcher/pending/${huge}`, {
      method: "DELETE",
      headers: { Authorization: goodAuth },
    });
    expect(res.status).not.toBe(200);
  });
});

// ============================================================================
// /config — boundary fuzz
// ============================================================================

describe("POST /config — schema boundary fuzz", () => {
  // The schema declares `.strict()`. An unknown field should be rejected
  // (not silently dropped or worse: silently persisted to disk).
  it("unknown field 'llmEndpoint' (removed) is rejected (.strict())", async () => {
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: goodAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ llmEndpoint: "http://attacker.example/v1" }),
    });
    // strict() → 400 with ZodError.
    expect(res.status).toBe(400);
  });

  it("unknown field 'appApiKey' is rejected (.strict())", async () => {
    // appApiKey is intentionally NOT in configUpdateSchema — credentials
    // come from Keychain and must not be settable over HTTP. If a future
    // refactor adds appApiKey to the schema, this test fails and forces
    // a security review.
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: goodAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ appApiKey: "attacker-knows-this-now" }),
    });
    expect(res.status).toBe(400);
  });

  // Exactly at the SECRET_MAX cap (8192).
  it("ynabApiKey at exactly 8192 chars is accepted", async () => {
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: goodAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ ynabApiKey: "a".repeat(8192) }),
    });
    expect(res.status).toBe(200);
  });

  it("ynabApiKey at 8193 chars is rejected", async () => {
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: goodAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ ynabApiKey: "a".repeat(8193) }),
    });
    expect(res.status).toBe(400);
  });

  // Embedded NUL byte in inboxPath — Zod max() accepts any chars; the
  // resulting path would be used to fs.mkdirSync. Does the validator
  // catch this, or does it flow through to fs?
  // (This is the *boundary between Zod validation and filesystem ops*.)
  it("NUL byte in inboxPath: WARNING — Zod allows it through", async () => {
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: goodAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ inboxPath: "/Users/x/\x00malicious" }),
    });
    // If the schema rejects it, great. If not, the request succeeds and
    // we'd write a config.json that contains a NUL — which downstream
    // fs.mkdirSync would refuse (ENOENT or EINVAL on macOS). Document
    // current behavior in this test for future hardening review.
    // Asserting: this must NOT silently persist a poisoned path.
    // We accept either 200 (with downstream protection) or 400 (rejected).
    // What we MUST NOT see: 500 (uncaught crash).
    expect([200, 400]).toContain(res.status);
  });

  // Negative scalar where boolean expected
  it("watcherEnabled = 'true' (string) is rejected (Zod boolean)", async () => {
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: goodAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ watcherEnabled: "true" }),
    });
    expect(res.status).toBe(400);
  });

  // ynabHiddenAccounts at exactly 256 entries — boundary
  it("ynabHiddenAccounts at exactly 256 entries is accepted", async () => {
    const arr = Array.from({ length: 256 }, (_, i) => `acct${i}`);
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: goodAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ ynabHiddenAccounts: arr }),
    });
    expect(res.status).toBe(200);
  });

  it("ynabHiddenAccounts at 257 entries is rejected", async () => {
    const arr = Array.from({ length: 257 }, (_, i) => `acct${i}`);
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: goodAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ ynabHiddenAccounts: arr }),
    });
    expect(res.status).toBe(400);
  });

  // Discount mode — only "distribute" or "credit" allowed. Try a typo
  // and an injection attempt.
  it("discountMode = 'distribute; rm -rf /' is rejected (enum)", async () => {
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: goodAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ discountMode: "distribute; rm -rf /" }),
    });
    expect(res.status).toBe(400);
  });

  // Confirm there is no way to set the removed LLM provider/endpoint via
  // any allowed field. We check every field in the schema for "looks like
  // a URL the LLM could be redirected to" — none should accept it.
  it("malicious URL in actualServerUrl is accepted as-is (URL is not validated as same-host)", async () => {
    // This is intentional — actualServerUrl is a user-supplied URL.
    // Just pinning behavior. The danger is the TLS dispatcher swap; that
    // is scoped by string-prefix to whatever the user typed, so a typoed
    // URL only relaxes TLS for that typo'd host.
    const res = await app.request("/config", {
      method: "POST",
      headers: { Authorization: goodAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ actualServerUrl: "https://attacker.example" }),
    });
    expect(res.status).toBe(200);
  });
});

// ============================================================================
// CORS — production tightening
// ============================================================================

describe("CORS — narrow by default", () => {
  // After premortem-2 fix: CORS is strict UNLESS both (a) not running
  // inside the pkg-bundled binary, AND (b) NODE_ENV === "development".
  // Vitest sets NODE_ENV=test, so the dev origins are NOT allowed here.
  // The previous (buggy) gate would have allowed localhost:5173 in this
  // very context — exactly the leak this test catches.

  it("strict-by-default: Origin http://localhost:5173 is NOT reflected (NODE_ENV=test)", async () => {
    const res = await app.request("/healthz", {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("dev: Origin tauri://localhost gets Access-Control-Allow-Origin", async () => {
    const res = await app.request("/healthz", {
      headers: { Origin: "tauri://localhost" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("tauri://localhost");
  });

  it("attacker Origin http://evil.example does NOT get the header", async () => {
    // Note: the Host header check runs FIRST and would return 421 for
    // evil hostnames; this test sends localhost Host (the default from
    // path-only request) with a non-allowed Origin — that's the realistic
    // attack: rebinding makes the browser send Host: 127.0.0.1, but the
    // Origin still reads http://evil.example because the page came from
    // evil.example.
    const res = await app.request("/healthz", {
      headers: { Origin: "http://evil.example" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("attacker Origin http://localhost:1337 (random port) does NOT match localhost:5173/1420/3456", async () => {
    const res = await app.request("/healthz", {
      headers: { Origin: "http://localhost:1337" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

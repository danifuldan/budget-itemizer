import { basicAuth } from "hono/basic-auth";
import { cors } from "hono/cors";
import { randomBytes, timingSafeEqual } from "crypto";
import { getConfig } from "../services/config";
import env from "../utils/env-vars";

// Replaces the default hono/logger import — its formatter logs the full
// request URL including the query string, which leaks the SSE auth token
// from /watcher/events?token=... into ~/Library/Logs/Budget Itemizer/.
// Custom one logs only method + pathname + status.
export function pathOnlyLogger() {
  return async (c: any, next: any) => {
    const start = Date.now();
    const pathOnly = (() => {
      try {
        return new URL(c.req.url).pathname;
      } catch {
        return c.req.path;
      }
    })();
    console.log(`  <-- ${c.req.method} ${pathOnly}`);
    await next();
    const elapsed = Date.now() - start;
    console.log(`  --> ${c.req.method} ${pathOnly} ${c.res.status} ${elapsed}ms`);
  };
}

// DNS-rebinding defense: reject any request whose effective hostname
// isn't loopback. Read from the parsed URL rather than the raw Host
// header — Hono populates URL.hostname from the Host header in real
// HTTP, but also fills it sensibly when tests build requests via
// app.request("/path") which omits the explicit header. Browsers
// rebinding `evil.com → 127.0.0.1` send `Host: evil.com:<port>`,
// which surfaces here as URL.hostname = "evil.com" and gets 421'd
// before CORS can add headers an attacker could read.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
export function hostAllowlist() {
  return async (c: any, next: any) => {
    let hostname = "";
    try {
      hostname = new URL(c.req.url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    } catch {
      return c.text("Misdirected Request", 421);
    }
    if (!LOOPBACK_HOSTS.has(hostname)) {
      return c.text("Misdirected Request", 421);
    }
    await next();
  };
}

// CORS: production-strict by default. Loose CORS (allowing the Vite
// dev port 5173, Tauri dev shell 1420, default sidecar 3456) only kicks
// in when BOTH conditions hold:
//   (a) not running inside the pkg-bundled binary (`process.pkg` unset)
//   (b) NODE_ENV is explicitly "development"
//
// Earlier iteration of this gate used `isProd = process.pkg != null`,
// which silently flipped the default to loose for every non-pkg path
// (`npm test`, `npm run start`, `tsx index.ts`). The fix is to require
// BOTH signals before loosening, so the default-deny posture holds in
// any context that isn't an explicit `NODE_ENV=development` dev run.
const isPkgBundle = (process as any).pkg != null;
const isExplicitDev = !isPkgBundle && process.env.NODE_ENV === "development";
const corsOrigins = [
  "tauri://localhost",
  "https://tauri.localhost",
  ...(isExplicitDev
    ? ["http://localhost:1420", "http://localhost:3456", "http://localhost:5173"]
    : []),
];
if (isExplicitDev) {
  console.warn("[security] CORS in DEV mode — localhost:1420/3456/5173 allowed. Production bundle stays strict.");
}
export function corsMiddleware() {
  return cors({ origin: corsOrigins });
}

/** Constant-time string compare. JS `===` short-circuits on the first
 *  byte mismatch — over enough samples a same-host attacker can time
 *  the response delta and recover the secret byte-by-byte. Always
 *  pad-to-equal-length before timingSafeEqual or it throws on length
 *  mismatch (and the length is a side-channel too). */
export function constantTimeStrEq(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  // Different lengths can never match — but compare *something* of the
  // same length first so we don't leak length via a fast-return.
  const max = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(max);
  const bPad = Buffer.alloc(max);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const equal = timingSafeEqual(aPad, bPad);
  return equal && aBuf.length === bBuf.length;
}

// Auth middleware — credentials come from Keychain (loaded once at boot).
// Reject if either side is empty so a request arriving during the boot
// window (before loadConfig() has populated cachedConfig) can't slip
// through with empty-string === empty-string.
export const auth = basicAuth({
  verifyUser: (username, password) => {
    const config = getConfig();
    const expectedUser = config.appApiKey || env.APP_API_KEY;
    const expectedPass = config.appApiSecret || env.APP_API_SECRET;
    if (!expectedUser || !expectedPass) return false;
    // Constant-time compare on BOTH fields — `&&` would short-circuit
    // on the username mismatch and skip the password compare, which
    // both leaks "wrong username" via timing and is a byte-level oracle.
    const userOk = constantTimeStrEq(username, expectedUser);
    const passOk = constantTimeStrEq(password, expectedPass);
    return userOk && passOk;
  },
});

// SSE token — EventSource can't send Authorization headers, so SSE routes
// authenticate via a query-string token instead. Generated once at boot,
// minted via an auth-gated endpoint so any local process that doesn't
// already have basicAuth creds can't hit the streaming endpoints.
export const SSE_TOKEN = randomBytes(32).toString("hex");

export const sseAuth = async (c: any, next: any) => {
  const provided = c.req.query("token") ?? "";
  if (!constantTimeStrEq(provided, SSE_TOKEN)) {
    return c.text("Unauthorized", 401);
  }
  await next();
};

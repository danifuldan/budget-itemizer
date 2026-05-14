import { invoke } from "@tauri-apps/api/core";
import type { SSEEvent } from "./types";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: string, public readonly retryAfterSeconds: number | null) {
    super(`API ${status}: ${body}`);
    this.name = "ApiError";
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  // HTTP-date form
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
  }
  return null;
}

const DEFAULT_PORT = 3456;

// Resolved synchronously after initApiBase() completes at startup
let API_BASE = `http://localhost:${DEFAULT_PORT}`;

/** Signaled when initApiBase couldn't get a port + creds within the
 *  timeout. The splash screen reads this to render a recoverable error
 *  ("Sidecar didn't start. Quit and relaunch the app.") rather than
 *  let the wizard mount against a broken backend and 401-loop. */
export let initFailure: { reason: string } | null = null;

// Called once from main.tsx before React mounts. Polls both Tauri IPC
// state slots — the sidecar prints SERVER_PORT + APP_API_KEY/SECRET on
// stdout in that order, and Rust populates the slots as lines arrive.
// Both must be present before the FE makes any authenticated request,
// or every first call would 401 on a startup race. ~5s upper bound so
// a real sidecar failure surfaces as a UI error instead of a hang.
export async function initApiBase(): Promise<void> {
  // In a plain browser (Vite dev, Playwright), Tauri's runtime isn't injected
  // into window. The dynamic import below still resolves because the JS lives
  // in node_modules — but calling invoke() rejects with no Tauri host. That
  // rejection used to leak as an unhandled promise in main.tsx and prevent
  // React from mounting at all. Detect plain-browser context first and let
  // the env-var bootstrap in loadAuthFromTauri() take over.
  const hasTauri =
    typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
  if (!hasTauri) return;

  const start = Date.now();
  const TIMEOUT_MS = 5000;
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      const port: number | null = await invoke("get_server_port");
      const creds = (await invoke("get_app_credentials")) as AppCredentials | null;
      if (port && creds?.username && creds?.password) {
        API_BASE = `http://localhost:${port}`;
        authHeader = "Basic " + btoa(`${creds.username}:${creds.password}`);
        authLoaded = true;
        return;
      }
    } catch {
      // Sidecar still booting or IPC misbehaved — retry until timeout.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Sidecar didn't deliver creds + port. Surfacing as a hard init
  // failure prevents the wizard from mounting against empty auth
  // and generating 401 storms. The splash reads `initFailure` and
  // renders a recoverable error message.
  initFailure = {
    reason: "Local server didn't start. Quit the app and relaunch.",
  };
}

// Auth credentials — loaded from the Tauri shell via IPC. The sidecar
// prints them on stdout at boot and Tauri stashes them in process memory;
// we read them across the in-process IPC bridge rather than over HTTP.
// This way the credentials never travel a wire that anything outside the
// webview-and-shell pair could read.
let authHeader = "";
let authLoaded = false;
let authPromise: Promise<string> | null = null;

interface AppCredentials {
  username: string | null;
  password: string | null;
}

async function loadAuthFromTauri(): Promise<string> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    try {
      const creds = await invoke<AppCredentials>("get_app_credentials");
      if (creds?.username && creds?.password) {
        const header = "Basic " + btoa(`${creds.username}:${creds.password}`);
        authHeader = header;
        authLoaded = true;
        return header;
      }
    } catch {
      // IPC misbehaved — fall through to env-var bootstrap.
    }
  }
  // Dev-mode fallback: the dev server uses APP_API_KEY/APP_API_SECRET env
  // vars. Inject via Vite's import.meta.env (define VITE_APP_API_KEY +
  // VITE_APP_API_SECRET in .env.local for `npm run dev:frontend`).
  const devUser = (import.meta as any).env?.VITE_APP_API_KEY;
  const devPass = (import.meta as any).env?.VITE_APP_API_SECRET;
  if (devUser && devPass) {
    const header = "Basic " + btoa(`${devUser}:${devPass}`);
    authHeader = header;
    authLoaded = true;
    return header;
  }
  return "";
}

async function ensureAuth(): Promise<string> {
  if (authLoaded) return authHeader;
  if (!authPromise) {
    authPromise = loadAuthFromTauri().finally(() => {
      authPromise = null;
    });
  }
  return authPromise;
}

function refreshAuth(): Promise<string> {
  authLoaded = false;
  // Don't null authPromise — concurrent 401 handlers must share the same
  // in-flight /setup/status fetch instead of destroying each other's.
  return ensureAuth();
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const auth = await ensureAuth();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: auth,
      ...options?.headers,
    },
  });
  // Retry once on 401 — cached auth may be stale
  if (res.status === 401) {
    const freshAuth = await refreshAuth();
    const retry = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: freshAuth,
        ...options?.headers,
      },
    });
    if (!retry.ok) {
      const body = await retry.text();
      throw new ApiError(retry.status, body, parseRetryAfter(retry.headers.get("Retry-After")));
    }
    return retry.json();
  }
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body, parseRetryAfter(res.headers.get("Retry-After")));
  }
  return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: "DELETE" });
}

/**
 * Read a `Response` body as a series of SSE events.
 *
 * Honors both lines: `event:` sets the dispatch label, `data:` carries the
 * JSON payload. Without the event label, callers have to infer event type
 * from payload shape — which is what caused the silent error-drop bug in
 * the model-download flow before this was extracted.
 */
async function readSSEStream(
  res: Response,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // Payloads emitted without a preceding `event:` line are
        // dispatched as "message" — matches the EventSource default.
        const eventName = currentEvent || "message";
        try {
          const data = JSON.parse(line.slice(5).trim());
          onEvent(eventName, data);
        } catch {
          // Skip malformed payloads silently — usually keep-alive pings.
        }
        currentEvent = "";
      }
    }
  }
}

/**
 * Drop the file into the watcher inbox without entering the review flow.
 * Used when the LLM isn't warmed up yet — the watcher's queueFile waits
 * for llama-server, then parses, then the pending list updates. From the
 * user's POV: file appears in the pending list right away, marked as
 * "Loading AI model" while waiting, then transitions to ready normally.
 */
export async function uploadToInbox(file: File): Promise<void> {
  const auth = await ensureAuth();
  const form = new FormData();
  form.append("file", file);
  let res = await fetch(`${API_BASE}/watcher/inbox`, {
    method: "POST",
    headers: { Authorization: auth },
    body: form,
  });
  if (res.status === 401) {
    const freshAuth = await refreshAuth();
    const retry = new FormData();
    retry.append("file", file);
    res = await fetch(`${API_BASE}/watcher/inbox`, {
      method: "POST",
      headers: { Authorization: freshAuth },
      body: retry,
    });
  }
  if (!res.ok) {
    const body = await res.text();
    throw new ApiError(res.status, body, parseRetryAfter(res.headers.get("Retry-After")));
  }
}

export function streamParse(
  file: File,
  onEvent: (event: SSEEvent) => void,
  onError: (error: Error) => void
): AbortController {
  const controller = new AbortController();

  const form = new FormData();
  form.append("file", file);

  ensureAuth().then((auth) => {
    fetch(`${API_BASE}/parse-image/stream`, {
      method: "POST",
      headers: { Authorization: auth },
      body: form,
      signal: controller.signal,
    })
      .then(async (res) => {
        // Retry once on 401 — cached auth may be stale.
        if (res.status === 401) {
          const freshAuth = await refreshAuth();
          const retryForm = new FormData();
          retryForm.append("file", file);
          res = await fetch(`${API_BASE}/parse-image/stream`, {
            method: "POST",
            headers: { Authorization: freshAuth },
            body: retryForm,
            signal: controller.signal,
          });
        }
        if (!res.ok) {
          const body = await res.text();
          onError(new Error(`API ${res.status}: ${body}`));
          return;
        }
        await readSSEStream(res, (event, data) => {
          onEvent({ event, data } as SSEEvent);
        });
      })
      .catch((err) => {
        if (err.name !== "AbortError") onError(err);
      });
  });

  return controller;
}

/**
 * POST a JSON body and stream the SSE response. Mirrors `streamParse` but
 * for endpoints (like /models/download) that accept JSON instead of multipart.
 *
 * `onEvent` receives the dispatch label and parsed payload — explicit event
 * names beat shape-sniffing in the data payload (see readSSEStream comment).
 */
export async function streamSSEPost(
  path: string,
  body: unknown,
  onEvent: (event: string, data: any) => void,
  onError: (error: Error) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const auth = await ensureAuth();
    let res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 401) {
      const freshAuth = await refreshAuth();
      res = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: { Authorization: freshAuth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    }
    if (!res.ok) {
      const text = await res.text();
      onError(new ApiError(res.status, text, parseRetryAfter(res.headers.get("Retry-After"))));
      return;
    }
    await readSSEStream(res, onEvent);
  } catch (err: any) {
    if (err?.name !== "AbortError") onError(err);
  }
}

// Export for use in components that need raw auth (e.g., wizard)
export { ensureAuth, API_BASE };

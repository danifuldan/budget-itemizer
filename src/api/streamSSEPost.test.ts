// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Build a fake `Response` whose body streams the given SSE bytes, chunk by
 * chunk. Real-network response bodies arrive in pieces, and the parser
 * has to handle line splits across chunks; using multiple chunks here
 * keeps the test honest.
 */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Route fetch by URL pattern. Avoids relying on call order — the auth
 * bootstrap caches across tests at the module level, so a per-call mock
 * gets out of sync after the first test.
 */
function routedFetch(routes: Record<string, () => Response | Promise<Response>>) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) return Promise.resolve(handler());
    }
    return Promise.reject(new Error(`Unmocked fetch: ${url}`));
  });
}

const authResponse = () =>
  new Response(JSON.stringify({ auth: { username: "u", password: "p" } }), { status: 200 });

describe("streamSSEPost", () => {
  let streamSSEPost: typeof import("./client").streamSSEPost;
  let ApiError: typeof import("./client").ApiError;

  beforeEach(async () => {
    // Reset the module so the auth cache doesn't carry between tests.
    vi.resetModules();
    const mod = await import("./client");
    streamSSEPost = mod.streamSSEPost;
    ApiError = mod.ApiError;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches events on the explicit `event:` name", async () => {
    vi.stubGlobal("fetch", routedFetch({
      "/setup/status": authResponse,
      "/models/download": () => sseResponse([
        "event: progress\n",
        "data: {\"percent\":42}\n\n",
        "event: progress\n",
        "data: {\"done\":true}\n\n",
      ]),
    }));

    const events: Array<[string, any]> = [];
    await streamSSEPost("/models/download", { modelId: "x" },
      (event, data) => events.push([event, data]),
      () => { throw new Error("onError should not fire on a 200 stream"); },
    );

    expect(events).toEqual([
      ["progress", { percent: 42 }],
      ["progress", { done: true }],
    ]);
  });

  // Regression: the OLD download flow sniffed the data payload for
  // `.error` instead of dispatching on the `event:` line, so a real
  // `event: error` write from the backend would silently land as if it
  // were a progress event. Now consumers all route through readSSEStream
  // and errors are explicit.
  it("dispatches `event: error` payloads under the error event name", async () => {
    vi.stubGlobal("fetch", routedFetch({
      "/setup/status": authResponse,
      "/models/download": () => sseResponse([
        "event: progress\n",
        "data: {\"percent\":15}\n\n",
        "event: error\n",
        "data: {\"error\":\"disk full\"}\n\n",
      ]),
    }));

    const events: Array<[string, any]> = [];
    await streamSSEPost("/models/download", {},
      (event, data) => events.push([event, data]),
      () => {},
    );

    const errEvent = events.find(([name]) => name === "error");
    expect(errEvent?.[1]).toEqual({ error: "disk full" });
  });

  it("calls onError with ApiError on a non-2xx response", async () => {
    vi.stubGlobal("fetch", routedFetch({
      "/setup/status": authResponse,
      "/models/download": () => new Response("nope", { status: 500 }),
    }));

    let captured: Error | null = null;
    await streamSSEPost("/models/download", {},
      () => {},
      (err) => { captured = err; },
    );

    expect(captured).toBeInstanceOf(ApiError);
    expect((captured as unknown as InstanceType<typeof ApiError>).status).toBe(500);
  });

  it("does not call onError when the stream is aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    vi.stubGlobal("fetch", routedFetch({
      "/setup/status": authResponse,
      "/models/download": () => {
        const err: any = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    }));

    let errored = false;
    await streamSSEPost("/models/download", {},
      () => {},
      () => { errored = true; },
      ctrl.signal,
    );

    // Abort is a user-initiated stop; surfacing it as an error would
    // make the UI show a fake error every time the user clicks Pause.
    expect(errored).toBe(false);
  });
});

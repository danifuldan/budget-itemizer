// Regression tests for two model-manager bugs:
//
// 1) Concurrent `downloadModel` calls for the same modelId raced on the
//    `.partial` file — both attempts opened write streams against the
//    same path, interleaving bytes and corrupting the GGUF. The fix
//    coalesces same-modelId callers onto a single in-flight promise.
//
// 2) The retry loop accepted a stream that ended before the promised
//    content-length arrived, then renamed the short file as the final
//    model. The fix verifies `downloaded === total` per attempt and
//    re-checks the partial size before the final rename.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsReal from "fs";
import * as osReal from "os";
import * as path from "path";

const tempHomeRef = vi.hoisted(() => ({ current: "" }));

vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    homedir: () => tempHomeRef.current,
    default: { ...actual, homedir: () => tempHomeRef.current },
  };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

/** Build a Response-shaped object whose body streams `chunks` and whose
 *  Content-Length header equals the sum of chunk sizes. */
const mockResponse = (chunks: Uint8Array[]) => {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  return {
    status: 200,
    ok: true,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-length" ? String(total) : null,
    },
    body: {
      getReader: () => {
        let i = 0;
        return {
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
        };
      },
    },
  };
};

/** Build a 206 partial-content response that lies: claims `total` bytes
 *  via Content-Length but only delivers `chunks` (which sum to less). */
const mockShortResponse = (chunks: Uint8Array[], lyingTotal: number) => ({
  status: 200,
  ok: true,
  headers: {
    get: (k: string) =>
      k.toLowerCase() === "content-length" ? String(lyingTotal) : null,
  },
  body: {
    getReader: () => {
      let i = 0;
      return {
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[i++] };
        },
      };
    },
  },
});

const mockResumeResponse = (chunks: Uint8Array[]) => {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  return {
    status: 206,
    ok: false, // 206 isn't 2xx-ok in fetch's view
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-length" ? String(total) : null,
    },
    body: {
      getReader: () => {
        let i = 0;
        return {
          read: async () => {
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[i++] };
          },
        };
      },
    },
  };
};

describe("downloadModel", () => {
  beforeEach(() => {
    tempHomeRef.current = fsReal.mkdtempSync(
      path.join(osReal.tmpdir(), "model-manager-test-"),
    );
    vi.resetModules();
    fetchMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    fsReal.rmSync(tempHomeRef.current, { recursive: true, force: true });
  });

  it("coalesces two concurrent calls for the same model into one fetch", async () => {
    const mod = await import("./model-manager");
    const target = mod.AVAILABLE_MODELS.find((m) => m.id === "llama3.1-8b")!;
    // Drop the SHA-256 pin so the tiny mocked payload doesn't fail integrity check.
    delete (target as { sha256?: string }).sha256;
    // Serve a tiny placeholder body so the test runs fast. We replace
    // the model's sizeBytes via the mocked content-length only.
    const payload = new Uint8Array(64).fill(7);
    fetchMock.mockResolvedValue(mockResponse([payload]));

    const onProgress = vi.fn();
    const [a, b] = await Promise.all([
      mod.downloadModel(target.id, onProgress),
      mod.downloadModel(target.id, onProgress),
    ]);

    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    // The critical assertion: only ONE network round-trip happened.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const finalPath = path.join(
      tempHomeRef.current,
      ".config",
      "budget-itemizer",
      "models",
      target.filename,
    );
    expect(fsReal.existsSync(finalPath)).toBe(true);
    expect(fsReal.statSync(finalPath).size).toBe(payload.byteLength);
  });

  // Regression: pre-fix, the second caller's onProgress was never wired
  // into the in-flight download. Their SSE response stayed silent — no
  // progress events, no terminal `done: true` — and the FE sat at 0%
  // forever. Fan-out invokes every subscribed callback on each tick.
  it("both concurrent callers' onProgress callbacks receive the terminal done event", async () => {
    const mod = await import("./model-manager");
    const target = mod.AVAILABLE_MODELS.find((m) => m.id === "llama3.1-8b")!;
    // Drop the SHA-256 pin so the tiny mocked payload doesn't fail integrity check.
    delete (target as { sha256?: string }).sha256;
    const payload = new Uint8Array(64).fill(7);
    fetchMock.mockResolvedValue(mockResponse([payload]));

    const onProgressA = vi.fn();
    const onProgressB = vi.fn();
    await Promise.all([
      mod.downloadModel(target.id, onProgressA),
      mod.downloadModel(target.id, onProgressB),
    ]);

    // Both callbacks saw the terminal done:true event with percent: 100.
    expect(onProgressA).toHaveBeenCalledWith(
      expect.objectContaining({ done: true, percent: 100 }),
    );
    expect(onProgressB).toHaveBeenCalledWith(
      expect.objectContaining({ done: true, percent: 100 }),
    );
  });

  it("retries when the stream closes before the promised bytes arrive (premature close)", async () => {
    const mod = await import("./model-manager");
    const target = mod.AVAILABLE_MODELS.find((m) => m.id === "llama3.1-8b")!;
    // Drop the SHA-256 pin so the tiny mocked payload doesn't fail integrity check.
    delete (target as { sha256?: string }).sha256;

    const fullPayload = new Uint8Array(128).fill(3);
    const firstHalf = fullPayload.slice(0, 60);
    const secondHalf = fullPayload.slice(60);

    // Attempt 1: server promises 128 bytes (Content-Length) but only
    // delivers 60. The old code accepted this; the new code should
    // detect downloaded !== total and retry.
    fetchMock.mockResolvedValueOnce(mockShortResponse([firstHalf], 128));
    // Attempt 2 (Range request from byte 60): serve the remaining 68
    // as a 206 response with content-length 68.
    fetchMock.mockResolvedValueOnce(mockResumeResponse([secondHalf]));

    const onProgress = vi.fn();
    await mod.downloadModel(target.id, onProgress);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second call sent a Range header starting from where the
    // first attempt left off.
    const secondCallHeaders = (fetchMock.mock.calls[1] as any)[1].headers;
    expect(secondCallHeaders.Range).toBe("bytes=60-");

    const finalPath = path.join(
      tempHomeRef.current,
      ".config",
      "budget-itemizer",
      "models",
      target.filename,
    );
    expect(fsReal.existsSync(finalPath)).toBe(true);
    expect(fsReal.statSync(finalPath).size).toBe(128);
  });

  it("cancel during a retry backoff returns immediately instead of waiting out the sleep", async () => {
    // After a failed attempt the loop sleeps before retrying; the sleep
    // grows exponentially up to 30s. Pre-fix, the sleep ignored the
    // abort signal — so a Cancel click during a 30s backoff would take
    // up to 30s to actually stop. Now we race the sleep against abort
    // and return immediately when cancelled.
    const mod = await import("./model-manager");
    const target = mod.AVAILABLE_MODELS.find((m) => m.id === "llama3.1-8b")!;
    // Drop the SHA-256 pin so the tiny mocked payload doesn't fail integrity check.
    delete (target as { sha256?: string }).sha256;

    // Attempt 1 returns a short body so the loop schedules a retry.
    // After this, downloadModel enters a 1000ms backoff sleep.
    const shortChunk = new Uint8Array(50).fill(1);
    fetchMock.mockResolvedValueOnce(mockShortResponse([shortChunk], 128));

    const onProgress = vi.fn();
    const start = Date.now();
    // Cancel ~100ms into the 1000ms backoff. Without the fix, the
    // sleep runs the full 1000ms and only the next downloadAttempt
    // observes the abort.
    setTimeout(() => mod.cancelDownload(), 100);

    await mod.downloadModel(target.id, onProgress);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ error: "cancelled" }),
    );
    // Only one network call — the second attempt never started because
    // we cancelled mid-backoff.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects and deletes the partial when downloads can't reach the expected size", async () => {
    const mod = await import("./model-manager");
    const target = mod.AVAILABLE_MODELS.find((m) => m.id === "llama3.1-8b")!;
    // Drop the SHA-256 pin so the tiny mocked payload doesn't fail integrity check.
    delete (target as { sha256?: string }).sha256;

    // Every attempt promises 128 bytes but always serves only 50 — and
    // never advances past byte 50 because the server keeps "resetting".
    // (In practice this models a CDN edge that always cuts the stream
    // at the same byte. The retry loop should give up via the
    // no-progress streak.)
    const stubChunk = new Uint8Array(50).fill(9);
    fetchMock.mockImplementation((_url: any, init: any) => {
      const range = init?.headers?.Range as string | undefined;
      if (!range) {
        // First call — write 50 bytes against an empty file.
        return Promise.resolve(mockShortResponse([stubChunk], 128));
      }
      // Resume calls — server replies "Range Not Satisfiable" because
      // it doesn't actually have more bytes. (This is an edge case;
      // the more common path is mid-stream errors. We use 416 here to
      // exit the retry loop deterministically.)
      return Promise.resolve({
        status: 416,
        ok: false,
        headers: { get: () => null },
      });
    });

    const onProgress = vi.fn();
    // 416 makes downloadAttempt report complete:true with total:null,
    // so the loop exits "successfully" — and verification catches the
    // size mismatch before rename.
    await expect(
      mod.downloadModel(target.id, onProgress),
    ).rejects.toThrow(/verification failed/);

    const finalPath = path.join(
      tempHomeRef.current,
      ".config",
      "budget-itemizer",
      "models",
      target.filename,
    );
    const partialPath = finalPath + ".partial";
    expect(fsReal.existsSync(finalPath)).toBe(false);
    expect(fsReal.existsSync(partialPath)).toBe(false);
  });
});

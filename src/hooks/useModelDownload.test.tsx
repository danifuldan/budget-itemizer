// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useModelDownload } from "./useModelDownload";

vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  apiPost: vi.fn(),
  streamSSEPost: vi.fn(),
}));

import { apiFetch, apiPost, streamSSEPost } from "../api/client";
const mockApiFetch = vi.mocked(apiFetch);
const mockApiPost = vi.mocked(apiPost);
const mockStreamSSE = vi.mocked(streamSSEPost);

const flushPromises = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};

const installedModel = { id: "llama3.1-8b", name: "Llama 3.1 8B", size: "4.9 GB", downloaded: true };
const partialModel = { id: "llama3.1-8b", name: "Llama 3.1 8B", size: "4.9 GB", downloaded: false };

describe("useModelDownload", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiPost.mockReset();
    mockStreamSSE.mockReset();
  });

  it("fetches /models/available on mount and seeds installed", async () => {
    mockApiFetch.mockResolvedValueOnce([installedModel]);
    const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b" }));
    await flushPromises();
    expect(mockApiFetch).toHaveBeenCalledWith("/models/available");
    expect(result.current.installed).toBe(true);
  });

  // Regression: wizard previously seeded `downloadDone = true` whenever the
  // file was on disk, ignoring `config.embeddedModel`. If a user had a
  // half-configured state (model on disk but config pointed elsewhere),
  // Next was wrongly enabled. Hook gates on both.
  it("seeds done=true only when installed AND embeddedModelInConfig matches", async () => {
    mockApiFetch.mockResolvedValueOnce([installedModel]);
    const { result } = renderHook(() => useModelDownload({
      modelId: "llama3.1-8b",
      embeddedModelInConfig: "some-other-model",
    }));
    await flushPromises();
    expect(result.current.installed).toBe(true);
    expect(result.current.state.done).toBe(false);
  });

  it("seeds done=true when installed and no embeddedModelInConfig supplied (settings case)", async () => {
    mockApiFetch.mockResolvedValueOnce([installedModel]);
    const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b" }));
    await flushPromises();
    expect(result.current.state.done).toBe(true);
  });

  it("start() invokes streamSSEPost with the right path and modelId", async () => {
    mockApiFetch.mockResolvedValueOnce([partialModel]);
    mockStreamSSE.mockImplementationOnce(async () => {});
    const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b" }));
    await flushPromises();
    await act(async () => { await result.current.start(); });
    expect(mockStreamSSE).toHaveBeenCalled();
    const [path, body] = mockStreamSSE.mock.calls[0];
    expect(path).toBe("/models/download");
    expect(body).toEqual({ modelId: "llama3.1-8b" });
  });

  it("SSE progress events update percent", async () => {
    mockApiFetch.mockResolvedValueOnce([partialModel]);
    let captureOnEvent: ((event: string, data: any) => void) | null = null;
    // Never resolve so `downloading` stays true while events fire — mirrors
    // a real long-running SSE stream.
    mockStreamSSE.mockImplementationOnce(async (_path, _body, onEvent) => {
      captureOnEvent = onEvent;
      await new Promise(() => {});
    });
    const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b" }));
    await flushPromises();
    await act(async () => { void result.current.start(); await Promise.resolve(); });

    await act(async () => { captureOnEvent!("progress", { percent: 42 }); });
    expect(result.current.state.percent).toBe(42);
    expect(result.current.primaryLabel).toMatch(/Pause download \(42%\)/);
  });

  it("SSE done event activates the model and invokes onActivated, then flips done=true", async () => {
    mockApiFetch.mockResolvedValueOnce([partialModel]);
    mockApiPost.mockResolvedValueOnce({}); // activate
    const onActivated = vi.fn().mockResolvedValue(undefined);
    let captureOnEvent: ((event: string, data: any) => void) | null = null;
    mockStreamSSE.mockImplementationOnce(async (_path, _body, onEvent) => {
      captureOnEvent = onEvent;
      await new Promise(() => {});
    });
    const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b", onActivated }));
    await flushPromises();
    await act(async () => { void result.current.start(); await Promise.resolve(); });

    await act(async () => { captureOnEvent!("progress", { percent: 100, done: true }); });
    await flushPromises();

    expect(mockApiPost).toHaveBeenCalledWith("/models/activate", { modelId: "llama3.1-8b" });
    expect(onActivated).toHaveBeenCalled();
    expect(result.current.state.done).toBe(true);
    expect(result.current.installed).toBe(true);
  });

  // Regression: previously the wizard set `downloadDone = true` even when
  // the activate POST failed, leaving Next enabled against a broken
  // backend. The hook keeps done=false unless every post-download step
  // succeeded.
  it("activate failure populates error and keeps done=false", async () => {
    mockApiFetch.mockResolvedValueOnce([partialModel]);
    mockApiPost.mockRejectedValueOnce(new Error("activate boom")); // activate fails
    let captureOnEvent: ((event: string, data: any) => void) | null = null;
    mockStreamSSE.mockImplementationOnce(async (_path, _body, onEvent) => {
      captureOnEvent = onEvent;
      await new Promise(() => {});
    });
    const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b" }));
    await flushPromises();
    await act(async () => { void result.current.start(); await Promise.resolve(); });

    await act(async () => { captureOnEvent!("progress", { percent: 100, done: true }); });
    await flushPromises();

    expect(result.current.state.done).toBe(false);
    expect(result.current.state.error).toMatch(/failed to activate/);
  });

  it("onActivated failure populates error and keeps done=false", async () => {
    mockApiFetch.mockResolvedValueOnce([partialModel]);
    mockApiPost.mockResolvedValueOnce({}); // activate ok
    const onActivated = vi.fn().mockRejectedValue(new Error("save boom"));
    let captureOnEvent: ((event: string, data: any) => void) | null = null;
    mockStreamSSE.mockImplementationOnce(async (_path, _body, onEvent) => {
      captureOnEvent = onEvent;
      await new Promise(() => {});
    });
    const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b", onActivated }));
    await flushPromises();
    await act(async () => { void result.current.start(); await Promise.resolve(); });

    await act(async () => { captureOnEvent!("progress", { percent: 100, done: true }); });
    await flushPromises();

    expect(result.current.state.done).toBe(false);
    expect(result.current.state.error).toMatch(/failed to save settings/);
  });

  it("pause() aborts in-flight reader and POSTs /models/cancel-download", async () => {
    mockApiFetch.mockResolvedValueOnce([partialModel]);
    mockApiPost.mockResolvedValueOnce({});
    mockStreamSSE.mockImplementationOnce(async () => {});
    const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b" }));
    await flushPromises();
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.pause(); });
    expect(mockApiPost).toHaveBeenCalledWith("/models/cancel-download", {});
  });

  // Regression: settings used `percent > 0` for isResuming (over-counted —
  // a freshly-completed install would meet the criterion). Wizard used
  // `percent > 0 && !done`. Hook adopts wizard's safer form. This pins
  // resume-keeps-percent so a future "simplification" doesn't regress.
  it("pause then start preserves percent (resume semantics)", async () => {
    mockApiFetch.mockResolvedValueOnce([partialModel]);
    let captureOnEvent: ((event: string, data: any) => void) | null = null;
    // First call: capture events, abort path resolves when signal fires.
    let firstAbortSignal: AbortSignal | undefined;
    mockStreamSSE.mockImplementationOnce(async (_path, _body, onEvent, _onError, signal) => {
      captureOnEvent = onEvent;
      firstAbortSignal = signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve());
      });
    });
    // Second call (resume): also never resolve.
    mockStreamSSE.mockImplementationOnce(async (_path, _body, onEvent) => {
      captureOnEvent = onEvent;
      await new Promise(() => {});
    });
    mockApiPost.mockResolvedValue({});

    const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b" }));
    await flushPromises();

    await act(async () => { void result.current.start(); await Promise.resolve(); });
    await act(async () => { captureOnEvent!("progress", { percent: 35 }); });
    expect(result.current.state.percent).toBe(35);

    await act(async () => { await result.current.pause(); });
    // Drain start()'s tail so its setDownloading(false) lands.
    await flushPromises();
    expect(firstAbortSignal?.aborted).toBe(true);
    expect(result.current.isPaused).toBe(true);
    expect(result.current.state.percent).toBe(35);

    // Resume — percent must NOT reset to 0 before the next event lands.
    await act(async () => { void result.current.start(); await Promise.resolve(); });
    expect(result.current.state.percent).toBe(35);
  });

  it("requestDelete() pauses an in-flight download before opening the dialog", async () => {
    mockApiFetch.mockResolvedValueOnce([partialModel]);
    mockApiPost.mockResolvedValue({});
    mockStreamSSE.mockImplementationOnce(async () => {
      await new Promise(() => {});
    });
    const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b" }));
    await flushPromises();

    // Start so `downloading = true`.
    await act(async () => { void result.current.start(); await Promise.resolve(); });
    expect(result.current.state.downloading).toBe(true);

    await act(async () => { result.current.requestDelete(); await Promise.resolve(); });

    expect(result.current.state.confirmDeleteOpen).toBe(true);
    expect(mockApiPost).toHaveBeenCalledWith("/models/cancel-download", {});
  });

  it("performDelete() resets state and invokes onDeleted", async () => {
    mockApiFetch.mockResolvedValueOnce([installedModel]);
    mockApiPost.mockResolvedValue({});
    const onDeleted = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b", onDeleted }));
    await flushPromises();

    await act(async () => { await result.current.performDelete(); });

    expect(mockApiPost).toHaveBeenCalledWith("/models/delete", { modelId: "llama3.1-8b" });
    expect(result.current.installed).toBe(false);
    expect(result.current.state.done).toBe(false);
    expect(result.current.state.percent).toBe(0);
    expect(onDeleted).toHaveBeenCalled();
  });

  // e2e download-delete.spec.ts asserts /Delete the model\?/ visible in the
  // dialog. Pin all three branches here so a string edit can't break e2e
  // without a unit signal.
  it("deleteConfirmMessage returns correct 1-of-3 string by state", async () => {
    // Branch 1: downloading
    {
      mockApiFetch.mockResolvedValueOnce([partialModel]);
      mockStreamSSE.mockImplementationOnce(async () => { await new Promise(() => {}); });
      const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b" }));
      await flushPromises();
      await act(async () => { void result.current.start(); await Promise.resolve(); });
      // While downloading=true:
      expect(result.current.state.downloading).toBe(true);
      expect(result.current.deleteConfirmMessage).toMatch(/Delete the partial download\? You'll lose your progress/);
    }
    // Branch 2: installed (and not downloading)
    {
      mockApiFetch.mockResolvedValueOnce([installedModel]);
      const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b" }));
      await flushPromises();
      expect(result.current.deleteConfirmMessage).toMatch(/Delete the model\?/);
    }
    // Branch 3: neither downloading nor installed (paused/partial)
    {
      mockApiFetch.mockResolvedValueOnce([partialModel]);
      const { result } = renderHook(() => useModelDownload({ modelId: "llama3.1-8b" }));
      await flushPromises();
      expect(result.current.deleteConfirmMessage).toMatch(/Delete the partial download\? You'll start over/);
    }
  });
});

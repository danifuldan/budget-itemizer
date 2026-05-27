/**
 * Lock-down: skipFile must NOT silently swallow non-409 DELETE failures.
 *
 * The bug (premortem 2026-05-19 Bug 2): when the server's
 * disposeSourceFile fails (perms, processed parent vanished, no
 * processed folder configured), the DELETE response is 500/422 — but
 * the FE only refetched on 409. On any other error it logged a warning
 * and left the optimistic remove in place. Next server poll → the entry
 * resurrects in the pending list with no explanation.
 *
 * Fix: any non-409 failure refetches (rolls back the optimistic remove)
 * and surfaces a notification with the server-provided reason. These
 * tests assert the disagreement — pre-fix fetchPending is NOT called
 * and sendNotification is NOT called on a 500; post-fix both fire.
 */
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { apiFetch, sendNotification } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, apiFetch: (...a: unknown[]) => apiFetch(...a) };
});
vi.mock("./useWatcherNotifications", () => ({
  sendNotification: (...a: unknown[]) => sendNotification(...a),
}));

import { usePendingFiles } from "./usePendingFiles";
import { ApiError } from "../api/client";

const harness = (pendingState: unknown[] = []) => {
  const setPendingFiles = vi.fn();
  const removePendingLocal = vi.fn();
  const pruneStaleBuffers = vi.fn();
  // First call (after the error) returns the server's view of what's still
  // pending. The hook calls apiFetch with the GET URL during fetchPending.
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") throw new Error("(set per-test)");
    return pendingState;
  });
  return { setPendingFiles, removePendingLocal, pruneStaleBuffers };
};

beforeEach(() => {
  apiFetch.mockReset();
  sendNotification.mockReset();
});

describe("usePendingFiles.skipFile error handling", () => {
  it("on 422 (no processed folder): refetches AND surfaces the server's reason via notification", async () => {
    const { setPendingFiles, removePendingLocal, pruneStaleBuffers } = harness([
      { filename: "foo.pdf" },
    ]);
    // DELETE throws a 422 with a structured error body.
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        throw new ApiError(
          422,
          JSON.stringify({ error: "Set a Processed folder in Settings ..." }),
          null,
        );
      }
      return [{ filename: "foo.pdf" }]; // server still has it
    });

    const { result } = renderHook(() =>
      usePendingFiles(setPendingFiles, removePendingLocal, pruneStaleBuffers),
    );

    await act(async () => { await result.current.skipFile("foo.pdf"); });

    // The disagreement: pre-fix, neither of these would fire on a 422
    // (the catch only handled 409). The ghost-resurrect path was the
    // user's only signal that something went wrong.
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledWith(
      "Couldn't discard receipt",
      "Set a Processed folder in Settings ...",
    );
    // refetch fired → setPendingFiles called with the server's pending list
    expect(setPendingFiles).toHaveBeenCalledWith([{ filename: "foo.pdf" }]);
  });

  it("on 500 (dispose failed): refetches AND surfaces the reason", async () => {
    const { setPendingFiles, removePendingLocal, pruneStaleBuffers } = harness([
      { filename: "bar.pdf" },
    ]);
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        throw new ApiError(
          500,
          JSON.stringify({ error: "Could not move the file out of the inbox" }),
          null,
        );
      }
      return [{ filename: "bar.pdf" }];
    });

    const { result } = renderHook(() =>
      usePendingFiles(setPendingFiles, removePendingLocal, pruneStaleBuffers),
    );

    await act(async () => { await result.current.skipFile("bar.pdf"); });

    expect(sendNotification).toHaveBeenCalledWith(
      "Couldn't discard receipt",
      "Could not move the file out of the inbox",
    );
    expect(setPendingFiles).toHaveBeenCalled();
  });

  it("on 409 (concurrent re-upload): refetches WITHOUT a notification — already handled", async () => {
    const { setPendingFiles, removePendingLocal, pruneStaleBuffers } = harness([
      { filename: "baz.pdf" },
    ]);
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        throw new ApiError(409, JSON.stringify({ error: "re-uploaded" }), null);
      }
      return [{ filename: "baz.pdf" }];
    });

    const { result } = renderHook(() =>
      usePendingFiles(setPendingFiles, removePendingLocal, pruneStaleBuffers),
    );

    await act(async () => { await result.current.skipFile("baz.pdf"); });

    // 409 is the known race case — refetch shows the newer entry, no
    // alarm needed (and pre-existing behavior).
    expect(setPendingFiles).toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

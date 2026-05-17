// F6 regression: a SIGKILL'd previous llama-server process can fire its
// 'exit' event LATE — after a new start has already set `instance` to the
// new process. The exit handler unconditionally did `instance = null`,
// nulling the NEW instance. isLlamaServerRunning() then lied (false while
// a healthy server was up), and the watcher wrongly errored every dropped
// receipt. The handler must only clear `instance` if it's still ITS own
// process.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";

// findBinary() / dylib probing walk the filesystem for the bundled
// binary, absent in tests — make every candidate "exist".
vi.mock("fs", async () => {
  const a = await vi.importActual<typeof import("fs")>("fs");
  return { ...a, existsSync: () => true, default: { ...a, existsSync: () => true } };
});

function fakeChild() {
  const c: any = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  c.pid = Math.floor(Math.random() * 100000) + 2;
  c.exitCode = null;
  c.signalCode = null;
  return c;
}

const children: any[] = [];
const spawn = vi.fn(() => {
  const c = fakeChild();
  children.push(c);
  return c;
});
vi.mock("child_process", () => ({
  spawn: (...a: any[]) => spawn(...a),
  execFileSync: vi.fn(),
}));

import {
  startLlamaServer,
  stopLlamaServer,
  isLlamaServerRunning,
} from "./llama-server";

describe("llama-server exit handler is instance-scoped (F6)", () => {
  beforeEach(() => {
    children.length = 0;
    spawn.mockClear();
    // pollHealth fetches /health until ok.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true }) as any));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a stale exit from a prior process does not null the current instance", async () => {
    await startLlamaServer("/models/A.gguf");
    expect(isLlamaServerRunning()).toBe(true);
    const childA = children[0];

    // Stop A: stopLlamaServer awaits A's 'exit'. Emit it so the stop
    // resolves and `instance` clears cleanly.
    const stopP = stopLlamaServer();
    childA.emit("exit", 0);
    await stopP;
    expect(isLlamaServerRunning()).toBe(false);

    // Start B (a new process becomes the live instance).
    await startLlamaServer("/models/B.gguf");
    expect(isLlamaServerRunning()).toBe(true);
    const childB = children[1];
    expect(childB).not.toBe(childA);

    // The OLD process A finally dies and its start-registered 'exit'
    // listener fires LATE — it must NOT clobber B.
    childA.emit("exit", 137);

    expect(isLlamaServerRunning()).toBe(true); // bug: false (B nulled)
  }, 10000);
});

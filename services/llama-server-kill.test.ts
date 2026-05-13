// Regression: killProcessOnPort used to blanket-kill every PID
// listening on the configured llama-server port range. The ranges
// (8921–8930, 8941–8950) are arbitrary; a developer running Postgres
// or Redis on those ports would have their service SIGTERMed on
// every sidecar boot. The fix validates each PID's command name via
// `ps -p <pid> -o comm=` before issuing kill.
import { describe, it, expect, vi, beforeEach } from "vitest";

// killProcessOnPort now uses execFileSync (argv form, no shell) instead
// of execSync (single shell string). The mock dispatches by argv[0]
// (file) and matches argv[1..] to decide what to return. Each mocked
// call returns the stdout the real binary would have produced.
const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFileSync: (...args: any[]) => execFileMock(...args),
}));

import { killProcessOnPort } from "./llama-server";

describe("killProcessOnPort", () => {
  beforeEach(() => {
    execFileMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  /** Convenience: assertion form for "the kill call's PID list". */
  const killedPids = () =>
    execFileMock.mock.calls
      .filter(([file]) => file === "kill")
      .flatMap(([, args]) => args as string[]);

  it("kills only PIDs whose command is llama-server, leaving unrelated processes alone", () => {
    execFileMock.mockImplementation((file: string, args: string[]) => {
      if (file === "lsof") return "1234\n5678\n";
      if (file === "ps" && args[1] === "1234") return "postgres\n";
      if (file === "ps" && args[1] === "5678") return "llama-server\n";
      if (file === "kill") return "";
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    killProcessOnPort(8921);

    expect(killedPids()).toEqual(["5678"]);
  });

  it("does not invoke kill when no PIDs match (all unrelated processes)", () => {
    execFileMock.mockImplementation((file: string, args: string[]) => {
      if (file === "lsof") return "1111\n";
      if (file === "ps" && args[1] === "1111") return "redis-server\n";
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    killProcessOnPort(8921);

    expect(killedPids()).toEqual([]);
  });

  it("skips a PID whose process exited between lsof and ps (PID reuse safety)", () => {
    execFileMock.mockImplementation((file: string, args: string[]) => {
      if (file === "lsof") return "9999\n7777\n";
      if (file === "ps" && args[1] === "9999") {
        // Process gone — ps -p exits non-zero
        const e: any = new Error("no such process");
        throw e;
      }
      if (file === "ps" && args[1] === "7777") return "llama-server\n";
      if (file === "kill") return "";
      throw new Error(`unexpected exec: ${file} ${args.join(" ")}`);
    });

    killProcessOnPort(8921);

    expect(killedPids()).toEqual(["7777"]);
  });

  it("returns silently when nothing is listening on the port", () => {
    execFileMock.mockImplementation((file: string) => {
      if (file === "lsof") {
        // lsof exits non-zero when nothing matches
        throw new Error("no matching process");
      }
      throw new Error(`unexpected exec: ${file}`);
    });

    expect(() => killProcessOnPort(8921)).not.toThrow();
    expect(killedPids()).toEqual([]);
  });
});

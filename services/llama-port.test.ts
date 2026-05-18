// Dev-isolation: the bundled llama-server binds a fixed PORT_BASE (8921)
// and its startup reclaims that port by killing whatever llama-server is
// on it — correct in production (kill your OWN orphaned instance after an
// unclean exit) but in dev it killed the user's running app's model when
// a smoke test spawned a second sidecar. Make the base env-overridable so
// the smoke runners can use a distinct range; production default is
// UNCHANGED (8921), so end users are unaffected.
import { describe, it, expect } from "vitest";
import { resolveLlamaPortBase } from "./llama-server";

describe("resolveLlamaPortBase", () => {
  it("defaults to 8921 when the env var is absent (production unchanged)", () => {
    expect(resolveLlamaPortBase({})).toBe(8921);
  });

  it("honors a valid override (smoke runners isolate here)", () => {
    expect(resolveLlamaPortBase({ BUDGET_ITEMIZER_LLAMA_PORT_BASE: "8931" })).toBe(8931);
  });

  it("falls back to 8921 for junk / out-of-range values (never a bad bind)", () => {
    for (const v of ["", "abc", "0", "-5", "70000", "89.5"]) {
      expect(resolveLlamaPortBase({ BUDGET_ITEMIZER_LLAMA_PORT_BASE: v })).toBe(8921);
    }
  });
});

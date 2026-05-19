import { readFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { APP_VERSION } from "./appVersion";

// The Settings footer shows APP_VERSION. If it can drift from the actual
// built version, the whole point (telling which build/update you're on)
// is lost — that exact ambiguity caused a confusing updater-test session.
// So pin it: APP_VERSION must equal the package.json the build was cut
// from. Read via fs (not import) to dodge tsconfig JSON/rootDir friction.
describe("APP_VERSION", () => {
  it("equals package.json version (cannot drift from the built version)", () => {
    const pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
    expect(APP_VERSION).toBe(pkgVersion);
  });

  it("is a non-empty semver-shaped string", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

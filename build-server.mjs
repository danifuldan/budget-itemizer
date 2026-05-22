// Build script: bundle the Hono server into a standalone macOS binary
// 1. esbuild bundles TypeScript → single CJS file
// 2. @yao-pkg/pkg compiles CJS → standalone Node binary

import { execFileSync } from "child_process";
import { mkdirSync, existsSync, createWriteStream, readFileSync, unlinkSync, readdirSync, copyFileSync, chmodSync, rmSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "src-tauri/binaries");

mkdirSync(outDir, { recursive: true });
mkdirSync(resolve(__dirname, "dist-server"), { recursive: true });

// Step 1: Bundle with esbuild
console.log("Bundling server with esbuild...");
execFileSync(
  "npx",
  [
    "esbuild",
    "index.ts",
    "--bundle",
    "--platform=node",
    "--target=node20",
    "--format=cjs",
    "--outfile=dist-server/server.cjs",
    // @actual-app/api ships as real node_modules in the .app (its native
    // better-sqlite3 .node can't live in the pkg snapshot). This define
    // makes services/budget-actual.ts dead-code-eliminate its dev
    // `import("@actual-app/api")`, so the SDK + better-sqlite3 are NOT
    // bundled; the pkg binary requires them from the shipped real path.
    '--define:process.env.PKG_BUNDLED="1"',
    // services/{llama-server,swift-sidecar}.ts intentionally use the
    // ESM `import.meta.url` with a runtime `typeof === "string"` guard
    // and a `__dirname` fallback so the same source runs in vitest
    // (ESM) and in this CJS bundle. esbuild's CJS-target rewrites
    // `import.meta.url` to "" — the runtime check catches that and
    // falls through. The warning's accurate but redundant given the guard.
    "--log-override:empty-import-meta=silent",
  ],
  { stdio: "inherit", cwd: __dirname }
);

// Step 2: Compile with pkg
console.log("Compiling standalone binary with pkg...");
const target = "node20-macos-arm64";
const outputName = "budget-itemizer-server-aarch64-apple-darwin";
execFileSync(
  "npx",
  ["@yao-pkg/pkg", "dist-server/server.cjs", "--targets", target, "--output", `${outDir}/${outputName}`],
  { stdio: "inherit", cwd: __dirname }
);

console.log(`Server binary built: ${outDir}/${outputName}`);

// Step 3: Download llama-server binary + shared libs from llama.cpp releases.
// SHA-256 pinned: a tampered release (compromised upstream, MITM during
// build, etc.) gets caught before the binary is bundled into the .app.
// Bump LLAMA_VERSION + LLAMA_SHA256 together when upgrading llama.cpp.
const LLAMA_VERSION = "b8149";
const LLAMA_SHA256 = "1c6372548f5c35016a6f106d7fd889652ef6aa525b22e3423aadc2d6911d6c2d";
const llamaUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/llama-${LLAMA_VERSION}-bin-macos-arm64.tar.gz`;
const llamaDest = resolve(outDir, "llama-server-aarch64-apple-darwin");

if (existsSync(llamaDest)) {
  console.log("llama-server binary already exists, skipping download.");
} else {
  console.log(`Downloading llama-server ${LLAMA_VERSION}...`);
  const tmpTar = resolve(outDir, "llama-server.tar.gz");
  const tmpExtract = resolve(outDir, "_llama_extract");
  const res = await fetch(llamaUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  await pipeline(res.body, createWriteStream(tmpTar));

  // Integrity check — refuse to bundle a tampered tarball.
  const hash = createHash("sha256").update(readFileSync(tmpTar)).digest("hex");
  if (hash !== LLAMA_SHA256) {
    try { unlinkSync(tmpTar); } catch {}
    throw new Error(
      `llama-server tarball SHA-256 mismatch.\n  Expected: ${LLAMA_SHA256}\n  Got:      ${hash}\n` +
      `Build aborted to avoid bundling an unverified binary.`
    );
  }
  console.log(`  ✓ tarball SHA-256 verified`);

  // Extract to temp dir, copy binary + all dylibs. We use execFileSync
  // (argv form, no shell) instead of execSync with template strings —
  // matches the project's no-shell-string discipline (.semgrep/budget-itemizer.yml).
  mkdirSync(tmpExtract, { recursive: true });
  execFileSync("tar", ["-xzf", tmpTar, "-C", tmpExtract], { stdio: "inherit" });

  // Find the extracted directory (e.g. llama-b8149/). The tarball is
  // pinned (SHA-256 above) so the content is deterministic; one dir.
  const entries = readdirSync(tmpExtract);
  if (entries.length !== 1) {
    throw new Error(`Expected one extracted directory in ${tmpExtract}, got ${entries.length}: ${entries.join(", ")}`);
  }
  const srcDir = resolve(tmpExtract, entries[0]);

  // Copy llama-server binary with Tauri target-triple naming
  copyFileSync(join(srcDir, "llama-server"), llamaDest);
  chmodSync(llamaDest, 0o755);

  // Copy all shared libraries — llama-server needs these at runtime.
  // Glob expansion would have required shell-globbing; here we do it
  // in Node so the no-shell discipline holds.
  for (const file of readdirSync(srcDir)) {
    if (file.endsWith(".dylib")) {
      copyFileSync(join(srcDir, file), join(outDir, file));
    }
  }

  // Cleanup
  unlinkSync(tmpTar);
  rmSync(tmpExtract, { recursive: true, force: true });

  console.log(`llama-server binary + libs: ${outDir}/`);
}

// Step 4: Build swift-sidecar (macOS Vision + Foundation Models)
const swiftSidecarDir = resolve(__dirname, "swift-sidecar");
const swiftDest = resolve(outDir, "swift-sidecar-aarch64-apple-darwin");

if (existsSync(swiftDest)) {
  console.log("swift-sidecar binary already exists, skipping build.");
} else if (existsSync(swiftSidecarDir)) {
  console.log("Building swift-sidecar...");
  try {
    execFileSync("swift", ["build", "-c", "release"], {
      stdio: "inherit",
      cwd: swiftSidecarDir,
    });
    const builtBinary = resolve(swiftSidecarDir, ".build/release/swift-sidecar");
    copyFileSync(builtBinary, swiftDest);
    chmodSync(swiftDest, 0o755);
    console.log(`swift-sidecar binary built: ${swiftDest}`);
  } catch (err) {
    console.warn(`swift-sidecar build failed (non-fatal): ${err.message}`);
    console.warn("Apple Vision/FM providers will be unavailable.");
  }
} else {
  console.log("swift-sidecar/ directory not found, skipping.");
}

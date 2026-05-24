// Build script: bundle the Hono server into a standalone macOS binary
// 1. esbuild bundles TypeScript → single CJS file
// 2. @yao-pkg/pkg compiles CJS → standalone Node binary

import { execFileSync } from "child_process";
import { mkdirSync, existsSync, createWriteStream, readFileSync, writeFileSync, unlinkSync, readdirSync, copyFileSync, chmodSync, rmSync } from "fs";
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

// Step 5: Ship @actual-app/api's PRODUCTION node_modules into the .app.
//
// The Actual SDK pulls in better-sqlite3 (a native .node) and loads its
// migrations/default-db.sqlite from disk via __dirname — neither can live in
// the pkg snapshot (the documented pkg+native-module problem). So
// services/budget-actual.ts loadApi() requires the SDK from a real on-disk
// path: Contents/Resources/server-modules/node_modules (relative to the
// sidecar's Contents/MacOS/ via process.execPath). We materialize that real
// tree here; Tauri copies it verbatim via bundle.resources. Shipping only
// production deps (--omit=dev) keeps the tree small. Pinned to the exact
// version dev/tests resolve so the shipped SDK == the tested SDK.
const serverModulesDir = resolve(__dirname, "src-tauri/server-modules");
const shippedModules = resolve(serverModulesDir, "node_modules");
const shippedActualPkgJson = resolve(shippedModules, "@actual-app/api/package.json");

const desiredActualVersion = JSON.parse(
  readFileSync(resolve(__dirname, "node_modules/@actual-app/api/package.json"), "utf8"),
).version;

// Bug-1 guard: better-sqlite3's native .node is compiled by THIS npm install
// against the build machine's Node ABI, but at runtime it's loaded by the Node
// that @yao-pkg/pkg embeds — the `target` major from Step 2 (node20-... -> 20).
// If the build Node's major differs, the .node is the wrong ABI and the
// packaged app can't open Actual budgets (NODE_MODULE_VERSION). Fail at build
// time with a fix, not at user-click time.
const pkgTargetNodeMajor = Number(/^node(\d+)/.exec(target)?.[1]);
const buildNodeMajor = Number(process.versions.node.split(".")[0]);
if (pkgTargetNodeMajor && buildNodeMajor !== pkgTargetNodeMajor) {
  throw new Error(
    `Node major mismatch: building with Node ${buildNodeMajor} but the pkg target is node${pkgTargetNodeMajor}.\n` +
    `better-sqlite3's native addon would be compiled for the wrong ABI and fail to load in the packaged app.\n` +
    `Build with Node ${pkgTargetNodeMajor}.x (e.g. \`nvm use ${pkgTargetNodeMajor}\`).`,
  );
}

// Cache key = SDK version + Node ABI, recorded in a build marker beside (not
// inside) node_modules so it isn't shipped. Version ALONE is insufficient: a
// Node upgrade that changes the ABI without changing the SDK version would
// otherwise reuse a stale, wrong-ABI .node (Bug 1).
const buildMarkerPath = resolve(serverModulesDir, ".build-marker.json");
const wantMarker = { version: desiredActualVersion, abi: process.versions.modules };
const haveMarker = existsSync(buildMarkerPath) && existsSync(shippedActualPkgJson)
  ? JSON.parse(readFileSync(buildMarkerPath, "utf8"))
  : null;

if (haveMarker && haveMarker.version === wantMarker.version && haveMarker.abi === wantMarker.abi) {
  console.log(`@actual-app/api ${desiredActualVersion} (ABI ${wantMarker.abi}) already shipped, skipping install.`);
} else {
  console.log(`Installing @actual-app/api ${desiredActualVersion} (production deps only) for the .app...`);
  rmSync(serverModulesDir, { recursive: true, force: true });
  mkdirSync(serverModulesDir, { recursive: true });
  // npm install into a prefix: creates <prefix>/node_modules with the package
  // and its production deps. --omit=dev drops the tree's devDependencies;
  // --no-package-lock/--no-audit/--no-fund keep it lean and quiet. argv form
  // (no shell string) per the project's no-shell discipline (.semgrep).
  execFileSync(
    "npm",
    [
      "install", `@actual-app/api@${desiredActualVersion}`,
      "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund",
      "--prefix", serverModulesDir,
    ],
    { stdio: "inherit", cwd: __dirname },
  );
  // npm writes a package.json into the prefix; we overwrite it below with a
  // deterministic manifest for the `npm ls` completeness check. Both it and the
  // build marker are siblings of node_modules, and only node_modules ships, so
  // neither reaches the .app.
}

// Prune build-time-only and symlinked cruft before bundling. This runs every
// build (idempotent) so a cached tree gets pruned too. Removing the npm `.bin`
// symlink dirs matters most: Tauri's resource copier and (later) notarization
// choke on symlinks. The better-sqlite3 source/deps/gyp dirs are only needed
// to COMPILE the .node, not to load it at runtime.
const pruneTargets = [
  // build-time C/C++ source + sqlite amalgamation (the .node is already built)
  "better-sqlite3/deps",
  "better-sqlite3/src",
  "better-sqlite3/build/node_gyp_bins",
  // better-sqlite3 test fixture — never loaded by the app
  "better-sqlite3/build/Release/test_extension.node",
];
for (const rel of pruneTargets) {
  rmSync(resolve(shippedModules, rel), { recursive: true, force: true });
}
// Remove every `.bin` directory (CLI symlinks; runtime never uses them).
const pruneBinDirs = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name === ".bin") rmSync(full, { recursive: true, force: true });
    else pruneBinDirs(full);
  }
};
pruneBinDirs(shippedModules);

// Fail loudly if the native engine didn't materialize — a packaged app
// missing this can list Actual budgets but not open them (the bug M1/M2 fix).
const betterSqliteNode = resolve(shippedModules, "better-sqlite3/build/Release/better_sqlite3.node");
if (!existsSync(betterSqliteNode)) {
  throw new Error(
    `better_sqlite3.node missing at ${betterSqliteNode} after install.\n` +
    `Actual's native engine is required for the packaged app to open a budget.`,
  );
}

// Bug-3 guard: we ad-hoc sign below, which is correct for today's ad-hoc app
// but FATAL under a hardened runtime — macOS library validation rejects an
// ad-hoc-signed nested Mach-O loaded by a Developer-ID-signed binary, so Actual
// would break only in the notarized build. If a real signing identity is set,
// fail loudly rather than ship a silently-broken notarized app. (When wiring up
// real signing: sign these with that identity, or add the sidecar entitlement
// com.apple.security.cs.disable-library-validation — docs/TODO.md.)
const appleIdentity = (process.env.APPLE_SIGNING_IDENTITY || "").trim();
if (appleIdentity && appleIdentity !== "-") {
  throw new Error(
    `APPLE_SIGNING_IDENTITY is set ("${appleIdentity}") but build-server.mjs ad-hoc signs the nested\n` +
    `native modules. Under a hardened runtime, library validation rejects ad-hoc-signed nested code at\n` +
    `runtime — Actual budgets won't open in the notarized build. Sign the shipped .node with the\n` +
    `Developer ID identity, or add com.apple.security.cs.disable-library-validation, before enabling signing.`,
  );
}

// Ad-hoc codesign every Mach-O (.node/.dylib) in the shipped tree. On arm64
// every loaded Mach-O needs a valid signature; node-gyp output is usually
// linker-signed already, but we re-sign ad-hoc to guarantee validity after
// the copy. Tauri seals (does not re-sign) nested Resources files, so this
// signature is what ships.
const nativeFiles = [];
const collectNative = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectNative(full);
    else if (entry.isFile() && (entry.name.endsWith(".node") || entry.name.endsWith(".dylib"))) nativeFiles.push(full);
  }
};
collectNative(shippedModules);
for (const f of nativeFiles) {
  execFileSync("codesign", ["--force", "--sign", "-", f], { stdio: "inherit" });
}
console.log(`Shipped Actual SDK tree; ad-hoc signed ${nativeFiles.length} native file(s): ${nativeFiles.map((f) => f.split("/server-modules/node_modules/")[1]).join(", ")}`);

// Bug-2 guard: the existence check above only covers better_sqlite3.node. A
// partial tree missing ANY other production dep (interrupted npm install, a
// hand-edited cache, a registry hiccup) would ship and fail at user-click time
// with "Cannot find module ...". Two complementary gates, run every build:
//
//   (1) `npm ls --all` — asserts every package's declared production deps are
//       present, recursively. This is the real completeness check: the load
//       smoke below does NOT catch missing deps that the SDK requires lazily
//       (verified: removing date-fns/@actual-app/crdt still let require() pass,
//       but `npm ls --all` flags them missing and exits non-zero).
//   (2) load the SDK + open the native engine in a clean child process — catches
//       a present-but-unloadable .node (ABI). Build Node major == pkg target
//       major is enforced above, so a load here is representative of the
//       embedded runtime.
//
// Write a deterministic manifest for (1). It's a sibling of node_modules; only
// node_modules ships, so it never reaches the .app. Written every build (incl.
// cache-skip) so the check always has something to resolve against.
writeFileSync(
  resolve(serverModulesDir, "package.json"),
  JSON.stringify(
    { name: "budget-itemizer-server-modules", private: true, dependencies: { "@actual-app/api": desiredActualVersion } },
    null, 2,
  ),
);
console.log("Verifying shipped tree completeness (npm ls --all)...");
try {
  execFileSync("npm", ["ls", "--all", "--omit=dev", "--prefix", serverModulesDir], { cwd: __dirname, stdio: ["ignore", "ignore", "inherit"] });
} catch {
  throw new Error(
    "Shipped Actual tree is INCOMPLETE — npm ls --all reported missing deps (see above).\n" +
    "The packaged app would fail to open Actual budgets. Run `rm -rf src-tauri/server-modules` and rebuild.",
  );
}
const smoke = [
  'globalThis.navigator = globalThis.navigator || { platform: "", userAgent: "" };',
  'const path = require("path"); const M = process.env.SM;',
  'require(path.join(M, "@actual-app", "api"));',
  'const Database = require(path.join(M, "better-sqlite3"));',
  'const db = new Database(":memory:"); db.exec("create table t(x)"); db.close();',
].join("\n");
console.log("Verifying the shipped tree loads (require @actual-app/api + open better-sqlite3)...");
execFileSync(process.execPath, ["-e", smoke], { env: { ...process.env, SM: shippedModules }, stdio: "inherit" });

// Record the cache marker only after install + prune + sign + completeness +
// load all passed, so an interrupted build never leaves a marker that
// greenlights a bad tree.
writeFileSync(buildMarkerPath, JSON.stringify(wantMarker, null, 2));
console.log(`✓ shipped tree verified (npm ls + load) + marker written (v${wantMarker.version}, ABI ${wantMarker.abi}).`);

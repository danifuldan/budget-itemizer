// Build script: bundle the Hono server into a standalone macOS binary
// 1. esbuild bundles TypeScript → single CJS file
// 2. @yao-pkg/pkg compiles CJS → standalone Node binary

import { execFileSync } from "child_process";
import { mkdirSync, existsSync, createWriteStream, readFileSync, writeFileSync, unlinkSync, readdirSync, copyFileSync, chmodSync, rmSync, cpSync } from "fs";
import { resolve, dirname, join, relative, sep } from "path";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import { createHash } from "crypto";
import { builtinModules } from "module";

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
// tree here; Tauri copies it verbatim via bundle.resources.
//
// The tree is COPIED from the lockfile-pinned root node_modules — NOT a fresh
// `npm install` — so the shipped SDK + native engine are byte-identical to the
// versions dev and the unit suite run against. A floating install
// (`--no-package-lock`) silently shipped better-sqlite3 12.10.0 while the
// root lockfile pinned 12.8.0: the packaged app ran a different native SQLite
// engine than every test. Copying from root makes the root package-lock.json
// the single source of truth — dev == shipped by construction, no drift, no
// second lockfile to keep in sync.
const serverModulesDir = resolve(__dirname, "src-tauri/server-modules");
const shippedModules = resolve(serverModulesDir, "node_modules");
const shippedActualPkgJson = resolve(shippedModules, "@actual-app/api/package.json");
const rootModules = resolve(__dirname, "node_modules");

const readPkgVersion = (dir) =>
  JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")).version;
const desiredActualVersion = readPkgVersion(resolve(rootModules, "@actual-app", "api"));
const rootBetterSqliteVersion = readPkgVersion(resolve(rootModules, "better-sqlite3"));

// Bug-1 guard: better-sqlite3's native .node (in root) was compiled against the
// build machine's Node ABI, but at runtime it's loaded by the Node @yao-pkg/pkg
// embeds — the `target` major from Step 2 (node20-... -> 20). If the build
// Node's major differs, the .node is the wrong ABI and the packaged app can't
// open Actual budgets (NODE_MODULE_VERSION). Fail at build time, not at click.
const pkgTargetNodeMajor = Number(/^node(\d+)/.exec(target)?.[1]);
const buildNodeMajor = Number(process.versions.node.split(".")[0]);
if (pkgTargetNodeMajor && buildNodeMajor !== pkgTargetNodeMajor) {
  throw new Error(
    `Node major mismatch: building with Node ${buildNodeMajor} but the pkg target is node${pkgTargetNodeMajor}.\n` +
    `better-sqlite3's native addon would be compiled for the wrong ABI and fail to load in the packaged app.\n` +
    `Build with Node ${pkgTargetNodeMajor}.x (e.g. \`nvm use ${pkgTargetNodeMajor}\`).`,
  );
}

// Cache key = SDK version + better-sqlite3 version + Node ABI + a hash of the
// root package-lock.json, recorded in a build marker beside (not inside)
// node_modules so it isn't shipped. The lockfile hash is the load-bearing
// part: the shipped tree's RUNTIME externals are NOT just better-sqlite3 — the
// SDK bundle also require()s handlebars / chevrotain / sax / xmlbuilder / retry
// / err-code / source-map, none of which were in the old key. Keying only on
// api+better-sqlite3 let a transitive bump (security patch, `npm update`,
// `^`-range re-resolution) ship a STALE copy on an incremental build — the
// exact drift this step exists to kill. Any lockfile change now busts the cache
// and re-copies; ABI still guards a Node bump.
const lockHash = createHash("sha256")
  .update(readFileSync(resolve(__dirname, "package-lock.json")))
  .digest("hex").slice(0, 16);
const buildMarkerPath = resolve(serverModulesDir, ".build-marker.json");
const wantMarker = { version: desiredActualVersion, betterSqlite: rootBetterSqliteVersion, abi: process.versions.modules, lock: lockHash };
const haveMarker = existsSync(buildMarkerPath) && existsSync(shippedActualPkgJson)
  ? JSON.parse(readFileSync(buildMarkerPath, "utf8"))
  : null;
const markerMatches = haveMarker
  && haveMarker.version === wantMarker.version
  && haveMarker.betterSqlite === wantMarker.betterSqlite
  && haveMarker.abi === wantMarker.abi
  && haveMarker.lock === wantMarker.lock;

if (markerMatches) {
  console.log(`@actual-app/api ${desiredActualVersion} + better-sqlite3 ${rootBetterSqliteVersion} (ABI ${wantMarker.abi}) already shipped, skipping copy.`);
} else {
  console.log(`Copying @actual-app/api ${desiredActualVersion} production closure from the pinned root tree...`);
  rmSync(serverModulesDir, { recursive: true, force: true });
  mkdirSync(shippedModules, { recursive: true });

  // Resolve a dep the way Node does: from the requiring package's dir, check
  // its OWN node_modules first, then climb ancestors (skipping node_modules
  // segments) up to the project root — nearest wins. This mirrors npm's
  // hoisting so a version-conflicted NESTED dep resolves to the correct copy
  // (e.g. @actual-app/crdt needs uuid@9 nested while the top-level is uuid@13)
  // instead of grabbing the top-level version that belongs to another consumer.
  const resolveDep = (name, fromPkgDir) => {
    let dir = fromPkgDir;
    while (dir.length >= __dirname.length) {
      if (dir.split(sep).pop() !== "node_modules") {
        const cand = resolve(dir, "node_modules", name);
        if (existsSync(resolve(cand, "package.json"))) return cand;
      }
      if (dir === __dirname) break;
      dir = dirname(dir);
    }
    return null;
  };

  // Walk @actual-app/api's PRODUCTION closure (dependencies + optional). Keyed
  // by physical path relative to rootModules so nested (version-conflicted)
  // copies keep their exact layout. A dep this walk misses is caught by the
  // `npm ls --all` completeness gate below (build fails loud) — never shipped.
  const closure = new Map(); // rel-path-from-rootModules -> absolute source dir
  const visit = (pkgDir) => {
    let pj;
    try { pj = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")); } catch { return; }
    const deps = { ...(pj.dependencies || {}), ...(pj.optionalDependencies || {}) };
    for (const name of Object.keys(deps)) {
      const depDir = resolveDep(name, pkgDir);
      if (!depDir) continue; // optional absent — completeness gate catches required misses
      const rel = relative(rootModules, depDir);
      if (closure.has(rel)) continue;
      closure.set(rel, depDir);
      visit(depDir);
    }
  };
  const apiDir = resolve(rootModules, "@actual-app", "api");
  closure.set(relative(rootModules, apiDir), apiDir);
  visit(apiDir);

  for (const [rel, depDir] of closure) {
    cpSync(depDir, resolve(shippedModules, rel), {
      recursive: true,
      // Skip each package's nested node_modules — those are separate closure
      // entries copied at their own rel path, so this prevents double-copy.
      filter: (src) => !relative(depDir, src).split(sep).includes("node_modules"),
    });
  }
  console.log(`Copied ${closure.size} package(s) from the pinned root tree.`);
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
// Derive the bundle's RUNTIME externals straight from the shipped dist — the
// bare specifiers @actual-app/api require()s that aren't inlined into its
// webpack bundle. A top-level `require("@actual-app/api")` loads only the
// barrel + better-sqlite3 (~2 of the ~8 externals); the rest
// (chevrotain / err-code / handlebars / retry / sax / source-map / xmlbuilder)
// are reached only on the sync / import / report paths, which no gate
// exercises. `npm ls --all` above proves they're PRESENT (declared), not that
// they LOAD. Requiring each below turns a present-but-unloadable external — or
// a NEW one a future SDK bump introduces — into a build failure instead of a
// crash on the user's first Actual import. Derived (not hardcoded) so the list
// can't silently fall out of date.
const collectRuntimeExternals = (distDir) => {
  const found = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(js|cjs|mjs)$/.test(e.name)) continue;
      const re = /require\(\s*["']([^"'.][^"')]*)["']\s*\)/g;
      const src = readFileSync(full, "utf8");
      let m;
      while ((m = re.exec(src))) {
        const spec = m[1];
        if (spec.startsWith("node:")) continue;
        const parts = spec.split("/");
        const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
        if (name && !builtinModules.includes(name)) found.add(name);
      }
    }
  };
  walk(distDir);
  return [...found].sort();
};
const runtimeExternals = collectRuntimeExternals(resolve(shippedModules, "@actual-app", "api", "dist"));
const smoke = [
  'globalThis.navigator = globalThis.navigator || { platform: "", userAgent: "" };',
  'const path = require("path"); const M = process.env.SM;',
  // Barrel load — catches a broken/partial @actual-app/api bundle. (Preserved
  // from the prior smoke; the derived-externals loop below does NOT cover it,
  // since the api package isn't one of its own require() targets.)
  'require(path.join(M, "@actual-app", "api"));',
  'for (const name of JSON.parse(process.env.EXT)) {',
  '  try { require(path.join(M, ...name.split("/"))); }',
  '  catch (e) { throw new Error("runtime external failed to load from shipped tree: " + name + " — " + e.message); }',
  '}',
  'const Database = require(path.join(M, "better-sqlite3"));',
  'const db = new Database(":memory:"); db.exec("create table t(x)"); db.close();',
].join("\n");
console.log(`Verifying the shipped tree loads (require ${runtimeExternals.length} runtime externals + open better-sqlite3): ${runtimeExternals.join(", ")}`);
execFileSync(process.execPath, ["-e", smoke], { env: { ...process.env, SM: shippedModules, EXT: JSON.stringify(runtimeExternals) }, stdio: "inherit" });

// Record the cache marker only after install + prune + sign + completeness +
// load all passed, so an interrupted build never leaves a marker that
// greenlights a bad tree.
writeFileSync(buildMarkerPath, JSON.stringify(wantMarker, null, 2));
console.log(`✓ shipped tree verified (npm ls + load) + marker written (api ${wantMarker.version}, better-sqlite3 ${wantMarker.betterSqlite}, ABI ${wantMarker.abi}).`);

#!/usr/bin/env bash
#
# release-manifest.sh — generate and verify the updater `latest.json`.
#
# WHY THIS EXISTS: v0.3.7 shipped a `latest.json` whose `signature` field was
# base64-encoded ONE TIME TOO MANY. The Tauri `.sig` file is *already* base64;
# pasting it through an extra `base64`/`btoa` step produced a double-wrapped
# value. Tauri's updater decodes the field exactly once, found more base64
# where the minisign header belongs, and silently rejected every update. The
# signing key and the artifact were both fine — only the manifest encoding was
# wrong, and the old "verify" step only checked the manifest was *reachable*,
# never that the signature parsed or verified. This script replaces the manual
# copy-paste with a deterministic generator and a real cryptographic gate.
#
# Usage:
#   release-manifest.sh generate \
#       --tarball <path/to/Budget Itemizer.app.tar.gz> \
#       --sig     <path/to/Budget Itemizer.app.tar.gz.sig> \
#       --url     <https://.../releases/download/vX.Y.Z/ASSET.app.tar.gz> \
#       [--version X.Y.Z]      (default: from src-tauri/tauri.conf.json) \
#       [--notes "text" | --notes-file <path>] \
#       [--pub-date <ISO8601>] (default: now, UTC) \
#       [--out <path>]         (default: ./latest.json)
#
#   release-manifest.sh verify <latest.json | URL> [--tarball <path>]
#       Fails (non-zero) unless the signature decodes in EXACTLY one base64
#       step to a minisign header AND minisign -V verifies it against the
#       tarball. With no --tarball, downloads the tarball named in the
#       manifest's own `url` (validates exactly what clients will fetch).
#       Pubkey is read from src-tauri/tauri.conf.json.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONF="$ROOT/src-tauri/tauri.conf.json"

die() { echo "error: $*" >&2; exit 1; }

# The minisign public key the running app verifies against, pulled straight
# from the config that gets embedded in the build — single source of truth.
pubkey_b64_from_conf() {
  python3 - "$CONF" <<'PY'
import json, sys
conf = json.load(open(sys.argv[1]))
pk = (conf.get("plugins", {}).get("updater") or {}).get("pubkey")
if not pk:
    sys.exit("no plugins.updater.pubkey in tauri.conf.json")
print(pk)
PY
}

# Write the decoded 2-line minisign pubkey file from the config's base64 blob.
write_pubkey_file() {
  local out="$1"
  pubkey_b64_from_conf | python3 -c 'import base64,sys; sys.stdout.write(base64.b64decode(sys.stdin.read().strip()).decode())' > "$out"
}

cmd_generate() {
  local tarball="" sig="" url="" version="" notes="" notes_file="" pub_date="" out="$ROOT/latest.json"
  while [ $# -gt 0 ]; do
    case "$1" in
      --tarball) tarball="$2"; shift 2;;
      --sig) sig="$2"; shift 2;;
      --url) url="$2"; shift 2;;
      --version) version="$2"; shift 2;;
      --notes) notes="$2"; shift 2;;
      --notes-file) notes_file="$2"; shift 2;;
      --pub-date) pub_date="$2"; shift 2;;
      --out) out="$2"; shift 2;;
      *) die "unknown arg: $1";;
    esac
  done
  [ -n "$tarball" ] && [ -f "$tarball" ] || die "--tarball missing or not a file"
  [ -n "$sig" ] && [ -f "$sig" ] || die "--sig missing or not a file"
  [ -n "$url" ] || die "--url is required (must match the uploaded asset name exactly)"
  [ -n "$version" ] || version="$(python3 -c 'import json;print(json.load(open("'"$CONF"'"))["version"])')"
  [ -n "$pub_date" ] || pub_date="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  if [ -n "$notes_file" ]; then
    [ -f "$notes_file" ] || die "--notes-file not found"
    notes="$(cat "$notes_file")"
  fi

  # THE LOAD-BEARING LINE: the signature is the .sig file content VERBATIM.
  # The .sig is already base64 — do NOT encode it again. This is the entire
  # bug class this script exists to prevent.
  SIG_VERBATIM="$(cat "$sig")" \
  VERSION="$version" NOTES="$notes" PUB_DATE="$pub_date" URL="$url" OUT="$out" \
  python3 <<'PY'
import json, os
sig = os.environ["SIG_VERBATIM"].strip()
# Guard the generator against its own historical mistake: a correct Tauri .sig
# decodes in one step to a minisign header. If it already decodes twice, the
# input was pre-doubled and we must not pass it through.
import base64
try:
    once = base64.b64decode(sig).decode("utf-8", "replace")
except Exception:
    raise SystemExit("error: --sig content is not valid base64")
if not once.startswith("untrusted comment:"):
    raise SystemExit(
        "error: --sig does not decode to a minisign header in one step "
        "(got: %r). The .sig may already be double-encoded; do not re-encode it."
        % once[:40]
    )
manifest = {
    "version": os.environ["VERSION"],
    "notes": os.environ["NOTES"],
    "pub_date": os.environ["PUB_DATE"],
    "platforms": {"darwin-aarch64": {"signature": sig, "url": os.environ["URL"]}},
}
json.dump(manifest, open(os.environ["OUT"], "w"), indent=2)
print("wrote", os.environ["OUT"])
PY
  echo "Next: upload it, then gate it:  $0 verify <published-url-or-path>"
}

cmd_verify() {
  command -v minisign >/dev/null || die "minisign not installed (brew install minisign)"
  [ $# -ge 1 ] || die "usage: verify <latest.json | URL> [--tarball <path>]"
  local src="$1"; shift
  local tarball=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tarball) tarball="$2"; shift 2;;
      *) die "unknown arg: $1";;
    esac
  done

  local work; work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN

  # Fetch or copy the manifest.
  if printf '%s' "$src" | grep -qE '^https?://'; then
    curl -fsSL --max-time 30 "$src" -o "$work/latest.json" || die "could not fetch manifest: $src"
  else
    [ -f "$src" ] || die "manifest not found: $src"
    cp "$src" "$work/latest.json"
  fi

  # Decode-depth gate: the field MUST decode in exactly one step to a minisign
  # header. One step too few (malformed) or one too many (the v0.3.7 bug) fails.
  python3 - "$work/latest.json" "$work/sig.minisig" <<'PY'
import base64, json, sys
j = json.load(open(sys.argv[1]))
sig = j["platforms"]["darwin-aarch64"]["signature"]
try:
    once = base64.b64decode(sig).decode("utf-8", "replace")
except Exception:
    sys.exit("GATE FAIL: signature field is not valid base64")
if not once.startswith("untrusted comment:"):
    # Distinguish the double-encode case for a precise error.
    try:
        twice = base64.b64decode(once).decode("utf-8", "replace")
    except Exception:
        twice = ""
    if twice.startswith("untrusted comment:"):
        sys.exit("GATE FAIL: signature is DOUBLE base64-encoded (the v0.3.7 bug). "
                 "It must be the .sig contents verbatim, encoded exactly once.")
    sys.exit("GATE FAIL: signature does not decode to a minisign header (got %r)" % once[:40])
open(sys.argv[2], "w").write(once)
print("decode-depth gate: PASS (single-encoded minisign header)")
print("manifest url:", j["platforms"]["darwin-aarch64"]["url"])
# Expose the url for the shell to fetch if no local tarball was given.
open(sys.argv[1] + ".url", "w").write(j["platforms"]["darwin-aarch64"]["url"])
PY

  # Resolve the tarball: explicit --tarball, else the manifest's own url.
  if [ -z "$tarball" ]; then
    local url; url="$(cat "$work/latest.json.url")"
    echo "downloading tarball from manifest url..."
    curl -fsSL --max-time 300 "$url" -o "$work/art.tar.gz" || die "could not fetch tarball: $url"
    tarball="$work/art.tar.gz"
  fi
  [ -f "$tarball" ] || die "tarball not found: $tarball"

  write_pubkey_file "$work/key.pub"
  echo "crypto gate: verifying signature against tarball..."
  minisign -V -p "$work/key.pub" -m "$tarball" -x "$work/sig.minisig" \
    || die "GATE FAIL: minisign could not verify the signature against the tarball"
  echo "VERIFY OK ✓ — manifest is single-encoded and the signature verifies."
}

case "${1:-}" in
  generate) shift; cmd_generate "$@";;
  verify)   shift; cmd_verify "$@";;
  *) die "usage: $0 {generate|verify} ...";;
esac

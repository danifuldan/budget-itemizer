# Signed-update Release Playbook

How to ship a new version that existing installs auto-update to. Companion to `RELEASE.md`; this doc covers the **updater plugin** specifically.

## One-time setup (already done)

- Updater keypair lives at `~/.tauri/budget-itemizer/updater.key` (private,
  0600) and `~/.tauri/budget-itemizer/updater.key.pub` (public).
- **Never commit the private key.** It's outside the repo on purpose.
- The public key is embedded in `src-tauri/tauri.conf.json` under
  `plugins.updater.pubkey`. That's what the running app uses to verify
  the signature of any update it downloads.
- The manifest endpoint is configured in the same place:
  `https://github.com/danifuldan/budget-itemizer/releases/latest/download/latest.json`.
- If you lose the private key, you cannot ship signed updates to existing
  installs. Existing users would have to manually re-download. Back the
  key up to a password manager.

## Per-release flow

### 1. Bump the version

```bash
# in src-tauri/tauri.conf.json
"version": "0.1.1"

# matching change in package.json
"version": "0.1.1"

# matching change in src-tauri/Cargo.toml
version = "0.1.1"
```

The version in `tauri.conf.json` is what the manifest will declare and what the
client uses to decide whether to offer the update.

### 2. Build the signed bundle

```bash
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/budget-itemizer/updater.key"
# If the key has a password (it doesn't, from --ci generation):
# export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

npm run tauri:build
```

The build produces:

- `src-tauri/target/release/bundle/macos/Budget Itemizer.app`
- `src-tauri/target/release/bundle/dmg/Budget Itemizer_<version>_aarch64.dmg`
- `src-tauri/target/release/bundle/macos/Budget Itemizer.app.tar.gz` (the
  updater bundle — what the plugin downloads)
- `src-tauri/target/release/bundle/macos/Budget Itemizer.app.tar.gz.sig`
  (signature over the tarball, produced from the private key)

### 3. Create the `latest.json` manifest

Tauri's updater plugin polls this file. Create it locally:

```json
{
  "version": "0.1.1",
  "notes": "Brief user-facing release notes.",
  "pub_date": "2026-05-12T20:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<paste contents of Budget Itemizer.app.tar.gz.sig here>",
      "url": "https://github.com/danifuldan/budget-itemizer/releases/download/v0.1.1/Budget.Itemizer.app.tar.gz"
    }
  }
}
```

The `signature` field is the *full text* of the `.sig` file (a single base64-ish
line). Open the `.sig` and paste its contents verbatim.

### 4. Cut a GitHub Release

```bash
gh release create v0.1.1 \
  --title "v0.1.1" \
  --notes-file release-notes-v0.1.1.md \
  "src-tauri/target/release/bundle/dmg/Budget Itemizer_0.1.1_aarch64.dmg" \
  "src-tauri/target/release/bundle/macos/Budget Itemizer.app.tar.gz" \
  "src-tauri/target/release/bundle/macos/Budget Itemizer.app.tar.gz.sig" \
  latest.json
```

The asset names matter because the manifest URL hardcodes them. Renaming the
`.tar.gz` in the release breaks the updater for everyone running the old
version.

### 5. Verify

After publishing, check that the manifest is reachable:

```bash
curl -sL https://github.com/danifuldan/budget-itemizer/releases/latest/download/latest.json | jq .
```

Then in an existing install:

- Open Settings → "Update" row → click "Check now". Should detect the new
  version. Clicking "Install & relaunch" should download the tar.gz,
  verify its signature against the embedded public key, atomically replace
  the .app, and relaunch.

If the signature doesn't verify, the plugin rejects the update silently
in the logs (`tail ~/Library/Logs/com.budget-itemizer.desktop/Budget Itemizer.log`).
That means either (a) you signed with the wrong key, (b) the `.sig` file
contents in `latest.json` don't match the actual `.sig`, or (c) you
re-uploaded the tar.gz without re-signing.

## Rollback

If a release ships a regression:

1. Cut a new release with the previous version's code, bumped version (e.g.
   `0.1.0` regressed in `0.1.1`; ship `0.1.2` with `0.1.0`'s code).
2. Existing `0.1.1` installs will auto-update to `0.1.2`.
3. **Do not** edit a published release's assets. The signature was computed
   over a specific tar.gz; replacing the tar.gz breaks the signature.
   Always cut a new release.

## What this doesn't do

- **macOS code signing / notarization.** That's a separate (Apple Developer
  ID-based) layer. Without it, the .app shows the Gatekeeper warning on
  first install. Once installed, the updater's own signature verification
  handles update integrity regardless of Apple signing status.
- **Update on a beta channel.** All installs poll the same `latest.json`.
  To run a beta channel, host a separate manifest at a different URL and
  ship a build configured with that endpoint.
- **Update rollouts / staged releases.** GitHub Releases is all-or-nothing.
  Use a different host (Cloudflare Workers, S3 + percentage logic) if you
  need staged rollout.

## Security notes

- Anyone who steals your private key can sign malicious updates that
  existing installs will accept. Treat the key like a code-signing
  identity. Keep it on encrypted storage (FileVault), back up to a
  password manager, never commit, never check into env files.
- The `pubkey` in `tauri.conf.json` is the only thing the running app
  trusts. Rotating the keypair requires (a) generating a new pair, (b)
  rebuilding and re-signing every release going forward with the new key,
  and (c) shipping a transitional release that contains BOTH old and new
  pubkeys so users on old installs can update to the transitional, then
  to the new-key versions. There's no in-place public-key rotation —
  plan ahead.

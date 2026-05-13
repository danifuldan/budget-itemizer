# Release v0.1.0 — Remaining Work

A curated, action-oriented snapshot of everything left before public-beta ship.
TODO.md remains the historical audit trail; this is the working checklist.

Last updated: 2026-05-14.

---

## Pre-release smoke (run all three before tagging)

Three scripted smokes cover the release surface that used to require manual
"open the app and click around" testing. All three must pass before tagging a
release. None of them are part of `npm test` — they're slow, have side effects,
and shouldn't run on every save.

1. **`npm run smoke:use-path`** — synthetic PDFs through the full parse
   pipeline (Apple Vision OCR + Llama 3.1 8B + reconcile). 4 fixtures,
   snapshot comparison. ~3-4 min cold, ~1 min once the model's warm. No
   YNAB writes, no inbox writes. Isolated HOME.
2. **`npm run smoke:fresh-install`** — sidecar against an empty HOME with no
   config, no models, no Keychain. Drives the wizard via HTTP, asserts the
   setup state transitions. ~10s. No YNAB or filesystem writes outside tmp.
3. **`BUDGET_ITEMIZER_SMOKE_FIXTURES=/path/to/private/fixtures npm run smoke:personal`**
   — real receipt PDFs from a private path through the full import flow,
   writing to your configured YNAB budget. Teardown deletes everything it
   creates by matching memo prefix `[SMOKE <runId>]` over the last 30 days.
   Variable runtime. **Requires the YNAB budget your app is configured against
   to be one you're comfortable having transactions appear and disappear in.**

If any of the three fails, fix before tagging.

---

## 0. Manual UI checks (the smoke scripts can't see these)

The three smoke scripts above cover parse, import, wizard HTTP surface, and
basic auth/setup transitions. They do NOT see anything that needs a human eye:
splash visuals, focus order, badge states, animations. Walk through these by
hand before tagging.

- [ ] **LLM error splash** — temporarily rename `~/.config/budget-itemizer/models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf` (or stop llama-server mid-launch some other way), open the app, verify `LlmStartErrorScreen` renders with an "Open Settings" button (not an infinite splash).
- [ ] **Hidden Delete in history rows** — Tab through history rows; the delete button on collapsed rows must NOT be focusable. Reveal the row (swipe), then Tab — delete is now focusable.
- [ ] **SetupWizard advance-block** — interrupt `/setup/save` (block network mid-wizard or feed it a bad token) and confirm Next surfaces a banner instead of advancing.
- [ ] **Inbox-path change during in-flight import** — change inbox path in Settings while a receipt is mid-import; the file should still move to processed, no orphan in old inbox.
- [ ] **Update-available gear dot** — bump version on a private fork, build a fake `latest.json`, point updater endpoint at it, verify the red dot appears on the gear icon. (Pending until v0.2.0 release flow exists.)
- [ ] *Optional:* **Actual Budget end-to-end** — if validating Actual provider, the smoke scripts don't cover it. Hit the Actual setup screen in the app with real server creds.

---

## 1. Ship-blockers (must address or consciously accept before tag)

### Pre-mortem findings — all fixed
Six bugs surfaced by `/premortem` this session. All 6 fixed with test coverage.
Detail in TODO.md "Pre-mortem findings (all fixed)."

- [x] **HIGH** — llmReady error swallowed → permanent splash if `startLlamaServer` fails. `services/llama-server.ts` tracks per-slot start errors; `/status` exposes `llmStartError`; new `LlmStartErrorScreen` component renders a recoverable error UI with "Open Settings" instead of an infinite splash.
- [x] **HIGH** — `clearAllPending` during in-flight import orphans the file in the old inbox. `clearAllPending` now preserves `importing`/`parsing` entries so their handlers can finish; `/import` snapshots `filePath` before the YNAB await as defense-in-depth.
- [x] **MEDIUM** — Hidden Delete History button is keyboard-focusable. `tabIndex={revealed ? 0 : -1}` + `aria-hidden={!revealed}`.
- [x] **MEDIUM** — SetupWizard `goNext` ignores `saveSetup` return value. Now reads the boolean; on `false`, surfaces a wizard banner and does not advance.
- [x] **MEDIUM** — Second concurrent `/models/download` HTTP call gets silent SSE. Fan-out: per-modelId subscriber set, every progress tick invokes all subscribed callbacks.
- [x] **MEDIUM** — `progressBufferRef` pruned during optimistic Discard before 409-restore. Removed the over-eager `useEffect`; new `pruneStaleBuffers` is called only from `fetchPending` (server-state-replacing path).

Tests: 282 → 289 passing (+7 across 5 files). Type-check clean.

### Sidecar lifecycle verification
- [ ] **Manual test**: install fresh DMG, launch, quit, immediately delete the
      .app from Applications. Should not see "in use." Check logs for
      "Sidecar exited gracefully."

### Clean-machine smoke test (gates everything below)
- [ ] Wipe local: delete `.app`, `~/.config/budget-itemizer/`, models dir
- [ ] Install latest DMG, complete setup as if a stranger
- [ ] Time-box to 30 minutes; note every point of confusion or failure
- [ ] Fix any blockers surfaced before continuing

---

## 2. Release artifacts

### README updates (target: rewrite the public-facing parts)
- [ ] Header: "Public Beta — Apple Silicon Macs only, unsigned"
- [ ] Privacy section: your data → your YNAB → your computer; we're not involved; read the code to verify
- [ ] First-launch Gatekeeper bypass instructions (right-click → Open → Open)
- [ ] Apple Silicon requirement, explicit
- [ ] YNAB API key acquisition steps — verify what's there is current; rewrite if not
- [ ] Actual Budget setup steps (decision: ship with `feat/actual-budget-integration` merged?)
- [ ] Quick start: download DMG, install, first-run model download note (~5GB)
- [ ] Known issues section (any pre-mortem bugs you accept rather than fix)
- [ ] Feedback link → GitHub Issues

### Repo settings
- [ ] Confirm repo is public (or flip it if not)
- [ ] Confirm you're comfortable with all code being readable by strangers
- [ ] *Optional:* "Built by [you]" footer in README pointing at portfolio (job-hunt signal)

### GitHub Release
- [ ] Tag `v0.1.0`
- [ ] Build DMG from the tagged commit
- [ ] Create GitHub Release, attach DMG
- [ ] Release notes: first public beta, privacy line, Gatekeeper instructions,
      Apple Silicon requirement, what works / what's known-broken

---

## 3. Nice-to-have (can ship without)

### UX choice you flagged earlier
- [ ] **"Discard" on errored receipts deletes the original PDF.** Decide:
      keep current behavior (delete file), split into "Skip" (just remove from
      pending) + "Delete file", or add a confirm dialog.

### Defensive code (real bugs, low blast radius)
- [ ] `tauri-plugin-single-instance` — prevent two sidecars watching the same inbox
- [ ] Watcher debounce `setTimeout`s aren't tracked / cleared on `stopWatcher` (`services/watcher.ts`)
- [ ] `response.body.getReader()` not cancelled on AbortError → reader leak (`services/model-manager.ts`)
- [ ] `fs.watch` recovery defensive fix on `inboxExists` false→true transition (Linux portability)

### Refactor / quality
- [ ] Extract `useModelDownload(modelId)` hook so SetupWizard + SettingsView don't reimplement the same flow
- [ ] Type `actualPasswordLength` / `hasYnabApiKey` etc. on `ConfigData` instead of `(config as any)` casts
- [ ] `/setup/test-*` endpoints return HTTP 200 with `{success:false}` on failure — should use proper status codes

### Test debt (12 stale unit tests, you said skip for beta — leaving here for visibility)
- [ ] `services/config.test.ts` — 5 failures, async Keychain loading vs. sync expectations
- [ ] `services/prompt-adapter.test.ts` — 6 failures, default-suffix change
- [ ] `services/budget-actual.test.ts` — 1 failure, splits-builder mock
- [ ] Decision: fix all 12 (~45 min) or `it.skip` each (~5 min)

### CI
- [ ] GitHub Actions workflow: `tsc --noEmit`, `npm test`, `npx playwright test`, `cargo check`. Skipped this session because it gates PRs and you were afk.

### Cosmetic / observability
- [ ] Watcher reports `running: true` even when inbox path doesn't exist (cosmetic; `inboxExists` already separate)
- [ ] Surface parse error details in the UI (currently just "Failed to parse the receipt")
- [ ] Allow viewing failed/in-progress parses, not just successful ones
- [ ] Symlinks: dangling/looped symlinks silently ignored — README hint or UI message
- [ ] esbuild CJS `import.meta.url` warnings (`services/llama-server.ts`, `services/swift-sidecar.ts`)
- [ ] Vite dynamic-import warnings on `@tauri-apps/api/core.js`/`window.js`

### Theoretical / probably defer
- [ ] EventSource reconnect with stale SSE token after sidecar restart (theoretical today)
- [ ] Per-request `https.Agent` for Actual self-signed certs (current scoping is narrowed but not eliminated)

---

## 4. Post-launch (after v0.1.0 is out)

- [ ] Show HN / Substack post once you have 1–2 weeks of beta feedback
- [ ] Restore the 12 unit tests cut for beta
- [ ] Add CI
- [ ] Actual Budget polish: known-limitation no category-group filtering;
      cleared/uncleared transactions on import setting

---

## How to use this doc

- TODO.md is the audit trail (everything ever surfaced, with fix history).
- This doc is the *to-do for shipping v0.1.0*. Items here are pulled from
  TODO.md. When something here is done, mark it `[x]` here AND in TODO.md.
- The pre-mortems live at `tmp/premortem-2026-05-08T13-59-11Z.md` (session
  diff) and `tmp/premortem-2026-05-08T14-36-11Z.md` (committed branch diff).

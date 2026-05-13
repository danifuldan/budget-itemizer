# TODO

## Quality workflow

Standing practices for any change that touches behavior. Apply in order; stop
early when a tier doesn't fit the change.

- **Pre-merge pre-mortem** — run `/premortem` (or `/premortem main..HEAD` for a
  branch) before merging any diff over ~30 lines, any refactor, any async or
  state-machine change, any hook or lifecycle/cleanup change. Loads
  `.github/PREMORTEM.md` and produces three hostile bug reports tied to
  file:line plus the smallest catching test. Output is saved to
  `tmp/premortem-<timestamp>.md`. Skip rules and rationale: see `CLAUDE.md`
  -> "Pre-merge pre-mortem."
- **Unit tests** — for pure logic: `buildReceiptFromLabels`, `buildSplits`,
  prompt-adapter transforms, reducer-shaped hooks.
- **Playwright** — for flows that cross the Tauri boundary or depend on
  rendered DOM transitions (setup wizard, watcher events, model download UI).
- **Property tests** — for invariants that must hold across many inputs:
  split totals must equal receipt total, no negative line items, no rounding
  drift across currencies.
- **Manual smoke** — clean-machine install path before each release; see
  "Clean-machine smoke test" below.

## Public Beta v0.1.0 — Preflight

### Sidecar lifecycle bug (gates beta — users will hit "in use" when deleting/upgrading)
- [x] On app quit, Tauri sends SIGKILL to sidecar server (`src-tauri/src/lib.rs:174` `child.kill()`), which orphans `llama-server` because SIGKILL doesn't propagate through process trees on macOS
- [x] Fix: extract PID from `CommandChild`, send SIGTERM via `libc::kill`, wait ~3s for graceful exit, fall back to SIGKILL
- [x] Belt-and-suspenders: `stopInstance`/`stopAll` in `services/llama-server.ts` now await actual child exit, with 3s SIGTERM → SIGKILL escalation
- [x] Consolidated duplicate signal handlers in `index.ts` — single `gracefulShutdown` awaits llama-server stop then budget-provider shutdown
- [ ] **Verify on rebuild**: install fresh DMG, launch app, quit, then immediately delete the app. Should not see "in use." Check logs for "Sidecar exited gracefully."

### Audit-driven hardening pass (shipped this session)
- [x] Consolidate retry pattern into shared `useRetryableFetch` — migrated `useStatus`, `useConfig`, `useHistory`, `useAccounts`, `useCategories`. All four legacy 3s-forever loops gone.
- [x] SSE event dispatching — extracted `readSSEStream`, added `streamSSEPost`. Both download flows now route through it; `streamParse` shares the parser. Explicit event names beat shape-sniffing.
- [x] TLS scoping — `NODE_TLS_REJECT_UNAUTHORIZED` save/restored around `api.init` instead of permanent process-wide leak. Caveat noted in code: long-lived connections persist with negotiated setting.
- [x] Auth on `/models/{download,cancel-download,delete,activate}`. SSE token gate on `/watcher/events` via auth-protected `/auth/sse-token` endpoint, constant-time token compare.
- [x] Watcher SSE ping loop checks `aborted` flag (audit #9).
- [x] Settings download flow now activates model after download (matches SetupWizard; partial fix for audit #6).

### Test debt (not real bugs — pre-existing stale tests)
Investigated this session. All 12 failing tests in `services/{config,prompt-adapter,budget-actual}.test.ts` are stale assertions from earlier refactors, not regressions. None indicate live bugs.
- [ ] `services/config.test.ts` (5 failures) — implementation moved to async Keychain loading; tests still call sync `getConfig()` and expect secrets to be present. Fix: await `loadConfig()` in beforeEach OR mock the Keychain layer.
- [ ] `services/prompt-adapter.test.ts` (6 failures) — adapter now appends "Respond with valid JSON only" suffixes in default cases; tests still expect untouched passthrough. Fix: update expected message contents.
- [ ] `services/budget-actual.test.ts` (1 failure: "uses buildSubtransactionSplits with tax category resolution") — mock expectation stale after a refactor of how the splits builder is invoked.
- [ ] Pending: pick a path — fix all 12 (~45 min, restores coverage) or `it.skip` each with a TODO referencing this section (~5 min, clears red signal but loses coverage). Recommendation: skip for beta, fix post-launch.

### CI
- [ ] Add a single GitHub Actions workflow that runs `tsc --noEmit`, `npm test` (vitest), `npx playwright test`, and `cargo check`. Without CI, the test discipline erodes. Estimated 20 lines, ~30 min including testing locally with `act` or by pushing.

### Surfaced by isolated-sidecar scenario testing + static code review (round 6)
- [x] **Double-click on Import creates duplicate YNAB transactions.** Fixed: added `claimForImport(filename)` / `releaseImportClaim(filename)` in `services/watcher.ts` that atomically transition pending status `ready/error → importing`. `/import` handler claims before submit; release on failure (`app.ts:355-360`). Second concurrent call sees `importing` status and returns 409. Tests in `services/watcher-claim.test.ts` (6 tests) and `app.test.ts` (2 new tests for the 409 race + the failure-restore path).
- [x] **Silent split plug fabricates "Discount" / "Tax/fees" subtransactions to balance the books.** Fixed: `buildSubtransactionSplits` in `services/budget-provider.ts` now throws a new `ReconciliationError` when splits don't sum to the parent total, instead of inventing a plug. `importReceiptToYnab` in `services/receipt.ts` lets the error pass through (rather than burying it under generic `ReceiptImportError`) so the user sees the actionable message. Tests updated in `services/budget-provider.test.ts` and `services/budget-ynab.test.ts` to assert the throw + that exact-sum splits still work.
- [x] **`findMatchingTransaction` silently picks the last of multiple matches.** Fixed: `services/budget-ynab.ts` now returns `null` when the candidate pool is ambiguous (>1) instead of arbitrarily picking the last. The caller falls through to `createTransaction`, so the user gets a new transaction in YNAB and can manually reconcile any duplicates inside YNAB rather than silently having the wrong existing transaction overwritten. Logged warning when refusing. Tests in `services/budget-ynab-match.test.ts` (7 tests) cover unique match, no match, ambiguous same-account, ambiguous with `matchAcrossAccounts`, deleted-tx filtering, and the cross-account fallback rules.
- [x] **5MB upload limit not enforced on the file-watcher path.** Fixed: `services/watcher.ts` `queueFile` now `fs.statSync`s before reading the file. Oversized files surface as a pending entry with `status: "error"` and a parseError that names the actual size and the limit, so the user sees *why* the file was rejected and can discard it. Both `file-queued` and `file-parsed` events fire so the FE notification path mirrors a normal parse failure. `queueFile` exported for direct testing. Tests in `services/watcher-oversize.test.ts` cover oversize rejection (6MB > 5MB), missing file (vanished between watch and queueFile), and non-PDF skip.
- [x] **DELETE-pending vs. POST-upload race silently destroys data.** Fixed using `detectedAt` as a version token. `services/watcher.ts` `addPending` now refreshes path + detectedAt on re-upload (instead of no-op'ing) so the FE-rendered token diverges from the server state. `app.ts` DELETE handler accepts `?detectedAt=` query: if supplied and the value doesn't match the current entry's detectedAt, returns 409. `src/hooks/usePendingFiles.ts` passes the token on Discard and refetches on 409 to re-surface the (newer) entry. `src/components/PendingList.tsx` and `src/App.tsx` thread the value through. Tests in `app.test.ts` (3 cases: mismatch → 409 + no remove, match → 200 + remove, no token → 200 back-compat) and `services/watcher-readd.test.ts` (2 cases: re-add refreshes detectedAt + filePath, status/receipt preserved across re-add).
- [x] **Pending entries become orphaned when underlying file is removed externally.** Original concern (DELETE returns success even when file already gone) confirmed harmless — the user wanted it discarded, it's gone, no work to do. *But* the related auto-import path was harmful: `services/watcher.ts` `autoImportParsed` called `moveToProcessed(entry.filePath, ...)` outside the success/failure branching, so if the source file had been rm'd externally between parse and post-import move, the rename would throw, fall into the outer catch, and `addRecord` would fire *twice* — once as success (already done) and once as failure (from the catch). History showed contradictory rows for the same import. Fixed by wrapping `moveToProcessed` in its own try/catch with a warn log; the YNAB submission's outcome is the only thing the outer success/failure path reflects now.
- [x] **`killProcessOnPort` is over-aggressive cleanup.** Fixed: `services/llama-server.ts` now validates each PID's command name via `ps -p <pid> -o comm=` and only issues `kill` for processes whose basename is exactly `llama-server`. Anything else (postgres, redis, a dev's own server on those ports) is logged as a refusal. The ps step also narrows the PID-reuse window — if the orphan exited between `lsof` and our action, ps reports a different command and we skip. Switched the source to `import { execSync }` (was a dynamic `require`) so vi.mock can intercept; tests in `services/llama-server-kill.test.ts` cover postgres-on-port (skip), all-unrelated (no kill), PID-reuse (ps fails for one PID, kill issued for the other), and nothing-listening (silent return). `killProcessOnPort` exported for testability.
- [x] **Concurrent `downloadModel` calls can corrupt the partial file.** Fixed: `services/model-manager.ts` now keeps a per-modelId `inFlightDownloads` map. A second call for the same modelId attaches to the existing promise instead of opening a competing write stream. Different models can still download concurrently. Tested in `services/model-manager-download.test.ts` ("coalesces two concurrent calls").
- [x] **No size or hash validation before renaming partial → final.** Fixed: `downloadAttempt` now returns `{ complete, total }` and reports `complete: false` when `downloaded !== total` (premature stream close), so the retry loop reconnects with a Range header and resumes. The first successful response's `existingBytes + Content-Length` is captured as `expectedTotal`; before `fs.renameSync`, we assert `fs.statSync(partialPath).size === expectedTotal` and unlink the partial if it doesn't match. Tested in `model-manager-download.test.ts` ("retries when stream closes prematurely" and "rejects and deletes the partial when downloads can't reach expected size"). SHA verification not added — server-reported size is sufficient given there's no published hash to compare against.
- [x] **`fileStream.close()` is fire-and-forget in download path.** Fixed alongside the size-validation work: surfaced when the test's first attempt's `statSync(partial)` saw 0 bytes because writes hadn't flushed. `downloadAttempt` now constructs a `flushed` promise that resolves on the stream's `finish` event and `await`s it after `fileStream.end()` — both on success and error paths — so the next attempt or the final size check sees the real on-disk state.
- [ ] **Dangling and looped symlinks are silently ignored by the watcher.** Not a crash, but the user sees a "file" in their inbox that the app pretends doesn't exist. Document in README or add a UI hint when a non-readable symlink is in inbox.
- [x] **Verified safe (no fix needed):** corrupted PDFs (truncated, wrong magic, empty, random bytes) — sidecar survives, files queue at error status; oversized 10MB PDF via fs path detected and queued (size enforcement is the issue, not crash); filenames with tabs / leading or trailing dots / literal `\n` — all detected; 200 pre-existing files at startup → all picked up via `processInbox` after inbox switch; `findMatchingTransaction` UTC-date math correctly avoids timezone drift; `reconcileExtraction` already documents its own arithmetic-qty-inference limitations (lines 676-680) — author is aware.

### Surfaced by isolated-sidecar scenario testing (round 5)
- [x] **UX: pending entries persist across `inboxPath` change.** Fixed: `services/watcher.ts` exports `clearAllPending`; `app.ts` `/config` handler calls it inside the existing watcher stop/start cycle whenever `inboxPath` is in the update payload. `processedPath`-only changes do not clear pending (those files are still under the same inbox). Tests in `app.test.ts` cover both cases (inbox change → clear called, processed-only → clear not called).
- [ ] **`fs.watch` recovery after directory delete is darwin/FSEvents-specific.** Verified that on this macOS the watch handle survives `rm -rf` + `mkdir` of its target and resumes detecting events. Not portable behavior — if the app ever runs on Linux/inotify, the watch will be dead after the underlying inode goes. Defensive fix: on `inboxExists` transition `false → true`, explicitly stop+restart the watcher.
- [x] **Verified safe (no fix needed):** burst of 100 files → no losses or duplicates; SIGSTOP/SIGCONT (sleep simulation) → all events buffered; `.crdownload` partial → ignored, rename detected; unicode/space/quote filenames → handled; path traversal on `DELETE /watcher/pending/:filename` → 404 (lookup keys off in-memory map, not user-controlled path); upload validation → oversize/non-PDF rejected, traversal filename basenamed; malformed `/config` payload → Zod strict rejects unknown keys, bad JSON, wrong types; SIGTERM mid-burst → exits in <1s.

### Surfaced by isolated-sidecar scenario testing (round 4)
- [x] **Sidecar crashed on EADDRINUSE when port was bound on a different interface.** `isPortFree` probed `127.0.0.1` while `@hono/node-server` listens on `::` (IPv6 any). A user with anything else on port 3456 — another dev server, a stale process — got a sidecar that crashed at boot. Fixed: probe with no host arg so the test matches actual listen behavior. `index.ts:20`.
- [x] **YNAB rate-limit burn on bad-token + no-stash edge case.** A user who revokes their token AND switches budgets AND drops a burst of receipts before the stash repopulates would hit YNAB N times for N receipts (each parse calls `getAllCategories`, fails, no stash for the new budget id, repeat). Added an exponential-backoff circuit breaker on the YNAB provider: after a failure with no stash to fall back to, refuse subsequent fetches for an increasing cooldown (1s → 2s → 4s → … → 60s cap), reset on success.
- [ ] **No single-instance plugin.** macOS Finder normally prevents two instances of the same .app, but `cargo run` / autostart misfires / a user with two install paths could trigger dual sidecars watching the same inbox — duplicate parses + move races. Add `tauri-plugin-single-instance`.
- [ ] **"Discard" button on errored receipts deletes the original PDF from disk** (`app.ts:430`, `fs.unlinkSync` in `DELETE /watcher/pending/:filename`). For users wanting to clear an error and retry, the source file is now in trash territory. Consider splitting into "Delete file" (current behavior) and "Skip" (remove from pending only).

### Surfaced by isolated-sidecar scenario testing
- [x] **YNAB error message garbled as "[object Object]"** — `wrapYnabError` was using `String(err)` on objects shaped like `{ error: { id, name, detail } }`, which produces "[object Object]" and also broke the substring-match routing (so "401" never matched). Fixed: extract id/name/detail explicitly, route on those. Now users see "YNAB API key is invalid or expired."
- [x] **`POST /config` doesn't restart the watcher when inbox/processed paths change.** The reported state in `/status` updated to show the new path, but the underlying `fs.watch` was still bound to the old directory — files in the new path went undetected. Fixed in `app.ts`: stop+start the watcher when `inboxPath` or `processedPath` is in the update payload.
- [x] **No caching of YNAB categories across parses.** Already fixed before this round. `services/budget-ynab.ts` `YnabBudgetProvider.getAllCategories()` has a 5-min in-memory TTL cache keyed by `(token, budgetId)`, in-flight coalescing so concurrent callers share a single fetch, plus a disk stash for offline fallback and an exponential-backoff circuit breaker after failures. A burst of 50 receipts triggers one network call, not 50.
- [x] **YNAB upfront-fetch dependency** — investigated, kept by design. If YNAB is unreachable the parser refuses to start. The alternative (parse with `[]` categories, fall back to manual assignment) was rejected: a user shouldn't be able to commit a receipt without a solid budget connection, since the cost of misrouted splits is real money in the wrong category. Strong consistency over partial success.
- [ ] **Watcher reports `running: true` even when inbox path doesn't exist.** `fs.watch` quietly tolerates missing paths and recovers when the directory appears later, which is fine for resilience but the status indicator is slightly misleading until then. Cosmetic.
- [x] **`/setup/status` credential exposure** investigated. Returns appApiKey/appApiSecret to unauthed callers. Not a real concern for local-app threat model: any process running as the user can read `~/.config/budget-itemizer/config.json` directly, and CORS blocks browser-page access. By design.

### Audit follow-ups (not in critical-four)
- [ ] Extract `useModelDownload(modelId)` hook so SetupWizard and SettingsView don't re-implement ~95% of the same flow (audit #6).
- [ ] Type `actualPasswordLength` / `hasYnabApiKey` etc. on `ConfigData` instead of `(config as any)` casts (audit #7).
- [ ] `/setup/test-*` endpoints return HTTP 200 with `{success:false}` on failure — should use proper status codes for `apiFetch` retry logic to work (audit #8).
- [ ] EventSource reconnect with stale SSE token after sidecar restart — theoretical today (sidecar lifecycle = FE lifecycle). Re-fetch token on `onerror` if the architecture ever splits.
- [ ] Per-request `https.Agent` for Actual self-signed certs, or explicit user-toggled trust flag — current scoping narrows the blast radius but doesn't eliminate it.
- [x] `progressBufferRef` in `useWatcherEvents` grows unbounded; never cleared on user-discard or server-restart (audit #13). User-discard path was already covered (`removePendingLocal` deletes the entry). Fixed the server-restart leak: added a `useEffect` keyed on `pendingFiles` that prunes any buffer entries whose filename is no longer in the current pending list. After a sidecar restart, the post-reconnect `fetchPending` resync replaces `pendingFiles`, the effect runs, and stale buffer entries for filenames the server lost are swept automatically. `src/hooks/useWatcherEvents.ts`.

### Frontend retry loop (gated beta — surfaced by lifecycle log review)
- [x] `useAccounts` and `useCategories` retried failures every 3s forever — would burn YNAB's 200/hr quota in ~5 min on any persistent error (wrong token, rate-limit, network blip)
- [x] Extracted shared `useRetryableFetch` hook with exponential backoff (3s → 60s cap) and MAX_ATTEMPTS=8 — gives ~4.5 min of trying for startup races, then stops
- [x] Added `ApiError` class in `src/api/client.ts` surfacing status + `Retry-After` so the hook can honor server-provided cooldowns
- [x] Follow-up: backend `wrapYnabError` collapses YNAB 429 into generic 500 — propagate the 429 status + `Retry-After` header through to the frontend so the cooldown is actually usable. Fixed: new `RateLimitError extends BudgetConnectionError` in `services/budget-provider.ts` carries `retryAfterSeconds`. `wrapYnabError` throws it (60s default — YNAB SDK doesn't expose response headers). `app.ts` introduces a `rateLimitOr500(c, err)` helper that maps `RateLimitError` → 429 + `Retry-After`, anything else → 500. Applied at every YNAB-touching endpoint: `/import`, `/budgets`, `/accounts`, `/categories`. The FE's existing `apiFetch` already parses `Retry-After` into `ApiError.retryAfterSeconds`. Test in `app.test.ts` ("surfaces YNAB rate-limit as 429 with Retry-After header") covers the `/import` path; the other endpoints route through the same helper.

### Surfaced by live-YNAB scenario testing (round 8, 2026-05-10) — full pipeline end-to-end verified
**E2E milestone:** First validated parse against intended stack — Walmart PDF → Apple Vision OCR (792 chars) → bundled Llama 3.1 8B label extraction (43s, 100% of llama-server warm-up + parse) → buildReceiptFromLabels → YNAB Test Budget import. Transaction id `8612a1d3` landed with $-36.37 split into 7 Groceries subtransactions, full line-item memos preserved, no reconciliation drift, file moved inbox → processed. **All claims about pipeline correctness through this session were unit-test-and-scenario based; this is the first end-to-end validation against the actual production stack.**

- [x] **`ReconciliationError` user message exposes YNAB milliunits (developer detail) instead of dollars.** Fixed: `services/budget-provider.ts ReconciliationError` constructor now formats milliunits as `$X.XX` (Math.abs + /1000 + toFixed(2)) for the user-facing message. Internal `totalAmount`/`splitSum`/`remainder` fields keep milliunits for code/logging consumers. Test in `services/budget-provider.test.ts`: `"message uses dollar formatting, not raw milliunits"` — asserts `$90.00`, `$100.00`, `$10.00` appear and no 4+ digit numbers leak.
- [x] **`/import` returns generic `"Failed to import the receipt"` for actionable failures.** Fixed: `services/receipt.ts ReceiptImportError` now walks `options.cause` and appends the cause's message ("Account not found", "Category not found", etc.) when present. The HTTP handler's `err.message` thus surfaces the real reason. 4 new tests in `services/receipt.test.ts` cover Error cause, string cause, no cause fallback, and that `err.cause` is preserved for code consumers.
- [x] **Watcher not auto-started on `isSetupComplete` false→true transition.** Fixed: `app.ts /config` handler now captures `wasSetupComplete = isSetupComplete()` before `saveConfig`, then `nowSetupComplete = isSetupComplete()` after. If `!wasSetupComplete && nowSetupComplete && !getWatcherStatus().running`, calls `startWatcher()`. Sits alongside the existing inbox/processed-path stop+start logic. Tests in `app.test.ts`: "starts the watcher on isSetupComplete false→true transition" and "does NOT start the watcher when setup was already complete." **NOT yet verified live on a fresh install** — should be re-checked in the clean-machine smoke test.
- [x] **Verified live (specific inputs):** Walmart order PDF (one file, `Order details - Walmart.com.pdf`, $36.37 with 7 line items, all Groceries) parsed against bundled Llama 3.1 8B; tx landed in YNAB Test Budget with reconciled splits and full memos; file moved to processed. **NOT yet verified against other formats** — Amazon, Costco, Target, returns, multi-day orders, tax-bearing receipts, fee-bearing receipts, discount-bearing receipts. ReconciliationError throws on a synthetic mismatched-split payload (R8-1, with milliunit-leak message bug). Idempotency claim on concurrent `/import` with same `sourceFilename` — one 200, one 409 against a single live YNAB write (R8-6, one race only).
- [x] **$0 transaction accepted** — verified the call returns 200 and a $0 tx lands in YNAB. Not verified whether that's the *right* UX (FE could reject; YNAB will happily store the $0). Logging as known behavior, not "safe."
- [x] **Empty `lineItems` with non-zero total accepted** — creates a single-line YNAB tx with no subtransactions. Verified the call succeeds. Did NOT verify whether this is the right behavior for a parse that failed to extract line items — current behavior silently flattens the receipt into a single uncategorized line, which is a silent quality regression for the user.
- [x] **Rapid duplicate `/import` (no sourceFilename) silently merges via findMatchingTransaction.** Fixed with a probabilistic "most likely" matcher. **Final semantics:**
    - **Hard filters (unchanged):** amount-exact, date ±3 days, account-per-`matchAcrossAccounts`-setting.
    - **Splits-similarity tier system** (the key safety mechanism):
      - **Tier 0** — candidate has existing splits with ≥0.95 multiset-Jaccard similarity to the receipt's splits. Almost certainly a re-import; safe idempotent overwrite. Beats unsplit.
      - **Tier 1** — candidate has no existing splits. Safe attach, no prior data to lose.
      - **Tier 2** — candidate has existing splits with 0.5–0.95 similarity. Likely the same receipt edited slightly.
      - **Ineligible** — candidate has existing splits with <0.5 similarity. Overwriting would destroy unrelated prior import data; skip.
    - **Within a tier**, sort by: vendor-match (yes>no), splits-similarity (higher better), closest date, freshness (uncleared > cleared > reconciled), unapproved, no-memo. Always picks the top one if any candidate is eligible; never refuses except when all candidates are ineligible (which only happens when every candidate has existing splits with <0.5 similarity — i.e., we'd be destroying unrelated user data).
    - `services/budget-provider.ts` exports `vendorMatches` (normalized-substring) and `splitsSimilarity` (multiset Jaccard).
    - **Tests:** `services/budget-provider.test.ts` adds 7 cases for splitsSimilarity (identical → 1.0, disjoint → 0.0, empty sets, multiset semantics, partial overlap landing in each tier band). `services/budget-ynab-match.test.ts` adds 4 cases for the new tier logic (high-similarity beats unsplit, low-similarity skipped in favor of unsplit, all-ineligible returns null, ambiguous same-day same-vendor unsplit picks deterministically). `services/budget-actual.test.ts` updated for the new signature. **Caveat:** NOT verified live against the running app — covered by 325 unit + integration tests but no live YNAB run yet.

### Surfaced by exploratory scenario testing (round 7, 2026-05-09)
- [x] **`POST /watcher/inbox` uploads stay in `status: "parsing"` forever — zombie pending entries.** Fixed: replaced the `addPending(safeFilename, destPath)` call in `app.ts /watcher/inbox` with `void queueFile(destPath, !!config.watcherAutoImport)`. queueFile is the same path the file watcher takes via `fs.watch → enqueue → drain → processFile → queueFile`; calling it directly drives the actual parse pipeline. Fire-and-forget because queueFile already routes errors into the pending entry's `parseError`. fs.watch's later fire is a no-op (queueFile's `pendingFiles.has` early-return covers it). Test in `app.test.ts` ("triggers queueFile (drives the parse), not just addPending") asserts queueFile is called with the destination path + autoImport flag and addPending is NOT called.
- [x] **`/config` accepts unbounded string lengths.** Fixed: `app.ts configUpdateSchema` now has `.max(N)` on every string field. PATH_MAX=4096 for inboxPath/processedPath; URL_MAX=2048 for llmEndpoint/actualServerUrl; SECRET_MAX=8192 for tokens/passwords; NAME_MAX=256 for embeddedModel/llmTextModel/ynabBudgetId/defaultAccount/actualSyncId/category-group entries. Array fields (`hiddenAccounts`, `ynabCategoryGroups`) capped at 256 entries. Tests in `app.test.ts` cover the rejection (5000-char inboxPath → 400, saveConfig not called) and the happy path (normal-length inboxPath → 200).
- [x] **Verified (specific inputs, single-shot):** path-traversal in `DELETE /watcher/pending/:filename` returned 404 against `..%2F..%2Fetc%2Fpasswd`, `../etc/passwd`, `foo%2Fbar.pdf`, empty filename, `foo%00.pdf` (4 cases tested, all 404 because lookup keys off the in-memory map); upload filename `$(rm -rf ~).pdf` sanitized to `__rm_-rf___.pdf` (one case); upload boundary at exactly `MAX_FILE_SIZE` (200) and one byte over (400) (two boundary cases); CORS preflight from `evil.example.com` returned 204 with no `Access-Control-Allow-Origin` header (one origin tested); auth header CR/LF injection rejected by curl + Node HTTP layer (one case); 100KB `Authorization` header returned 431 (one length); `Content-Length` lies → 400 (one case); `__proto__` / `constructor` keys in `/config` → Zod strict rejects (one case); deeply nested `/config` payload with 1000-level nesting → 400 (one depth); `NaN` in `/import` body → JSON parser rejects; HEAD with auth → 200, without → 401; `/watcher/start` while running → idempotent (one call); `/watcher/stop` twice → idempotent; `/models/download` unknown modelId → 400 (one bad ID); `/models/cancel-download` with nothing in flight → 200; `/models/activate` not-yet-downloaded → 400; `/models/delete` removes both `.partial` and final file when present (one delete); `/history?limit=` with `-1`, `DROP TABLE`, `999999` → parseInt fallback to 50, no crash (three values).
- [x] **Rapid create-then-delete in inbox — NO zombie at 2-second cycles.** Tested with `cp; rm; cp; rm` loops separated by ~0s within the iteration but the 5-iteration sequence took ~2 seconds total. The fs.watch debounce is 1 second; my cycles were slower than the debounce. **Did NOT test sub-debounce racing** (create-rm-create within the same 1s window) — a real race could exist there and would not have been caught.
- [x] **10 concurrent `/config` budgetProvider switches — no 500s, final reported state consistent.** Sent 10 simultaneous switches via `&`-backgrounded curl, then queried `/setup/status` once: returned `budgetProvider: "actual"` (the last write). **Did NOT inspect the in-memory `_cached`/`_cachedType` state in the running sidecar** — there could be an orphan provider instance whose `shutdown()` raced and was silently dropped. Verified the externally-observable response only.

### Pre-mortem findings (all fixed; from `tmp/premortem-2026-05-08T13-59-11Z.md` + `…14-36-11Z.md`)
- [x] **HIGH: llmReady error swallowed → permanent splash dead-end.** Code-fix landed: `services/llama-server.ts` tracks `lastStartErrors` per slot and exposes `getLlamaServerStartError()`. `app.ts /status` now returns `llmStartError: string | null` when builtin provider's last start failed. New `src/components/LlmStartErrorScreen.tsx` renders a recoverable error UI with an "Open Settings" button; `App.tsx` routes to it when `llmStartError` is set (Settings/setup views exempt). **Verified via:** two `app.test.ts` cases — `/status` returns the error string when getLlamaServerStartError mock returns one (builtin path), and null when provider is custom. **NOT verified live:** the FE rendering `LlmStartErrorScreen` against a real failed llama-server start has never been observed — triggering a real failure requires a 180s `pollHealth` timeout or a deliberately corrupted model file, neither of which was done this session. The FE component's visual correctness in this state is assumed, not seen.
- [x] **HIGH: clearAllPending during in-flight import orphans the file in the old inbox.** Two-part fix. (1) `services/watcher.ts clearAllPending` now preserves entries with `status: "importing"` or `status: "parsing"` so their in-flight handlers can complete the normal cleanup chain (moveToProcessed + removePending). (2) `app.ts /import` snapshots `pending.filePath` before the YNAB await as defense-in-depth so cleanup runs even if the entry is wiped mid-flight. 3 new tests in `services/watcher-claim.test.ts` cover importing-preserved, parsing-preserved, and ready/error-still-dropped.
- [x] **MEDIUM: hidden Delete History button is keyboard-focusable.** Fixed: `src/components/HistoryRow.tsx` toggles `tabIndex={revealed ? 0 : -1}` and `aria-hidden={!revealed}` on the swipe-only delete button. Test in `src/components/HistoryRow.test.tsx` asserts the collapsed state has `tabindex="-1"` and `aria-hidden="true"`.
- [x] **MEDIUM: SetupWizard `goNext` ignores `saveSetup` return value.** Fixed: `src/components/SetupWizard.tsx goNext` now reads the boolean each `saveSetup` call returns; on `false`, sets `advanceError` (rendered as a `wizard-banner-warning`) and does not advance. Cleared on every Next attempt.
- [x] **MEDIUM: second concurrent `/models/download` HTTP call gets silent SSE.** Fixed: `services/model-manager.ts inFlightDownloads` now stores `{ promise, subscribers: Set<ProgressCallback> }`. The first caller starts `doDownload` with a fan-out callback that snapshots and invokes every subscriber on each tick; subsequent callers add their `onProgress` to the set and await the same promise. Per-subscriber try/catch so a closed SSE pipe in one caller doesn't block the others. New test in `services/model-manager-download.test.ts` asserts both `onProgressA` and `onProgressB` receive the terminal `done: true` event.
- [x] **MEDIUM: progressBufferRef pruned during optimistic Discard before 409-restore.** Fixed: `src/hooks/useWatcherEvents.ts` removed the over-aggressive `useEffect[pendingFiles]`. New `pruneStaleBuffers(validFilenames)` exported instead, called from `src/hooks/usePendingFiles.ts fetchPending` after server-state replacement (the actual leak case from sidecar restart). `removePendingLocal` no longer deletes the buffer on optimistic remove — backend events (file-parsed, file-processed) still handle their own cleanup. Wired through `App.tsx`.

### Related lifecycle issues surfaced by audit (not blocking beta)
- [x] **Cancel during model-download retry backoff hangs up to 30s.** Surfaced by the second-pass pre-mortem (`tmp/premortem-2026-05-08T14-36-11Z.md`). The retry loop's exponential backoff `await new Promise((r) => setTimeout(r, backoff))` ignored the AbortSignal — after 5 consecutive no-progress retries the sleep grows to 30s, so a Cancel click would sit there waiting it out. Fixed: the sleep now races the abort signal via `setTimeout` + `signal.addEventListener("abort", ...)` and returns immediately when cancelled; on resume, a fresh `signal.aborted` check exits the loop with a `cancelled` progress event. `services/model-manager.ts:256-279`. Test in `services/model-manager-download.test.ts` `"cancel during a retry backoff returns immediately instead of waiting out the sleep"` — schedules `cancelDownload()` 100ms into a 1000ms backoff, asserts the call returns in under 500ms, no second fetch fires, and `onProgress` receives `error: "cancelled"`.
- [ ] `services/watcher.ts` — debounce setTimeouts in `fs.watch` callback aren't tracked or cleared on `stopWatcher()`; can fire on closed watcher
- [ ] `services/model-manager.ts` — `response.body.getReader()` not cancelled on AbortError; reader leak
- [ ] `index.ts` — `process.on("exit", ...)` cleanup is now gone (removed from old loop); `exit` handler must be sync, so we can't await there. Acceptable since SIGINT/SIGTERM cover Tauri's quit path, but worth noting if the process ever dies via uncaught exception

### Clean-machine smoke test (do FIRST — gates everything else)
- [ ] Wipe local: delete app from /Applications, delete `~/.config/budget-itemizer/`, delete `~/.config/budget-itemizer/models/`
- [ ] Install from latest DMG, complete setup as if a stranger
- [ ] Time-box to 30 minutes; note every point of confusion or failure
- [ ] Fix any blockers surfaced before continuing the rest of this list

### App
- [x] Pin version to `0.1.0` (already aligned across `package.json`, `tauri.conf.json`, `Cargo.toml`)
- [x] Add "Report a bug" link in Settings → opens GitHub Issues new-issue URL
- [x] "Why?" link on YNAB token field (already implemented in SetupWizard, points to README FAQ anchor)
- [x] "Delete & re-download" link in setup wizard's Model Ready state (in addition to existing Settings → Models → Delete)
- [x] Cancel + Cancel & delete buttons during model download (both SetupWizard and Settings)
- [x] Model name + open-model framing in setup wizard subtitle, link to llama.com

### README
- [ ] Header: "Public Beta — Apple Silicon Macs only, unsigned"
- [ ] Privacy section (your information → your YNAB → your computer; we're not involved; read the code to verify)
- [ ] First-launch Gatekeeper bypass instructions (right-click → Open → Open)
- [ ] Apple Silicon requirement, explicit
- [ ] YNAB API key acquisition steps — verify what's there is current; rewrite if not
- [ ] Actual Budget setup steps (if shipping with that branch merged)
- [ ] Known issues / "what's broken or wonky right now"
- [ ] Feedback → link to GitHub Issues
- [ ] Quick start: download DMG, install, first-run model download note (~5GB)

### Repo
- [ ] Confirm repo is public (or flip it if not)
- [ ] Confirm you're comfortable with all code being readable by strangers

### Release
- [ ] Tag `v0.1.0`
- [ ] Create GitHub Release, attach DMG
- [ ] Release notes: first public beta, privacy line, Gatekeeper instructions, Apple Silicon requirement, what works / what doesn't

### Post-launch (not blocking)
- [ ] Add a brief "Built by ___" footer line in README pointing to your portfolio (signal for the job hunt)
- [ ] Consider a Show HN / Substack post once you have 1-2 weeks of beta-tester feedback in hand

## Bugs / Observability
- [ ] Allow viewing failed/in-progress parses (not just successful ones)
- [ ] Surface parse error details in the UI (not just "Failed to parse the receipt")
- [ ] Allow clicking into a failed parse to see the receipt and what went wrong
- [ ] Write logs to a file so they're accessible when running as a built app (not just console.log)

## Actual Budget Integration (feat/actual-budget-integration branch)
- [x] BudgetProvider interface + shared split utilities
- [x] Extract YNAB provider
- [x] Add Actual Budget config fields
- [x] Implement Actual Budget provider
- [x] Update backend endpoints
- [x] Update SetupWizard
- [x] Update SettingsView
- [x] Update watcher error handling
- [x] Integration test: YNAB still works (manual)
- [ ] Integration test: Actual Budget end-to-end (manual, needs running Actual server)
- [ ] Known limitation: no category group filtering for Actual
- [ ] Setting: clear/unclear transactions on import (currently always uncleared)

## Build Warnings
- [ ] esbuild CJS `import.meta` warnings in `services/llama-server.ts` and `services/swift-sidecar.ts` — both use `import.meta.url` which is empty in CJS output format; runtime fallback exists but build is noisy
- [ ] Vite dynamic import warnings: `@tauri-apps/api/core.js` and `@tauri-apps/api/window.js` are both statically and dynamically imported, preventing chunk splitting

## Code-quality refactors deferred from 2026-05-12 adversarial review

Full findings: `tmp/code-review-adversarial-2026-05-12.md`. The cheap-sweep tier was executed in the same session (dead code + provider abstraction strip + mid-file imports + ConfigData typing + comment sweep + swift-sidecar zod schema). These items are explicitly deferred — they need dedicated planning sessions, not "while you're at it" passes. Each has the report's section ID for cross-reference.

### Medium refactors (low-to-medium risk)
- [ ] **CODE-1** — `services/budget-actual.ts` has 21 `as any` casts at the @actual-app/api boundary because the SDK ships no types. Add `services/budget-actual.types.ts` with `ActualAccount`, `ActualCategory`, `ActualPayee`, `ActualSubtransaction`, `ActualTransaction`, `ActualBudget` interfaces. Replace casts. Removes silent drift if the SDK reshapes a return type. ~40 line edits.
- [ ] **CODE-7** — `services/budget-ynab.ts:38–47` reaches into the YNAB SDK's private `_budgets`/`_transactions` fields to inject the 30-second timeout middleware. A minor-version bump can silently break this and re-introduce hang risk. Replace with explicit `withMiddleware(addTimeout).getXxx(...)` at each callsite (~5 callsites, ~25 line edits).
- [ ] **CODE-5** — `services/gen-ai.ts:findAmountByLabel` has three search strategies (same-line, wider, embedded) with overlapping behavior. Simplify into one ordered scan. ~50 line edits, medium risk; the gen-ai tests should pin behavior. **Conflicts with STRUCTURE-1 (same file being split) — run after STRUCTURE-1 lands, targeting the new `services/text/amount-extract.ts` location.**
- [ ] **CODE-8** — `src/hooks/useStatus.ts` runs `useRetryableFetch` AND a `setInterval` poll loop simultaneously — they race during error/recovery. Consolidate by extending `useRetryableFetch` with an `intervalMs` option and deleting the second timer source.

### Big refactors (need dedicated planning sessions, each its own PR)
- [ ] **STRUCTURE-1** — Plan at `tmp/plan-structure-1-gen-ai-split.md`. Implementation agent dispatched 2026-05-13 (branch `structure-1-gen-ai-split`).
- [ ] **STRUCTURE-2** — Plan at `tmp/plan-structure-2-settings-wizard-dedup.md`. Implementation agent dispatched 2026-05-13 (branch `structure-2-settings-wizard-dedup`).
- [ ] **STRUCTURE-4** — Plan at `tmp/plan-structure-4-app-split.md`. Implementation agent dispatched 2026-05-13 (branch `structure-4-app-split`).
- [ ] **CODE-12** — Plan at `tmp/plan-code-12-reducer-cleanup.md`. Implementation agent dispatched 2026-05-13 (branch `code-12-reducer-cleanup`).
- [ ] **CODE-3** — `services/shared-types.ts` and `src/api/types.ts` both define `Receipt` / `ReceiptLineItem` / `ImportRecord` separately. They're currently identical but maintained independently. Move to `shared/types.ts` at repo root, configure `tsconfig.json` paths, re-export from both sides. ~40 line edits. **Conflicts with STRUCTURE-1 import paths — run after STRUCTURE-1 lands.**

### Custom Semgrep rules (optional, ELI5 primer at `SEMGREP-RULES.md`)
- [ ] Recommended rules to consider adding: `writeRestrictedFile` invariant; `execSync`-with-template-string prohibition; filename-sanitization at upload boundaries.
- [ ] If/when added: live in `.semgrep/`; gate via pre-commit hook or GH Action.

### Apple Developer signing + Tauri auto-update
- [ ] `tauri-plugin-updater` is wired in. Keypair lives at `~/Documents/Developer/budget-itemizer/updater.key` (regenerated 2026-05-13 with a real password; old `~/.tauri/budget-itemizer/` key was thrown away). Public key in `tauri.conf.json` updated. Each release after v0.1.0 needs the signed-build flow from `RELEASE-UPDATER.md`.
- [ ] Apple Developer ID signing + notarization ($99/yr) before any wider distribution. Without it, every install hits Gatekeeper warning on first run.
- [x] **Updater key password issue resolved (2026-05-13).** Root cause: the Tauri signer's password unlock failed for both `--ci`-generated and `--password ""`-generated keys, so empty-password keys are unusable. Worked around by generating with an interactive real password. Separately discovered: the signer's path argument silently failed to write to `~/Library/Mobile Documents/com~apple~CloudDocs/...` (the canonical iCloud Drive path) even though the CLI reported success — likely the literal tildes in `com~apple~CloudDocs` tripped its path parser. Final location is `~/Documents/Developer/budget-itemizer/`, which has no spaces/tildes and writes cleanly. Password is in 1Password under "Budget Itemizer updater key"; key is backed up via iCloud Drive (Documents sync) per the README in that folder.
- [ ] Verify gear-icon update-available dot renders correctly (added to App.tsx + App.css, not yet tested behaviorally — requires an actual "Update available" state to trigger).

### Smoke tests (release-gate, "no manual interaction" goal)

Per the 2026-05-12 release-readiness discussion. Two tiers, both required before the manual "open the app and click around" check goes away.

#### Tier A — Synthetic-fixtures smoke (in-repo, public)
- [x] Generate 3-5 synthetic receipt PDFs (Walmart-shaped, Costco-shaped, Amazon-shaped, plus a "no-line-items" edge case). Plausible format, FAKE merchant names + line items + addresses. No PII. → `smoke/fixtures.ts`, 4 fixtures.
- [x] `smoke/use-path.ts` — runs against a fresh sidecar on a non-prod port. Per fixture: POST /parse-image/stream, read SSE events, assert parsed Receipt matches a committed JSON snapshot. NO YNAB write — this tests the parse pipeline shape only.
- [x] `smoke/fixtures/` directory: PDFs + expected-output JSON snapshots.
- [x] npm script `smoke:use-path` invokes the test config. NOT part of `npm test` (slow, has its own side effects on a temp sidecar).
- [x] Document in RELEASE.md as a mandatory step. → see "Pre-release smoke" section in RELEASE.md.

#### Tier B — Personal smoke (private, off-repo)
- [ ] Decide on storage location for personal fixtures: `~/Documents/budget-itemizer-private/` synced to iCloud Drive, OR a private GitHub repo, OR `~/budget-itemizer-smoke/` local-only.
- [x] Personal runner script reads fixtures via env var `BUDGET_ITEMIZER_SMOKE_FIXTURES=/path/...`. Tests against the user's YNAB **Test Budget** (NOT real budget). → `smoke/personal.ts`.
- [x] Teardown deletes the test-budget transactions it creates so the test budget stays clean. → memo-marker approach, queries last 30 days for tx with `[SMOKE <runId>]` prefix.
- [ ] Only the user runs this. Document in a personal note, not the public README.

#### Fresh-install smoke (separate from Tier A / B)
- [x] `smoke/fresh-install.ts` — spawns a sidecar with an empty isolated HOME (no config, no models, no Keychain), drives the wizard via HTTP POSTs, asserts setup transitions correctly. 5 checks; ~10s. Used in place of the backup/restore approach to avoid touching the user's real Keychain.

### Personal-data / secrets storage patterns (not in public repo)

Per the 2026-05-12 discussion. Pick a pattern per artifact:
- [ ] **Updater private key** (`~/.tauri/budget-itemizer/updater.key`) → 1Password secure note. If lost, signed updates to existing installs are unrecoverable — back up.
- [ ] **YNAB API token + Actual server creds** → already in macOS Keychain. Time Machine to encrypted external backs up Keychain automatically. Verify Time Machine is enabled and target is encrypted.
- [ ] **Personal smoke fixtures (real-receipt PDFs)** → private location of choice. iCloud Drive private folder is the lowest-friction; private GitHub repo if you want version control + cross-machine sync.
- [ ] **Working-state config / `.env.local` per machine** → already `.gitignore`'d. No special handling.
- [ ] **Drafts / portfolio writeups** → already gitignored at `docs/`. Time Machine handles backup.

### RELEASE.md whole-flow checklist
- [x] Expand the existing `RELEASE.md` to cover the full pre-release flow: version bump → run Tier A smoke → run Tier B smoke (personal) → fresh-install smoke (personal) → signed build → sign manifest → gh release create → verify endpoint returns latest.json → install on a separate test Mac (or VM) and observe update-available dot. → see "Pre-release smoke" section in RELEASE.md.

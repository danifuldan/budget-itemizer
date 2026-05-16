# Budget Itemizer — Working Notes for Claude Code

## Pre-merge pre-mortem

Before merging any non-trivial change, run the pre-mortem:

```
/premortem
```

Or, against a range:

```
/premortem main..HEAD
```

This loads `.github/PREMORTEM.md` and applies it to the current diff. The
prompt forces a hostile review and produces three plausible 24-hour-after-ship
bug reports, each tied to a specific file/line and the smallest test that
would have caught it. Output is also written to `tmp/premortem-<timestamp>.md`.

### When to run it (load-bearing)

- Any diff over ~30 lines.
- Refactors, regardless of size — extracting hooks, renaming derived flags,
  consolidating duplicated logic. This codebase's recurring bug class is
  refactor-induced behavioral drift.
- Async logic changes: new awaits, new `.catch` handlers, new
  `AbortController` wiring, new Promise chains.
- State-machine or status-flag changes (`loaded`, `done`, `status === "..."`).
- Cleanup/lifecycle changes: `useEffect` returns, `fs.watch`, `setInterval`,
  signal handlers, sidecar shutdown paths.
- Hook changes — especially anything touching `useRetryableFetch`, `useStatus`,
  `useWatcherEvents`, or other shared hooks consumed by multiple views.

### When to skip it (overkill)

- Pure typo / comment / doc-only changes.
- README, TODO.md, asset, or icon updates.
- Single-line clarifications (renames inside one function with no API change,
  log message wording, copy edits in JSX strings).
- Version bumps and dependency-only changes that already have tests.

If in doubt, run it. It costs one prompt; the cost of skipping it on the wrong
diff is a same-day hotfix.

### What it complements (not replaces)

The pre-mortem is one of the standing quality practices alongside unit tests,
Playwright, and (where applicable) property tests. See `TODO.md` ->
"Quality workflow." It catches the class of bugs tests miss: behavioral drift
from refactors, ordering changes in derived flags, swallowed async errors —
the bugs nobody wrote a test for because nobody knew the old behavior was
load-bearing.

## Testing requirements (load-bearing)

These exist because a real money-correctness bug (`STREAM_DONE` showed
provisional streamed amounts instead of reconciled ones) shipped undetected:
the reducer — the project's #1 documented bug surface — had **zero** tests,
and the suite only ever asserted "valid input -> success."

1. **Every reducer action has a test asserting its state transition.**
   `reducer`, `AppState`, `initialState` are exported from `src/App.tsx`
   for this. A new or changed reducer case is not done until a test folds
   real actions over `initialState` and asserts the resulting state.

2. **Test the disagreement, not the happy path.** For any merge /
   reconcile / transform, feed *conflicting* inputs and assert which one
   wins. "Valid in -> valid out" does not test a reconciliation; "streamed
   9.99 vs reconciled 12.00 -> screen shows 12.00" does.

3. **Pre-mortem probes are executed, not reasoned.** For state-machine /
   reducer diffs, the pre-mortem's "smallest catching test" must be
   written as a real test and run before the change is called done.
   Report the actual pass/fail output. The follow-on regression in the
   first `STREAM_DONE` fix (deleted line resurrected) was caught only
   because the probe was executed instead of argued.

4. **For any "replace X with Y" diff, test what the old code preserved.**
   Wholesale-replace is the recurring failure (pattern 1). Ask "what did
   the old behavior keep that the new one discards?" and make that a test
   (e.g. a user edit/deletion made mid-stream survives completion).

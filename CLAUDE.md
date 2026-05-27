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

## Backlog discipline (enforced by pre-commit hook)

`docs/TODO.md` is a live working set, not a journal. Four sections
(`NOW` / `NEXT` / `LATER` / `ACCEPTED`); resolved items get DELETED, not
checked; ACCEPTED entries carry a `Re-review: YYYY-MM-DD` line.

A pre-commit hook (`scripts/triage-todo.sh`) blocks commits when the file
drifts: any `[x]` entries, any ACCEPTED `Re-review` date in the past, or
NOW with more than 2 items. Suspect framings ("rare and bounded," "fix
only if it bites," etc.) are flagged informational. Bypass for a one-off:
`git commit --no-verify`.

**One-time install on a new clone:**

```
ln -sf ../../scripts/triage-todo.sh .git/hooks/pre-commit
```

## Decision log

`docs/DECISIONS.md` is an append-only log (newest at top) for non-trivial
decisions that aren't already captured by a git commit — alternatives
considered, process choices, strategic / scope calls, paused-work context.
Entry shape: title with date, **Context**, **Considered**, **Decided**,
**Consequences**. 5-15 lines each.

When to write one: any decision where someone (future you, future me) might
reasonably ask *"why did we do X instead of Y?"* and the answer isn't
already in git or a commit message. Reversing a prior decision means a
follow-on entry, not editing the old one — readers should be able to see
the path. If in doubt, write it: cost of an extra entry is one paragraph;
cost of skipping is re-litigating the same call months later.

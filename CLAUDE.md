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

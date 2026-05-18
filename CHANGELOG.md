# Changelog

Notable user-facing changes. Newest first.

## [0.3.0] — unreleased (first public beta)

First public build. Highlights from the hardening pass that preceded it:

### Fixed — money correctness
- Gift-card / store-credit lines are no longer silently dropped on import;
  the split now reconciles to the receipt total.
- The review screen shows the reconciled line amounts, not the
  provisional ones streamed while parsing.
- Auto-import and a manual import of the same receipt can no longer
  produce two transactions; retries after an interrupted import are
  deduplicated by YNAB instead of duplicating.

### Fixed — reliability
- A receipt dropped while the AI model is still warming up no longer
  hangs forever if the model fails to start.
- A second, different receipt that happens to share a filename (e.g.
  Amazon's `Order.pdf`) is no longer silently skipped.
- Dropping a receipt into the app while one with the same name is already
  in the inbox no longer overwrites or loses either file.
- A receipt you navigate away from mid-parse no longer reappears or
  sticks on "Parsing…" forever.
- Switching budgets/credentials no longer lets an in-flight import write
  to the previous budget.

### Changed
- Actual Budget support is temporarily removed from this build while its
  setup flow is reworked; YNAB only for now.

[0.3.0]: https://github.com/danifuldan/budget-itemizer/releases

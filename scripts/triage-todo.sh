#!/bin/bash
# Backlog-discipline audit for docs/TODO.md.
#
# Installed as a pre-commit hook so every commit catches drift without
# anyone having to remember to run it. See project CLAUDE.md for the
# one-line install.
#
# Rules (block commit):
#   1. No `[x]` entries — resolved items get DELETED, not checked. Git is
#      the journal.
#   2. ACCEPTED entries with a "Re-review: YYYY-MM-DD" line in the past
#      must either be re-justified (push the date forward, with a note
#      saying why it still holds) or moved to NEXT.
#   3. NOW section has at most 2 top-level items — concentration is the
#      rule. Demote overflow to NEXT.
#
# Informational (never blocks):
#   - Suspect framings ("rare and bounded", "fix only if it bites", etc.)
#     are flagged for re-challenge on next read.
#
# Bypass for a legitimate one-off: `git commit --no-verify`.

set -e

TODO="docs/TODO.md"
if [[ ! -f "$TODO" ]]; then
  exit 0  # no TODO to audit
fi

BLOCK=0

# --- Rule 1: no [x] items ----------------------------------------------------
CHECKED=$(grep -nE '^[[:space:]]*-[[:space:]]\[x\][[:space:]]' "$TODO" || true)
if [[ -n "$CHECKED" ]]; then
  echo "" >&2
  echo "✗ docs/TODO.md has [x] entries — delete them; git is the journal." >&2
  echo "$CHECKED" | head -10 | sed 's/^/  /' >&2
  BLOCK=1
fi

# --- Rule 2: ACCEPTED items have a non-past Re-review date -------------------
TODAY=$(date -u +%Y-%m-%d)
EXPIRED=$(awk -v today="$TODAY" '
  /^## ACCEPTED/ { in_accepted=1; next }
  /^## / && in_accepted { in_accepted=0 }
  in_accepted && /Re-review:/ {
    if (match($0, /[0-9]{4}-[0-9]{2}-[0-9]{2}/)) {
      d = substr($0, RSTART, RLENGTH)
      if (d < today) {
        printf "  line %d (Re-review %s, today %s)\n", NR, d, today
      }
    }
  }
' "$TODO")
if [[ -n "$EXPIRED" ]]; then
  echo "" >&2
  echo "✗ ACCEPTED entries past their Re-review date — re-justify or move to NEXT:" >&2
  echo "$EXPIRED" >&2
  BLOCK=1
fi

# --- Rule 3: NOW has ≤ 2 top-level items -------------------------------------
NOW_COUNT=$(awk '
  /^## NOW/ { in_now=1; next }
  /^## / && in_now { in_now=0 }
  in_now && /^-[[:space:]]/ { c++ }
  END { print c+0 }
' "$TODO")
if (( NOW_COUNT > 2 )); then
  echo "" >&2
  echo "✗ docs/TODO.md NOW has $NOW_COUNT items; rule is 0-2 in flight. Demote some to NEXT." >&2
  BLOCK=1
fi

# --- Informational: suspect framings (warn only) -----------------------------
SUSPECT=$(grep -niE 'rare and bounded|same trade-off|far less harmful|fix only if it bites|intentional, by design' "$TODO" || true)
if [[ -n "$SUSPECT" ]]; then
  echo "" >&2
  echo "ℹ docs/TODO.md contains suspect framings — re-challenge on next read:" >&2
  echo "$SUSPECT" | head -5 | sed 's/^/  /' >&2
fi

if (( BLOCK == 0 )); then
  exit 0
fi

echo "" >&2
echo "Commit blocked by docs/TODO.md hygiene rules. To bypass: git commit --no-verify" >&2
exit 1

# Semgrep custom rules — designer's edition

Plain-English explanation of what Semgrep is, what "custom rules" are, and which ones make sense for Budget Itemizer. Written for someone who doesn't write code as their job. The technical primer (with copy-pasteable YAML) lives at `tmp/semgrep-custom-rules-primer.md`.

## What is Semgrep, in one sentence

A program that **reads your code and yells if it sees patterns you told it are bad.**

That's it. It doesn't understand what the code *means*. It just notices patterns — like a spell-checker, but for code patterns instead of words.

## Why this matters for AI-assisted code

You've been using Claude to write most of this app. The research showed AI code has roughly **a 45% bug rate** and Claude's own security review only catches about 14% of issues. Semgrep is different:

- **Deterministic.** Same code in, same warnings out. Every single time. Claude is non-deterministic — it might flag something Tuesday and miss it Wednesday.
- **Cheap.** Runs in 30 seconds.
- **Catches different things.** AI review and Semgrep find *different* kinds of bugs, so running both is much stronger than either one alone.

The catch: Semgrep's *built-in* rules are written by other people for general code. They don't know about *your* code's specific habits. That's what custom rules are for.

## What a custom rule actually is

Imagine you wrote a one-line note for code reviewers:

> "When you see somebody calling `writeFileSync` on a file inside the user's config folder, stop them. They should be using our `writeRestrictedFile` helper instead, otherwise the file gets sloppy permissions."

A Semgrep custom rule is **that one-line note, but the computer enforces it.** It's a small text file in the repo (typically `.semgrep/something.yml`) that says "if you see this pattern, flag it as an error."

Once that rule exists, anyone — you, Claude, a future contributor — who writes code that triggers the pattern gets a red error before the change can be committed.

## Why this is high-value for your codebase

Three of the bugs the trinity caught this session were the same type: **we fixed a security issue, then accidentally re-introduced an adjacent smaller bug while writing the fix.**

A custom rule is the way to make sure the *original fix* stays fixed forever. Concretely:

- Today we made `~/.config/budget-itemizer/` files use safe permissions via a helper called `writeRestrictedFile`. If someone (you, Claude, anyone) tomorrow writes "let me just write the file directly," they bypass the helper, the file is sloppy, the security gain we made today silently disappears.
- A custom Semgrep rule **stops the commit** before that bug ever lands.

## My recommended 3 rules in plain English

These are the three I'd actually create. The technical YAML is in the primer; here's what they mean.

### Rule 1: "Config files must use the safe helper"
**Plain English**: Any code that writes a file inside `~/.config/budget-itemizer/` must use `writeRestrictedFile`. Writing the file directly is forbidden.
**Why this matters**: One of today's security findings was that `history.json` and `categories.cache.json` were being written without restricted permissions, so other users on the machine could read your purchase history. We fixed it. This rule prevents the same bug from coming back.
**How often it would catch something**: Probably zero times this year, but the *one* time someone writes new code that touches config and forgets the helper, it pays for itself.

### Rule 2: "No shell-string interpolation with execSync"
**Plain English**: Don't write `execSync("kill " + pid)` — write `execFileSync("kill", [pid])` instead.
**Why this matters**: The first form lets a sneaky input use shell metacharacters to run extra commands. The second form is immune. Semgrep already caught us doing this in `services/llama-server.ts` this morning — we fixed it. This rule prevents the next person from doing the same thing.
**How often it would catch something**: Probably twice a year. Each time would have been a real defense-in-depth gap.

### Rule 3: "Uploaded filenames must go through the sanitizer"
**Plain English**: If code is saving an uploaded file to the inbox or processed folder, the filename it uses *must* come from `sanitizeReceiptFilename`. Not directly from whatever the user sent.
**Why this matters**: The adversarial test agent today found two bugs that crashed the app because we forgot to handle weird filenames (`......` and 4096-character names). We fixed those. The rule keeps anyone — Claude in the next session, a future contributor — from adding a new upload route that forgets to sanitize.
**How often it would catch something**: Once, the next time someone adds a feature that handles file uploads. Saves a 500-error.

## My recommended 2 rules to skip for now

I described 5 in the technical primer; here's what to skip and why.

### Rule (skip): "Every route must have auth wired up"
Sounds great. The catch: Semgrep's way of expressing "this thing has X next to it" is fragile when the X is something flexible like a comment. The rule would generate a steady stream of false alarms every time you add a deliberately-public route like `/healthz`. **The cost of suppressing them outweighs the benefit until you have more than one developer.**

### Rule (skip): "LLM-emitted strings must be scrubbed"
Also a great idea in principle. The catch: this one really needs *taint tracking* — understanding "this value came from the LLM, then flowed through these three functions, and is now hitting YNAB." Semgrep can do this, but it's heavier to configure correctly, and getting it wrong leaves you with a rule that *looks* like it's protecting you but actually isn't. **Better to do this carefully later than half-do it now.**

## What it costs

- **Writing the 3 rules**: ~30 minutes once. The YAML is in the primer; can paste-as-is.
- **Running them**: 30 seconds, every commit, no human attention.
- **Maintaining them**: occasionally, when you rename one of the helper functions, the rule needs the new name. Maybe twice a year, ~5 minutes each time.
- **Wiring them into a "stop bad commits" gate**: 10 more minutes (one tiny config file at `.husky/pre-commit`).

## What you'd see when one fires

If you ever wrote code that broke one of these rules — say, you added a new upload route and forgot the filename sanitizer — `git commit` would refuse to finish and print something like:

```
❌  src/components/NewUploadView.tsx:42
    Uploaded filenames must use sanitizeReceiptFilename() before fs operations.
    See docs/semgrep-rules-eli5.md, Rule 3.
```

You'd fix the line. Commit succeeds.

## How to decide

If your answer to "will I add features to this app over the next year?" is yes → write the rules. ~30 min once, prevents real bug classes forever.

If "I'm shipping v0.1.0 and walking away" → skip. The rules add no value if no one's editing the code.

Default recommendation: **write the 3 rules.** I can do it in the next session, all three at once, with a pre-commit gate. Just say "do the semgrep rules" and I'll execute.

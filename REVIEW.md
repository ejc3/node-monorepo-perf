# Quality Pipeline: Static Checks, Type-Checking, and Review

The pipeline, cheapest stage first.

## 1. Static Syntax Checks

Run after editing a script. They catch syntax errors before anything executes.

- `for f in scripts/*.mjs; do node --check "$f"; done` parses every Node script. `node --check` checks only its first argument, hence the loop.
- `for f in scripts/*.sh; do bash -n "$f"; done` does the same for shell scripts, with the same one-argument limit.

## 2. Type-Checking

- **Per package:** `tsc --noEmit` (the `typecheck` script).
- **Workspace:** `turbo run typecheck`, cached, scoped with `--filter` / `--affected`.
- **Faster:** `tsgo --noEmit` (the native port), ~12× faster on one 3,000-module program ([TYPECHECKERS.md](TYPECHECKERS.md)).

Lint runs as its own task, not inside `next build`, where it would repeat in every build across thousands of apps. The linter is oxlint (50.5× ESLint on an 800-file synthetic corpus, [TOOLING.md](TOOLING.md#lint-eslint-vs-oxlint)), with ESLint for rules oxlint has not ported.

## 3. Review Before Commit

Both run on the diff before each commit; independent reviewers catch different issues.

- **`/code-review`** (a Workflow): parallel finder agents (line-by-line, removed-behavior, cross-file callers, language/shell pitfalls, reuse/simplification/efficiency) → one verifier per candidate (CONFIRMED/PLAUSIBLE/REFUTED; REFUTED dropped) → gap sweep. Output is a ranked, deduped list.
- **codex**: `codex exec -s read-only "<prompt>"` runs a separate model over the same diff and docs. It cross-checks findings and flags marketing-toned prose.

## 4. Claims Verification

A Workflow fans out agents to verify factual claims (pnpm / Turborepo / Vercel / Next.js) against official docs (CONFIRMED / REFUTED / needs-nuance + source URLs). This keeps [OPTIMIZATIONS.md](OPTIMIZATIONS.md) and [WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) accurate.

## Order of Operations

```
edit -> node --check / bash -n        (instant)
     -> turbo run typecheck --affected (cached)
     -> /code-review + codex on the diff   (before commit)
     -> fix findings -> commit -> push
     -> @codex review on the PR head (@coderabbitai review optional)
     -> answer every finding -> review-gate status green -> merge
```

Claims verification runs whenever docs change.

## 5. Merge Gate

The ruleset on `main` requires the `review-gate` status, which blocks a merge until every
review finding is answered and Codex has reviewed the head (or a `HEAD-REVIEW-OVERRIDE`
states what was done instead); `make merge-pr` runs the same check:
[AGENTS.md, "Merge Gate"](AGENTS.md#merge-gate).

When Codex cannot review the head (out of quota), post a comment whose first line is
`HEAD-REVIEW-OVERRIDE: chatgpt-codex-connector <sha>: <what was done instead>`, naming the
current head and stating concretely what replaced the review, e.g. "local
`codex exec -s read-only` review of <base>..<head>, no findings" with the placeholders
filled in (text still holding `TODO` or a `<words>` placeholder is rejected). It covers Codex on that head
only and answers no finding. The gate prints it as `HEAD OVERRIDDEN` and reports
`CLEAR (with 1 head-review override)`, so the substitution stays on the record.

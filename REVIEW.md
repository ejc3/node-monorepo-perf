# Quality Pipeline: Static Checks, Type-Checking, and Review

The pipeline, cheapest stage first.

## 1. Static Syntax Checks

Run after editing a script. They catch syntax errors before anything executes.

- `for f in scripts/*.mjs; do node --check "$f"; done` parses every Node script. `node --check` checks only its first argument, hence the loop.
- `for f in scripts/*.sh; do bash -n "$f"; done` does the same for shell scripts, with the same one-argument limit.

## 2. Type-Checking

The semantic gate; `node --check` and `bash -n` check syntax only.

- **Per package:** `tsc --noEmit` (the `typecheck` script).
- **Workspace:** `turbo run typecheck`, cached, scoped with `--filter` / `--affected`.
- **Faster:** `tsgo --noEmit` (the native port), ~12x faster on one 3,000-module program ([TYPECHECKERS.md](TYPECHECKERS.md)).

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
```

Claims verification runs whenever docs change.

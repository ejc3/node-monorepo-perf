# Quality Pipeline: Static Checks, Type-Checking, and Review

The pipeline, fastest/cheapest first.

## 1. Static Syntax Checks

Run after editing a script; catch typos before anything executes.

- `for f in scripts/*.mjs; do node --check "$f"; done` — parse every Node script (`node --check` takes only its first arg, so loop).
- `for f in scripts/*.sh; do bash -n "$f"; done` — same for shell scripts (same one-arg gotcha).

## 2. Type-Checking

The semantic static gate. `node --check` / `bash -n` are syntax-only; tsc is semantic.

- **Per package:** `tsc --noEmit` (the `typecheck` script).
- **Workspace:** `turbo run typecheck`, cached, scoped with `--filter` / `--affected`.
- **Faster:** `tsgo --noEmit` (native port), ~12x on a single program — [TYPECHECKERS.md](TYPECHECKERS.md).

Lint runs as a separate task, not inside `next build` (wasted per-build work at thousands of apps): oxlint ([TOOLING.md](TOOLING.md#lint-eslint-vs-oxlint), 63.3× ESLint on this corpus), ESLint for unported rules.

## 3. Review Before Commit

Both run on the diff before each commit; two independent reviewers catch different issues.

- **`/code-review`** (a Workflow): parallel finder agents (line-by-line, removed-behavior, cross-file callers, language/shell pitfalls, reuse/simplification/efficiency) → one verifier per candidate (CONFIRMED/PLAUSIBLE/REFUTED; REFUTED dropped) → gap sweep. Output is a ranked, deduped list.
- **codex**: `codex exec -s read-only "<prompt>"` runs a separate model over the same diff and docs, cross-checking findings and catching marketing-toned prose.

## 4. Claims Verification

A Workflow fans out agents to verify factual claims (pnpm / Turborepo / Vercel / Next.js) against official docs (CONFIRMED / REFUTED / needs-nuance + source URLs). Keeps [OPTIMIZATIONS.md](OPTIMIZATIONS.md) and [WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) accurate.

## Order of Operations

```
edit -> node --check / bash -n        (instant)
     -> turbo run typecheck --affected (cached)
     -> /code-review + codex on the diff   (before commit)
     -> fix findings -> commit -> push
```

Claims verification runs whenever docs change.

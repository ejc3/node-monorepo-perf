# Quality Pipeline: Static Checks, Type-Checking, and Review

How the pieces fit, fastest/cheapest first.

## 1. Static Syntax Checks

- `for f in scripts/*.mjs; do node --check "$f"; done` parses every Node script without running it. `node --check` only checks its first file argument, so loop over the glob rather than passing it directly.
- `for f in scripts/*.sh; do bash -n "$f"; done` parses every shell script (same gotcha: `bash -n` only parses its first argument).

These catch typos and broken edits before anything executes. Run them after editing a script.

## 2. Type-Checking

The static gate is the TypeScript type-check (`tsc --noEmit`): it rejects type errors (wrong shapes, missing props, bad imports) with no execution and no test harness. `node --check` / `bash -n` are lighter, syntax-only static checks; tsc is the semantic one.

There is no lint step inside `next build`: at thousands of apps, linting inside every build is wasted work. Lint runs as a separate task; this repo's linter is oxlint ([TOOLING.md](TOOLING.md#lint-eslint-vs-oxlint), 63.3× ESLint on this corpus), with ESLint available for rules oxlint has not ported.

Type-checking runs as its own task:

- Per package: `tsc --noEmit` (the `typecheck` script).
- Across the workspace: `turbo run typecheck`, cached and scoped with `--filter` / `--affected`.
- Faster option measured here: `tsgo --noEmit` (TypeScript native port), ~12x on a single program. See [TYPECHECKERS.md](TYPECHECKERS.md).

## 3. Review Before Commit

Both run on the diff before each commit; the two independent reviewers catch different issues.

### A. `/code-review`

A review implemented as a Workflow:

1. **Find:** parallel finder agents, each a different angle: line-by-line, removed-behavior, cross-file callers/callees, language/shell pitfalls, wrapper correctness, plus reuse / simplification / efficiency / altitude. Each returns candidate findings.
2. **Verify:** one verifier per candidate returns CONFIRMED / PLAUSIBLE / REFUTED against the actual file; REFUTED is dropped.
3. **Sweep:** a final agent looks only for gaps the first pass missed.

Output is a ranked, deduped findings list. Example findings it produced here: a focus/full chart ratio that mixed task and package counts, and a bash bench that swallowed install failures via `set -e` in a subshell.

### B. codex

`codex exec -s read-only "<review prompt>"` runs a separate model over the same diff and docs. It cross-checks the workflow's findings and catches inaccurate or marketing-toned prose.

## 4. Claims Verification

A Workflow fans out agents that verify factual claims (pnpm / Turborepo / Vercel / Next.js behavior) against official documentation and return CONFIRMED / REFUTED / needs-nuance with source URLs. Used to keep [OPTIMIZATIONS.md](OPTIMIZATIONS.md) and [WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) accurate.

## Order of Operations

```
edit -> node --check / bash -n        (instant)
     -> turbo run typecheck --affected (cached)
     -> /code-review + codex on the diff   (before commit)
     -> fix findings -> commit -> push
```

Claims verification additionally runs whenever docs change.

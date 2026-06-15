# Quality pipeline: static checks, type-checking, and review

How the pieces fit, fastest/cheapest first.

## 1. Static syntax checks (instant, local)

- `node --check scripts/*.mjs` parses every Node script without running it.
- `bash -n scripts/*.sh` parses every shell script.

These catch typos and broken edits before anything executes. Run them after editing a script.

## 2. Type-checking (the static gate)

A static check analyzes the source without running it; a gate is a check that must pass before you commit. This repo's static gate is the TypeScript type-check: it reads the code and rejects type errors (wrong shapes, missing props, bad imports) with no execution and no test harness. (`node --check` / `bash -n` are lighter static checks — syntax only; tsc is the semantic one.)

There is no ESLint here, by design. At thousands of apps, linting inside every `next build` is wasted work, so the generated `next.config` does not enable it and apps ship no eslint config. Type-checking runs as its own task:

- Per package: `tsc --noEmit` (the `typecheck` script).
- Across the workspace: `turbo run typecheck`, cached and scoped with `--filter` / `--affected`.
- Faster option measured here: `tsgo --noEmit` (TypeScript native port), ~12x on a single program. See [TYPECHECKERS.md](TYPECHECKERS.md).

If you want lint rules, add ESLint as a separate Turbo task (`turbo run lint --affected`), not inside the build. That keeps it cached and filterable like typecheck.

## 3. Review before commit (two independent reviewers)

Both run on the diff before each commit; the two independent reviewers catch different issues.

### a. `/code-review` (multi-agent workflow)

A review implemented as a Workflow:

1. **Find** — parallel finder agents, each a different angle: line-by-line, removed-behavior, cross-file callers/callees, language/shell pitfalls, wrapper correctness, plus reuse / simplification / efficiency / altitude. Each returns candidate findings.
2. **Verify** — one verifier per candidate returns CONFIRMED / PLAUSIBLE / REFUTED against the actual file; REFUTED is dropped.
3. **Sweep** — a final agent looks only for gaps the first pass missed.

Output is a ranked, deduped findings list. Example findings it produced here: a focus/full chart ratio that mixed task and package counts, and a bash bench that swallowed install failures via `set -e` in a subshell.

### b. codex (independent adversarial pass)

`codex exec -s read-only "<review prompt>"` runs a separate model over the same diff and docs. It cross-checks the workflow's findings and catches inaccurate or marketing-toned prose.

## 4. Claims verification (for docs)

A Workflow fans out agents that verify factual claims (pnpm / Turborepo / Vercel / Next.js behavior) against official documentation and return CONFIRMED / REFUTED / needs-nuance with source URLs. Used to keep [OPTIMIZATIONS.md](OPTIMIZATIONS.md) and [WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) accurate.

## Order of operations

```
edit -> node --check / bash -n        (instant)
     -> turbo run typecheck --affected (cached)
     -> /code-review + codex on the diff   (before commit)
     -> fix findings -> commit -> push
```

Static checks and type-checking are cheap and run constantly; the two-reviewer pass runs before each commit; claims verification runs when docs change.

# A 4,000-app monorepo on bun + tsgo + oxlint + turbo — measured

What the day-to-day costs are when a pnpm + Turborepo monorepo of **4,000 Next.js apps and
400 shared libraries** (4,400 packages) runs on one native-compiled tool per job. Every number
below is measured on the same machine and traces to a JSON under `bench/`; nothing is
estimated or extrapolated unless labeled as such.

**Machine:** 64-core Neoverse-V1, 135 GB RAM. **Versions:** bun 1.3.14, tsgo
(`@typescript/native-preview`) 7.0.0-dev.20260614.1, oxlint 1.71.0, turbo 2.9.18, tsc 5.9.3,
Node 22. (`bench/env.json`; oxlint version from `bench/optimal-gate-bench.json`)

## The one idea

Cost splits into two classes, and which one you pay is decided by what you touch, not by how
big the repo is:

- **O(repo)** — whole-workspace operations (install, a whole typecheck, revving a package
  every app imports). These scale with package count. On this stack they stay in **seconds**.
- **O(closure)** — anything scoped to one app or lib and the packages it imports
  (`turbo --filter` / `--affected`, or running a tool on one package). These track that one
  package's closure and **do not grow with the repo**.

A developer's day is almost entirely O(closure). The expensive O(repo) operations are
infrequent (first clone, CI install, a core-library rev) and are still fast here.

## The stack

| job                 | tool                 | why                                            |
| ------------------- | -------------------- | ---------------------------------------------- |
| install             | **bun**              | links 4,400 packages in ~21s vs pnpm's minutes |
| typecheck / gate    | **tsgo**             | the native TypeScript port; 8.8× tsc, same error locations |
| lint                | **oxlint**           | native Rust; whole tree in 180ms               |
| orchestrate + scope | **turbo**            | `--filter`/`--affected` + per-package caching  |

## By role

### App developer — everything is O(closure)

One app plus the libs it imports. Fresh (first time) vs subsequent (repeat).
(`bench/dev-loop-bench.json`, app `@demo/app-2000`)

| step                              | fresh | subsequent |
| --------------------------------- | ----- | ---------- |
| onboard — `bun install` whole ws  | 20.6s | 3.8s       |
| typecheck-on-save — tsgo          | 167ms | **168ms** (187 MB) |
| lint-on-save — oxlint             | 64ms  | **60ms**   |
| focused gate — `turbo --filter`   | 19.1s (cold, 187 tasks) | 15.2s (warm) |

The keystroke loop is **~170ms typecheck + ~60ms lint**. tsgo and oxlint have no incremental
cache, so the first run matches the steady state within noise — which is why they run on every
save. The focused gate (build the closure's dist + typecheck it) is the pre-push step, not the
keystroke loop.

### Lib developer — O(closure) for a leaf library

One leaf lib plus the libs it imports; its pre-merge gate re-checks the lib's dependents.
(`bench/dev-loop-bench.json`, lib `@demo/lib-400`; gate also `bench/optimal-gate-bench.json`)

| step                                       | fresh | subsequent |
| ------------------------------------------ | ----- | ---------- |
| typecheck-on-save — tsgo                   | 190ms | **190ms** (189 MB) |
| lint-on-save — oxlint                      | 70ms  | **65ms**   |
| pre-merge gate — `turbo --filter=...lib`   | 22.8s (cold, 237 tasks) | 13.6s (warm) |

A leaf lib's blast radius is its dependents (237 tasks), not the repo. Revving a workspace dep
is a source edit only: workspace deps are symlinks, so consumers pick up the change with no
reinstall, no lockfile change, and no publish.

### Workspace author — bumping a core package every app imports (O(repo))

The worst case in the monorepo: rev the library all 4,000 apps depend on, and catch a breaking
type error before it merges. (`bench/optimal-gate-bench.json`, `bench/typecheck-parity-bench.json`;
the version-bump fanout row from `bench/lockfile-merge-bench.json`, measured at 200:50)

| action                                                 | cost |
| ------------------------------------------------------ | ---- |
| **gate every dependent** — one tsgo program, whole ws  | **1.32s** (re-export tree) / **1.96s** (real heavy types) |
| **catch a breaking change**                            | **1.39s** — 4,000 / 4,000 apps go red, named (TS2554) |
| does tsgo agree with tsc on what it catches?           | **0 missed, 0 false-positive** on 25 injected real-type errors |
| same gate via orchestrated turbo (also emits dist)     | 80.1s / 4,800 tasks |
| bump a **workspace** dep version                       | no install or publish — workspace deps are symlinks (source edit only) |
| bump an **npm** dep version (fanout)                   | catalog: **2** workspace-yaml lines / per-consumer pin: **one manifest each** (25 of 25 in the 200:50 bench) |

Revving the package *everyone* imports gates in **~1.4 seconds** and names exactly which of
the 4,000 apps broke. The single tsgo process reads each library's source once and shares it
across every importing app, so it skips the 400 per-library dist builds the orchestrated path
does — that is the ~60× gap (1.32s vs 80.1s). It is typecheck-only; a deploy that needs `dist`
runs the turbo path.

## What stays expensive

Honest about the limits. Two operations are genuinely O(repo) and cannot be scoped away:

- **Install** of the whole workspace (~21s fresh) — paid on a clean clone or in CI. For
  contrast, pnpm cold-resolve of a quarter the apps (1,000) already takes 233s
  (`bench/install-modes-bench.json`).
- **A whole-repo dist build** (release-everything) scales with package count.

Everything else is either O(closure) (a developer's day) or O(repo) but small in wall time —
whole typecheck 1.3s, whole lint 0.18s. The core-package gate is O(repo) in *what it checks*
but 1.4s in wall time.

## Caveats on the tools

- **tsgo is a preview build.** It does not emit `dist` (the turbo path uses tsc via `^build`
  for that), and it is stricter than tsc about module-resolution config. On *type checking* it
  flagged every error tsc flagged in the parity vet (25 / 25 locations, 0 missed) on a
  deliberately type-heavy corpus — but that is one corpus with `skipLibCheck`, not a general
  parity proof.
- **bun ignores pnpm `catalog:` catalogs**, so they are resolved to concrete versions before a
  bun install (`workspace:*` specs are left intact).
- The focused-gate **warm** numbers carry turbo's per-invocation graph-load + cache-restore
  cost over the 4,400-package workspace and are noisy run-to-run (reported as medians of 3) —
  noisy enough that the app and lib warm gates don't order reliably between runs. That floor is
  why the keystroke loop runs tsgo/oxlint directly rather than through turbo.

## Reproducing

The workspace is generated; `scripts/` builds it at any scale and runs each measurement. The
three role benches: `node scripts/dev-loop-bench.mjs 4000:400` (app + lib inner loops),
`node scripts/optimal-gate-bench.mjs 4000:400` (core-package gate),
`node scripts/typecheck-parity-bench.mjs 4000:400:8` (tsgo-vs-tsc parity). The destructive ones
run in a throwaway git worktree and refuse to run on a loaded box (the timings are core-bound).
Source of record is `bench/*.json`; `bench/env.json` records the machine.

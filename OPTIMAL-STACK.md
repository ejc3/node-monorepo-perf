# OPTIMAL-STACK.md — bun + tsgo + oxlint + turbo at 4,000 apps / 400 libs

Source of record: `bench/optimal-gate-bench.json` (run at 4000:400), the real-types parity
vet `bench/typecheck-parity-bench.json` (run at 4000:400:8), the developer inner loops
`bench/dev-loop-bench.json` (run at 4000:400), `bench/env.json`.
Reproduce: `node scripts/optimal-gate-bench.mjs 4000:400` (in a dedicated git worktree —
the bench overwrites the root `package.json` and regenerates the tree, so it refuses to
run in the primary tree); `node scripts/typecheck-parity-bench.mjs 4000:400:8` (self-contained
— scaffolds a throwaway workspace under the temp dir, needs no worktree); `node
scripts/dev-loop-bench.mjs 4000:400` (also in a worktree).

One native-compiled tool per job — no slower baseline in the measured loop:

| job                 | tool                                    | version              |
| ------------------- | --------------------------------------- | -------------------- |
| install             | **bun**                                 | 1.3.14               |
| typecheck / gate    | **tsgo** (`@typescript/native-preview`) | 7.0.0-dev.20260614.1 |
| lint                | **oxlint** (oxc)                        | 1.71.0               |
| orchestrate + scope | **turbo**                               | 2.9.18               |

## The scenario

A library owner owns a foundation lib that **every** app imports (`@demo/lib-001`,
generated with `--universal 1` so it is a pure-sink tier every app and every other lib
depends on). At 4,000 apps / 400 libs the daily question is: rev that lib, and catch a
breaking type error in any of the 4,000 apps before it merges — fast.

## Install the workspace — bun, 20.9s

`bun install` materializes the 4,400-package workspace (4,000 apps + 400 libs; 76 unique
external deps, the rest workspace symlinks) in **20.9s** — warm store, `node_modules`
cold, the steady-state clone/CI case. This is a one-time setup cost; revving a lib edits
source and needs no reinstall. For contrast, pnpm's cold-resolve (no lockfile) is 233s at
1,000:200 (`bench/install-modes-bench.json`) — about a quarter the apps and already
minutes.

## The optimal type-error gate — one tsgo program over the whole workspace, 1.32s

For a **universal** rev every app must re-check, so there is nothing to scope away. The
fastest gate is then a single tsgo process over the whole workspace, reading lib **source**
directly (`tsgo --noEmit -p tsconfig.whole.json`, with `@demo/*` resolved to
`packages/*/src/index.ts`). One process parses each lib's source **once** and shares it
across every importing app, and skips the per-lib dist builds entirely.

At 4,000:400 it typechecks the whole tree in **1.32s**, peak RSS **911MB** (one process —
the tradeoff is memory, trivial against the 135GB box). It is typecheck-only: it emits no
`dist`. The timed number follows a throwaway warmup run that absorbs tsgo's binary load and
first-touch fs caching.

## Catching a breaking change — every dependent app, 1.39s

A breaking foundation signature (a new required parameter) turns **every** dependent app
red: **4,000 of 4,000 apps** report `error TS2554: Expected 2 arguments, but got 1`
(4,399 TS2554 in all — 4,000 apps + 399 dependent libs), in **1.39s**. The bench asserts
the catch is exactly this — `appsWithErrors === 4000` and a `TS2554` sample — so a gate
that went red for any other reason fails the run. This is "catch a type error in one of
the 4,000 apps before it ships," in under a second and a half.

## Does the gate survive real types, and does it agree with tsc?

The gate numbers above are measured on the generated tree, whose libs are 16-line
re-exports. A separate, self-contained vet (`scripts/typecheck-parity-bench.mjs` →
`bench/typecheck-parity-bench.json`) runs the same one-program shape over a deliberately
type-heavy tree of the same 4,000:400 scale — libs carrying recursive conditional + mapped
types, 48-member unions, recursive path-flattening, and cross-lib type intersections.

**Cost holds.** One tsgo program checks this type-heavy tree in **1.96s** (median of 3,
samples 1.95–1.96s), peak RSS **1281MB** — the same ~2s order as the optimal-gate tree's
1.32s/911MB. This is a smoke test, not an isolated type-weight delta: the two trees are
structured differently (8 vs 16 modules per lib, a non-universal vs universal import graph),
so the only claim is that real type computation keeps the one-program gate around 2s at this
scale — not a general bound. The ratio below is core-bound (tsgo is parallel), so the bench
refuses to run on a loaded box and records the load it ran under.

**On the injected errors, tsgo catches what tsc catches.** tsc is the oracle. On the valid
tree both report **0** diagnostics. Into 5 apps the bench injects 5 error sites each
(assignment, arg-type, arity, return-type) — 25 in all; tsc flags all 25 and tsgo flags the
same **25 locations**, missing **0** and adding **0** of its own (the bench hard-fails on
either drift, on the tsc count drifting from 25, and on a signal-killed run). Error codes
match on 20 of 25; at the arg-type site (in all 5 apps) tsc emits `TS2345` and tsgo `TS2739`
— both reject the same expression, with a different code. This is one generated corpus with
`skipLibCheck` (no `.d.ts` parity), not a general diagnostic-parity proof — but on these 25
located errors tsgo loses nothing tsc catches. So "tsgo is a preview" constrains emit and
config (below), not which type errors it reports here — on the same type-heavy check tsc
takes **17.2s** to tsgo's 1.96s (**8.8×**, both medians, measured at 1-min load 1.97 on 64
cores).

## Context — turbo build+tsgo, 80.1s (not like-for-like)

The orchestrated path, `turbo run typecheck:tsgo --filter=...@demo/lib-001`, runs one tsgo
per package against built `dist` (per-package caching + graph scoping): **4,800 of 4,800
tasks** (4,400 `typecheck:tsgo` + 400 lib builds) cold in **80.1s**. It is **not**
like-for-like with the one-program gate — it also emits every lib's `dist` (tsc `^build`),
which a deploy needs and the type-error gate does not. For a universal rev there is no
scope to exploit, so the one-program gate is ~60× faster (1.32s vs 80.1s); turbo's value
here is the dist artifacts and the per-package cache on the *next* run, not the cold gate
time.

## Scope a non-universal rev — leaf, O(closure), 22.4s

When the revved lib is **not** universal, scoping is the win. The same turbo command on a
leaf lib (`...@demo/lib-400`, imported by ~1% of apps) runs only **237 of 4,800 tasks** in
**22.4s** — the graph tracks that one lib's closure, not the repo. The rule: a universal
rev → one tsgo program; a scoped rev → `turbo --filter=...<lib>` (or `--affected`).

## The developer inner loops — O(closure), fresh vs subsequent

The sections above are the workspace-author / lib-owner view, where a core-package rev is
O(repo). The two day-to-day roles are the other case: each touches one package and the libs it
imports, so their work is scoped to that closure by construction, not to the repo. Measured at
4,000:400 for one mid app (`@demo/app-2000`) and one leaf lib (`@demo/lib-400`), each step
fresh (first time) vs subsequent (repeat) (`bench/dev-loop-bench.json`):

| step                               | app dev (fresh / subsequent) | lib dev (fresh / subsequent) |
| ---------------------------------- | ---------------------------- | ---------------------------- |
| typecheck-on-save (tsgo, from src) | 167 / **168ms** (187MB)      | 190 / **190ms** (189MB)      |
| lint-on-save (oxlint, one dir)     | 64 / **60ms**                | 70 / **65ms**                |
| focused gate (turbo, cold / warm)  | **19.1s** / **15.2s** (187)  | **22.8s** / **13.6s** (237)  |

- **Onboarding** — `bun install` the whole workspace: fresh **20.6s** (cold `node_modules`),
  subsequent **3.8s** (warm — bun re-verifies the 4,400-package tree). One O(repo) cost, paid
  on first clone.
- **Typecheck-on-save** and **lint-on-save** have no meaningful fresh-vs-subsequent gap — tsgo
  and oxlint have no incremental cache, so the first run matches the steady state within noise
  (~170–190ms typecheck, ~60–65ms lint). That is why they run on every save, directly, not
  through turbo.
- **Focused gate** — `turbo typecheck:tsgo` over the closure (app: `app...` = the app + its
  dependencies) or the dependents (lib: `...lib`), building dependency-lib dist via `^build`
  and typechecking; medians of 3, under source-visibility. The lib gate covers more (237 tasks
  of dependents vs the app's 187-task closure) and costs more **cold** (22.8s vs 19.1s). The
  **warm** run is dominated by turbo's graph-load + input-hash + cache-restore over the
  4,400-package workspace — noisy enough that the app and lib warm gates don't order reliably
  (this run 13.6s vs 15.2s; a prior run the reverse), and this bench does not break those costs
  out. That floor is why the keystroke loop runs the tools directly.

The contrast with the core-package gate is the point: a core-package rev is O(repo) (every app
re-checks — 1.4s as one tsgo program) because the change reaches everything; a developer's
edit reaches only their closure, so their keystroke loop is ~170ms.

## Lint — oxlint, 180ms

oxlint (native Rust) checks the whole 4,400-package source tree in **180ms** (0 findings)
— not on the critical path.

## What's wired, and the rough edges

- The one-program gate is typecheck-only — it reads lib **source** (`paths`→`src`), so it
  needs no build and emits nothing. If you also need `dist` (for deploy), that is a
  separate build; the turbo path produces it as part of its 80.1s.
- tsgo (TS7) is stricter than tsc about module-resolution config (it rejects `baseUrl` and
  non-relative `paths`); `tsconfig.whole.json` resolves `@demo/*` to `packages/*/src` and
  sets `declaration:false` (the base config's `declaration:true` would otherwise flag JSX
  component return types as non-portable, TS2883, under `--noEmit`).
- bun ignores pnpm `catalog:` catalogs, so the bench resolves them to concrete versions
  before installing (`workspace:*` specs are left intact — bun understands those). bun's
  own catalog format is the catalog-preserving option, not exercised here.
- In the turbo path lib `dist` is emitted by **tsc** via `^build` (tsgo emit is not wired —
  tsgo is a preview build). The preview status constrains emit and resolution config, not
  type checking: on the type-heavy parity vet above tsgo flagged every injected error
  location tsc flagged (25 of 25, 0 missed).

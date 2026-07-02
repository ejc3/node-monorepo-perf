# A 4,000-app monorepo on bun + tsgo + oxlint + turbo — measured

What the day-to-day costs are when a pnpm + Turborepo monorepo of **4,000 Next.js apps and
400 shared libraries** (4,400 packages) runs on one native-compiled tool per job. Figures
trace to `bench/*.json`; extrapolations are labeled.

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
| install             | **bun**              | links the 4,400-package workspace in ~21s (warm store, `optimal-gate-bench.json`) |
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
| **gate every dependent** — one tsgo program, whole ws  | **1.32s** (re-export tree) / **1.96s** (clean whole-ws check, type-heavy parity tree) |
| **catch a breaking change**                            | **1.39s** — 4,000 / 4,000 apps go red, named (TS2554) |
| does tsgo agree with tsc on what it catches?           | **0 missed, 0 false-positive** on 25 injected real-type errors (same 25 locations; different diagnostic code at 5 of them) |
| same gate via orchestrated turbo (also emits dist)     | 80.1s / 4,800 tasks |
| bump a **workspace** dep version                       | no install or publish — workspace deps are symlinks (source edit only) |
| bump an **npm** dep version (fanout)                   | catalog: **2** workspace-yaml lines / per-consumer pin: **one manifest each** (25 of 25 in the 200:50 bench) |

Revving the package *everyone* imports gates clean in **1.3s** and catches a breaking change in
**1.4s**, naming exactly which of the 4,000 apps broke. The single tsgo process reads each library's source once and shares it
across every importing app, so it skips the 400 per-library dist builds the orchestrated path
does — that is the ~60× gap (1.32s vs 80.1s). It is typecheck-only; a deploy that needs `dist`
runs the turbo path.

### Opening the editor — O(closure) too

Before any keystroke loop, the language server loads the project, and that cost tracks the opened
app's closure, not the repo: opening one app (65 libs / 1,123 files) stays flat as the repo grows 8×
(500 → 4,000 apps) and rises only with the closure (628 → 1,123 files). The two servers a developer
would use (`bench/editor-loop-bench.json`, tsgo `7.0.0-dev.20260614.1`):

| metric                        | tsserver | tsgo LSP        |
| ----------------------------- | -------- | --------------- |
| cold open (spawn → first def) | 1,620ms  | **86ms** (18.8×) |
| peak RSS                      | 380MB    | **275MB** (1.4×) |
| warm go-to-def / hover        | 1ms / 1ms | 0ms / 2ms      |

(4,000 apps / 300 libs.) The cost is all in the cold open — once warm, both resolve cross-package
go-to-def to the exact lib source in ≤2ms. tsgo's native LSP cuts the one part that scales (project
load) by ~19× and uses ~30% less memory. Detail in [LIMITS.md](LIMITS.md).

## What stays expensive

Two operations are genuinely O(repo) and cannot be scoped away:

- **Install** of the whole workspace (~21s, warm store) — paid on a clean clone or in CI.
  pnpm's no-lockfile cold-resolve (lockfile authoring) is a different operation and scale —
  233s at 1,000:200 (`bench/install-modes-bench.json`). The same-scale head-to-head
  (`bench/install-bench.json`, to 2,000 apps): on a full re-resolve (no lockfile, fresh
  `node_modules`) bun is ~62–357× faster than pnpm — a clean checkout carries the committed
  lockfile and pays the warm row instead; warm (cached) the gap narrows to single digits by
  1,000 apps, and at 2,000 apps bun warm 9.5s vs pnpm-isolated 15.2s while pnpm-hoisted warm
  4.7s is ~2× faster than bun. yarn 4 (same dataset) scales flatter than bun: fastest cold
  at 2,000 apps (PnP 3.2s, node-modules 6.2s vs bun 7.5s), and yarn-PnP specifically is the
  fastest warm install at 1,000–2,000 apps (2.1s, 2.9s — yarn's node-modules linker trails
  pnpm-hoisted warm). The install figures elsewhere in this summary were measured with bun
  as the installer; the bun-vs-yarn reconciliation is in
  [OPTIMAL-STACK.md](OPTIMAL-STACK.md). yarn-PnP's wins don't transfer to this stack:
  tsgo and `next build` do not run under PnP (tsc/turbo/oxlint do,
  `bench/pnp-compat-bench.json`); the node-modules linker has no such boundary. As a
  rollout driver yarn is vetted alongside bun and pnpm — all five mechanics native,
  including a CI auto-immutable default bun lacks (`bench/yarn-rollout-bench.json`,
  [ROLLOUT.md](ROLLOUT.md)).
- **A whole-repo dist build** (release-everything) scales with package count.

The whole-repo **build and typecheck** are **amortized across a CI fleet by a remote cache** — install is amortized separately (warm store + committed lockfile, above), not by Turborepo's cache. Every runner starts with an empty local cache, but after the first seeds the shared cache, each later runner *restores* turbo's task outputs instead of recomputing: a whole-repo typecheck drops 23.6s → 1.9s (12.5×) at 300:100 and 67.2s → 5.9s (11.4×) at 1,000:200, a build 62.7s → 4.0s (15.5×) at 300:100 (a single cold sample) (`bench/ci-cache-bench.json`, restore measured over a localhost cache — a real network adds each runner's download, ≤0.5 MB for a typecheck but 247 MB for a build). Restore is itself O(repo) — it skips task execution but still pays Turbo's graph-load + hashing (≈ the warm-cache floor) — so the speedup holds near 11–12× as the repo grows rather than widening, while the absolute time saved grows (≈22s → 61s). Across a 10-runner fleet building the same closure the per-runner cost amortizes ~5.6× (1,000:200 typecheck basis; a real fleet builds different commits, so less). The cache helps only the second-and-later consumer of an *unchanged* artifact — a leaf edit lets a fresh runner restore 486 of 500 tasks, a universal-foundation edit 0 of 500.

Everything else is either O(closure) (a developer's day) or O(repo) but small in wall time —
whole typecheck 1.3s, whole lint 0.18s. The core-package gate is O(repo) in *what it checks*
but small in wall time: 1.3s to gate clean, 1.4s when it must also name every broken app (the
breaking-change catch).

## Does it hold on real, larger apps?

The benches above use deliberately tiny synthetic apps. Run the same stack against two real
open-source Next.js apps cloned at pinned commits (`bench/real-app-bench.json`; tsgo and oxlint are
medians of 3, bun install and turbo single runs):

| app             | files / LOC | bun install   | tsgo --noEmit     | oxlint | turbo cold → warm       |
| --------------- | ----------- | ------------- | ----------------- | ------ | ----------------------- |
| vercel/commerce | 65 / 3.9k   | 543ms (76)    | **128ms** / 123MB | 62ms   | 190 → **56ms** (2 of 2) |
| shadcn/taxonomy | 125 / 7.5k  | 3370ms (1031) | **229ms** / 220MB | 79ms   | 290 → 293ms (1 of 2)    |

The per-app typecheck stayed in the low hundreds of ms for both apps, including the real 7.5k-LOC
one. The friction is config, not speed: **tsgo (a preview) refuses to start on a
real Next tsconfig**, erroring in 136–268ms on options it has removed (both apps trip `baseUrl` and
`moduleResolution: node`; commerce also `downlevelIteration`, taxonomy also `target: es5`); wiring a
real app in means modernizing the config and adding an ambient `*.css` declaration. The finagled
program checks the app's hand-written source, not its `next build`-generated types, so it is the
inner-loop source check, not the app's full `tsc` surface. After that, commerce checks clean (0
errors); taxonomy shows 13 — 7 cannot-find-module errors (TS2307), the sampled ones for
`contentlayer/generated` codegen this bench doesn't run; 6 for genuine dependency drift
(`className` is no longer accepted on the Radix Portal props —
`AlertDialogPortalProps`/`DialogPortalProps`/`SheetPortalProps`). Turbo caches a clean app's
checks (commerce warm 56ms, 2 of 2); it won't cache taxonomy's red typecheck until it goes green.

## Caveats on the tools

- **tsgo is a preview build.** It does not emit `dist` (the turbo path uses tsc via `^build`
  for that), and it is stricter than tsc about module-resolution config. On *type checking* it
  flagged every error tsc flagged in the parity vet (25 / 25 locations, 0 missed) on a
  deliberately type-heavy corpus — but that is one corpus with `skipLibCheck`, not a general
  parity proof.
- **bun ignores pnpm `catalog:` catalogs**, so they are resolved to concrete versions before a
  bun install (`workspace:*` specs are left intact).
- **bun is adoptable but not a strict safety superset of pnpm** (`bench/bun-safety-bench.json`,
  bun 1.3.14 vs pnpm 10, head-to-head). Two real gaps: bun's built-in trusted allowlist runs some
  registry `postinstall` scripts (esbuild) that pnpm 10 blocks, and bun has no fail-closed
  strict-peer knob (pnpm `strict-peer-dependencies=true` exits 1; none of bun's env / `.npmrc` /
  `bunfig.toml` knobs flip its exit). pnpm's isolation also surfaces a phantom import bun's hoist
  hides in single-package projects — in workspaces bun 1.3's isolated default blocks it too
  (parity). The rest is parity — a `file:` dep's `postinstall` is blocked by default on both, a missing
  peer is auto-installed by both at their defaults, both warn on a version mismatch, and bun
  authenticates to CodeArtifact via the same scoped `.npmrc` as pnpm. Full treatment in
  ROLLOUT.md → "Adoption safety, vetted."
- The focused-gate **warm** numbers carry turbo's per-invocation graph-load + cache-restore
  cost over the 4,400-package workspace and are noisy run-to-run (reported as medians of 3) —
  noisy enough that the app and lib warm gates don't order reliably between runs. That floor is
  why the keystroke loop runs tsgo/oxlint directly rather than through turbo.

## Reproducing

The workspace is generated; `scripts/` builds it at any scale and runs each measurement. The
three role benches: `node scripts/dev-loop-bench.mjs 4000:400` (app + lib inner loops),
`node scripts/optimal-gate-bench.mjs 4000:400` (core-package gate),
`node scripts/typecheck-parity-bench.mjs 4000:400:8` (tsgo-vs-tsc parity). The destructive ones
run in a throwaway git worktree; the dev-loop and parity benches also refuse on a loaded box
(their timings are core-bound). The side tables draw on `bench/real-app-bench.json`,
`bench/install-modes-bench.json`, and `bench/install-bench.json` (run via
`scripts/real-app-bench.mjs`, `scripts/install-modes-bench.mjs`, `scripts/install-bench.mjs`),
plus `bench/lockfile-merge-bench.json` (`scripts/lockfile-merge-bench.mjs`).
Source of record is `bench/*.json`; `bench/env.json` records the machine.

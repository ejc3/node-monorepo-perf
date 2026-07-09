# A 4,000-App Monorepo on bun + tsgo + oxlint + turbo, Measured

Day-to-day costs when a pnpm + Turborepo monorepo of **4,000 Next.js apps and 400 shared
libraries** (4,400 packages) runs on one native-compiled tool per job. Figures trace to
`bench/*.json`; extrapolations are labeled.

**Machine:** 64-core Neoverse-V1, 135 GB RAM. **Versions:** bun 1.3.14, tsgo 7.0.0-dev.20260614.1,
oxlint 1.71.0, turbo 2.9.18, tsc 5.9.3, Node 22 (`bench/env.json`).

## The one idea: O(repo) vs O(closure)

Which cost class you pay is decided by what you touch, not by repo size.

- **O(repo)**: whole-workspace operations (install, whole typecheck, revving a package every app
  imports). Scale with package count; on this stack they stay in **seconds**.
- **O(closure)**: anything scoped to one app/lib and the packages it imports (`turbo --filter` /
  `--affected`). Track that closure and **do not grow with the repo**.

A developer's day is almost entirely O(closure). The O(repo) operations (first clone, CI install,
core-lib rev) are infrequent and still fast.

## The Stack

| job                 | tool       | why                                                    |
| ------------------- | ---------- | ------------------------------------------------------ |
| install             | **bun**    | links the 4,400-package workspace in ~21s (warm store) |
| typecheck / gate    | **tsgo**   | native TypeScript port; 8.8× tsc, same error locations |
| lint                | **oxlint** | native Rust; whole tree in 180ms                       |
| orchestrate + scope | **turbo**  | `--filter`/`--affected` + per-package caching          |

Vite+'s task runner: turbo wins whole-repo typecheck by 2–3.7×; Vite Task wins the focused warm
loop (0.86s vs 3.0s at 1,000 apps) but can't cache `next build`
([TOOLING.md](TOOLING.md#vite-vp-task-runner-and-tool-layer)).

## By role

Full per-role tables in [OPTIMAL-STACK.md](OPTIMAL-STACK.md).

- **App developer** (O(closure), `bench/dev-loop-bench.json`): keystroke loop is **~170ms tsgo
  typecheck + ~60ms oxlint lint**; onboard `bun install` 20.6s fresh / 3.8s subsequent; focused
  `turbo --filter` gate 19.1s cold (187 tasks) / 15.2s warm. tsgo and oxlint have no incremental
  cache, so first run matches steady state.
- **Lib developer** (O(closure)): tsgo 190ms, oxlint ~65ms; pre-merge `turbo --filter=...lib` gate
  22.8s cold (237 tasks) / 13.6s warm — blast radius is the lib's dependents, not the repo. Revving
  a workspace dep is a source edit only (symlinks, no reinstall/publish).
- **Workspace author** (O(repo), the worst case — rev the lib all 4,000 apps import,
  `bench/optimal-gate-bench.json`): one tsgo program gates every dependent clean in **1.32s**, and
  catches a breaking change in **1.39s** with 4,000 / 4,000 apps red and named (TS2554). tsgo agrees
  with tsc: **0 missed, 0 false-positive** on 25 injected real-type errors. The same gate via
  orchestrated turbo (also emits dist) is 80.1s / 4,800 tasks — the single tsgo process reads each
  lib's source once, skipping the 400 dist builds. The npm-dep version bump fanout is catalog **2**
  workspace-yaml lines vs per-consumer pin **one manifest each**.
- **Opening the editor** (`bench/editor-loop-bench.json`, 4,000 apps / 300 libs): cold open
  (spawn → first def) tsserver 1,620ms vs tsgo LSP **86ms** (18.8×); peak RSS 380MB vs **275MB**;
  warm go-to-def/hover ≤2ms both. Cost tracks the opened app's closure (65 libs / 1,123 files), flat
  as the repo grows 8×. Detail in [LIMITS.md](LIMITS.md#editor-and-language-server).

## What stays expensive

Two operations are genuinely O(repo) and cannot be scoped away:

- **Install** of the whole workspace (~21s warm store), paid on clean clone or CI. pnpm's
  no-lockfile cold-resolve is 233s at 1,000:200 (`bench/install-modes-bench.json`); on a full
  re-resolve bun is ~62–357× faster than pnpm (`bench/install-bench.json`). yarn 4 is fastest cold
  and warm at 2,000 apps, but PnP can't run stock tsgo or Next's default Turbopack
  (`bench/pnp-compat-bench.json`; green paths exist via native-PnP tsgo and `next build` with
  webpack/rspack). bun-vs-yarn reconciliation in
  [OPTIMAL-STACK.md](OPTIMAL-STACK.md#installing-the-workspace); yarn as rollout driver vetted in
  [ROLLOUT.md](ROLLOUT.md#yarn-as-a-driver).
- **A whole-repo dist build** scales with package count.

Whole-repo build and typecheck amortize across a CI fleet via a remote cache: after the first
runner seeds it, each later runner restores instead of recomputing. Whole-repo typecheck goes 23.6s →
1.9s (12.5×) at 300:100 and 67.2s → 5.9s (11.4×) at 1,000:200 (`bench/ci-cache-bench.json`). The cache
helps only the second-and-later consumer of an *unchanged* artifact: a leaf edit lets a fresh runner
restore 486 of 500 tasks, a universal-foundation edit 0 of 500. Detail in
[LIMITS.md](LIMITS.md#remote-cache-amortizing-the-orepo-cold-start).

Everything else is O(closure) or O(repo)-but-small (whole typecheck 1.3s, whole lint 0.18s).

## Real apps

The same stack against two real open-source Next.js apps at pinned commits
(`bench/real-app-bench.json`):

| app             | files / LOC | bun install   | tsgo --noEmit     | oxlint | turbo cold → warm       |
| --------------- | ----------- | ------------- | ----------------- | ------ | ----------------------- |
| vercel/commerce | 65 / 3.9k   | 543ms (76)    | **128ms** / 123MB | 62ms   | 190 → **56ms** (2 of 2) |
| shadcn/taxonomy | 125 / 7.5k  | 3370ms (1031) | **229ms** / 220MB | 79ms   | 290 → 293ms (1 of 2)    |

Per-app typecheck stays in the low hundreds of ms. The friction is config, not speed. **tsgo (a
preview) refuses to start on a real Next tsconfig**, erroring in 136–268ms on removed options
(`baseUrl`, `moduleResolution: node`; commerce also `downlevelIteration`, taxonomy also
`target: es5`). Wiring an app in means modernizing the config and adding an ambient `*.css` decl.
Commerce then checks clean; taxonomy shows 13 (seven TS2307 cannot-find-module, six genuine
dependency drift). Turbo won't cache taxonomy's red typecheck until it goes green.

## Tool caveats

- **tsgo is a preview build.** No `dist` emit (turbo uses tsc via `^build`), stricter than tsc on
  module-resolution config. Parity is 25 / 25 locations on one `skipLibCheck` corpus, not a general
  proof.
- **bun ignores pnpm `catalog:`** — catalogs resolve to concrete versions before a bun install
  (`workspace:*` left intact).
- **bun is adoptable but not a strict safety superset of pnpm** (`bench/bun-safety-bench.json`):
  two gaps (runs some registry `postinstall` pnpm 10 blocks; no fail-closed strict-peer knob), one
  pnpm edge (phantom isolation in single-package projects), rest parity. See
  [ROLLOUT.md](ROLLOUT.md#adoption-safety).
- Focused-gate **warm** numbers carry turbo's per-invocation graph-load over the 4,400-package
  workspace and are noisy (medians of three); the keystroke loop runs tsgo/oxlint directly, not
  through turbo.

## Reproducing

`node scripts/dev-loop-bench.mjs 4000:400` (app + lib inner loops),
`node scripts/optimal-gate-bench.mjs 4000:400` (core-package gate),
`node scripts/typecheck-parity-bench.mjs 4000:400:8` (tsgo-vs-tsc parity). Destructive ones run in a
throwaway git worktree; dev-loop and parity refuse on a loaded box. Side tables draw on
`scripts/real-app-bench.mjs`, `scripts/install-modes-bench.mjs`, `scripts/install-bench.mjs`, and
`scripts/lockfile-merge-bench.mjs`. Source of record is `bench/*.json`.

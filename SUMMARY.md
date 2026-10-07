# A 4,000-App Monorepo on bun + tsgo + oxlint + turbo, Measured

Day-to-day costs when a pnpm + Turborepo monorepo of **4,000 Next.js apps and 400 shared
libraries** (4,400 packages; [the workspace under test](README.md#the-workspace-under-test)) runs
on one native-compiled tool per job. Figures trace to `bench/*.json`; extrapolations are labeled.

**Machine:** the 4,000:400 gate (`optimal-gate-bench.json`), inner-loop (`dev-loop-bench.json`),
editor (`editor-loop-bench.json`), remote-cache (`ci-cache-bench.json`), and Vite Task
(`vite-task-bench.json`) records are measured on a 192-core c8g.48xlarge (arm64, per each
record's core-count field; the instance type is stated in the README's Results section and
AGENTS.md's Data of Record). The 64-core timing records cited here (fleet-gate, sliced-gate,
typecheck-parity, install-bench, install-modes, pnpm12, pnp-compat, rspack-pnp, and real-app)
are measured on a dedicated c7gd.metal; `bun-safety-bench.json`, a behavior record with no
timings, is a run on a shared dev box of the same instance type. The machine and the record
list are in the [README](README.md#the-64-core-machine). **Versions** for those 192-core records: bun
1.4.2, tsgo 7.0.2 (`typescript@7`'s native `tsc`), oxlint 1.86.0, turbo 2.9.18, typescript 6.0.3
(the oracle), Node 22; the 64-core fleet-gate record ran the same tsgo, oxlint, and turbo
with bun 1.3.14; `real-app-bench.json` ran bun 1.3.14, tsgo 7.0.2, oxlint 1.71.0, and
turbo 2.9.18 (its `versions`).

## The one idea: O(repo) vs O(closure)

Which cost class you pay is decided by what you touch, not by repo size.

- **O(repo)**: whole-workspace operations (install, whole typecheck, revving a package every app
  imports). Scale with package count; on this stack they stay in **seconds**.
- **O(closure)**: anything scoped to one app/lib and the packages it imports (`turbo --filter`).
  The work tracks that closure, **not the repo**. Each turbo invocation also loads the whole
  graph, which does grow with the repo (a 100-package focused build takes 11.9s at 2,000 apps
  and 39.5s at 20,000, `bench/results.json`), and what `--affected` selects depends on the edit:
  a foundation edit selects every dependent.

A developer's day is almost entirely O(closure). The O(repo) operations (first clone, CI install,
core-lib rev) are infrequent and still fast.

## The Stack

| job                 | tool       | why                                                    |
| ------------------- | ---------- | ------------------------------------------------------ |
| install             | **bun**    | links the 4,400-package workspace in ~2.6s (warm store) |
| typecheck / gate    | **tsgo**   | typescript@7's native tsc; 8.8× tsc 6, same error locations |
| lint                | **oxlint** | native Rust; whole tree in 251ms                       |
| orchestrate + scope | **turbo**  | `--filter`/`--affected` + per-package caching          |

Vite+'s task runner: turbo wins whole-repo typecheck by 8.4–10.7× cold and 3.2–4.1× warm; Vite
Task's focused warm run is 1.2× faster at 1,000 apps (0.83s vs 1.01s) and 7% slower at 300 (0.81s
vs 0.76s); on the 1,200-task test run Vite Task is 2.7× faster warm (1.0s vs 2.8s) and turbo 2.5×
faster cold (7.1s vs 17.6s); Vite Task can't cache `next build` (`bench/vite-task-bench.json`,
[TOOLING.md](TOOLING.md#vite-vp-task-runner-and-tool-layer)).

## By role

Full per-role tables in [OPTIMAL-STACK.md](OPTIMAL-STACK.md).

- **App developer** (O(closure), `bench/dev-loop-bench.json`): keystroke loop is **~220ms tsgo
  typecheck + ~100ms oxlint lint**; onboard `bun install` 1.4s fresh / 0.9s subsequent; focused
  `turbo --filter` gate 7.8s cold (187 tasks) / 3.4s warm. tsgo and oxlint have no incremental
  cache, so first run matches steady state.
- **Lib developer** (O(closure)): tsgo ~230ms, oxlint ~104ms; pre-merge `turbo --filter=...lib` gate
  9.6s cold (237 tasks) / 3.8s warm — blast radius is the lib's dependents, not the repo. Revving
  a workspace dep is a source edit only (symlinks, no reinstall/publish).
- **Workspace author** (O(repo), the worst case — rev the universal foundation lib all 4,000 apps
  import, `bench/optimal-gate-bench.json`): one tsgo program gates every dependent clean in
  **1.59s**, and catches a breaking change in **1.55s** with 4,000 / 4,000 apps red and named
  (TS2554). At the measured fleet scale (30,000 apps, ~1.03M generated files; 64-core box) the same gate is
  **58.1s** clean (10.9× faster than the per-package turbo path, which also emits dist) and
  **58.9s** to a full 30,000-apps-red breaking verdict
  (`bench/fleet-gate-bench.json`, [FLEET.md](FLEET.md)); sliced into K concurrent programs
  the same check is **10.3s** on 64 cores / **6.2s** on 192, identical verdict union-verified
  (`bench/sliced-gate-bench.json` + `.pbox.json`, [FLEET.md](FLEET.md#the-sliced-gate-using-the-whole-box)). tsgo agrees with tsc: **0 missed, 0 false-positive** on 25 injected real-type errors,
  measured on a separate type-heavy 4,000:400 scaffold (`bench/typecheck-parity-bench.json`). The
  same gate via orchestrated turbo (also emits dist) is 46.9s / 4,800 tasks — the single tsgo
  process reads each lib's source once, skipping the 400 dist builds. The npm-dep version bump
  fanout is catalog **1** workspace-yaml line vs per-consumer pin **one manifest each — 4,399
  manifests** (`bench/lib-rev-bench.json`).
- **Opening the editor** (`bench/editor-loop-bench.json`, 4,000 apps / 300 libs): cold open
  (spawn → first def) tsserver 1,563ms vs tsgo LSP **113ms** (13.8×); peak RSS 414MB vs **309MB**;
  warm go-to-def/hover ≤2ms both. Cost tracks the opened app's closure (65 libs / 1,123 files), flat
  as the repo grows 8×. Detail in [LIMITS.md](LIMITS.md#editor-and-language-server).

## What stays expensive

Two operations are genuinely O(repo) and cannot be scoped away:

- **Install** of the whole workspace (~2.6s warm store at 4,000:400), paid on clean clone or CI. pnpm 12.8.1's
  no-lockfile cold-resolve is 2.9s at 1,000:200 — within 3% of a frozen warm-store install
  (2.8s; `bench/install-modes-bench.json`; the JS CLI paid 307.4s on that resolve,
  `bench/pnpm12-bench.json`). The pnpm-12-vs-bun head-to-head is measured
  (`bench/install-bench.json`): bun cold is ~1.6× faster at 200 apps and ~1.7× truly-cold
  (1.3s vs 2.2s); **pnpm-hoisted is 3.1–3.4× faster than bun cold at the measured 1,000- and
  2,000-app points** and the
  fastest cold and warm there (0.96s/2.5s cold, 0.59s/1.1s warm), with bun's cold the slowest
  configuration at 2,000. yarn-PnP is third cold at 1,000 (2.3s, behind pnpm-isolated's
  2.1s) and second at 2,000 (3.2s), but PnP can't run
  stock tsgo or Next's default Turbopack
  (`bench/pnp-compat-bench.json`; native-PnP tsgo is the green path for the checker, and
  `next build` under PnP is node-version-scoped: webpack/rspack build on node 22.22.0, every
  builder fails on 22.23.3, `bench/rspack-pnp-bench.json`). bun-vs-yarn reconciliation in
  [OPTIMAL-STACK.md](OPTIMAL-STACK.md#installing-the-workspace); yarn as rollout driver vetted in
  [ROLLOUT.md](ROLLOUT.md#yarn-as-a-driver).
- **A whole-repo dist build** scales with package count.
- **One large app's `next build`** does not split by package. On a 2,071-route app,
  Turbopack's module graph phase is fastest at 16 cores and slower with more (9.56s at 16,
  15.92s at 96 cores); two Turbopack patches cut it to 0.353× on a 24-core lane and the
  Turbopack compile to 0.709× ([TURBOPACK-GRAPH.md](TURBOPACK-GRAPH.md),
  `bench/turbopack-graph-ab.json`, `bench/turbopack-graph-scaling.json`; a 192-core
  c8g.48xlarge).

Whole-repo build and typecheck amortize across a CI fleet via a remote cache: after the first
runner seeds it, each later runner restores instead of recomputing. Whole-repo typecheck goes 9.9s →
1.5s (6.8×) at 300:100 and 24.8s → 3.9s (6.4×) at 1,000:200 (`bench/ci-cache-bench.json`). The cache
helps only the second-and-later consumer of an *unchanged* artifact: at 300:100, a leaf edit lets a
fresh runner restore 486 of 500 tasks, a universal-foundation edit 0 of 500. Detail in
[LIMITS.md](LIMITS.md#remote-cache-amortizing-the-orepo-cold-start).

Everything else is O(closure) or O(repo)-but-small (whole typecheck 1.6s, whole lint 0.25s).

## Real apps

The same tool set — bun 1.3.14, tsgo 7.0.2, oxlint 1.71.0, and turbo 2.9.18 per the record's
`versions`, on the dedicated 64-core box — against two real open-source Next.js apps at pinned commits
(`bench/real-app-bench.json`):

| app             | files / LOC | bun install   | tsgo --noEmit     | oxlint | turbo cold → warm       |
| --------------- | ----------- | ------------- | ----------------- | ------ | ----------------------- |
| vercel/commerce | 65 / 3.9k   | 528ms (76)    | **151ms** / 125MB | 60ms   | 219 → **57ms** (2 of 2) |
| shadcn/taxonomy | 125 / 7.5k  | 3351ms (1029) | **309ms** / 248MB | 59ms   | 358 → 373ms (1 of 2)    |

Per-app typecheck stays in the low hundreds of ms. The friction is config, not speed. **tsgo
refuses to start on a real Next tsconfig**, erroring in 137–280ms on removed options
(`baseUrl`, `moduleResolution: node`; commerce also `downlevelIteration`, taxonomy also
`target: es5`). Wiring an app in means modernizing the config and adding an ambient `*.css` decl.
Commerce then checks clean; taxonomy shows 13 (seven TS2307 cannot-find-module, six genuine
dependency drift). Turbo won't cache taxonomy's red typecheck until it goes green.

## Tool caveats

- **tsgo emits no `dist`** (turbo uses tsc via `^build`) and is stricter than tsc on
  module-resolution config. Parity is 25 / 25 locations on one `skipLibCheck` corpus, not a general
  proof.
- **bun ignores pnpm `catalog:`** — catalogs resolve to concrete versions before a bun install
  (`workspace:*` left intact).
- **bun is adoptable but not a strict safety superset of pnpm** (`bench/bun-safety-bench.json`,
  vs pnpm 12.8.1): two gaps (runs some registry `postinstall` scripts pnpm 12 blocks, failing the
  install; no fail-closed strict-peer knob — pnpm 12 exits 1 via its native config surface,
  ignoring the npm-style env surface pnpm 10 honored), one pnpm edge (phantom isolation in
  single-package projects), rest parity. See
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

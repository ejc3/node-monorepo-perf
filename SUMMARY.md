# A 4,000-App Monorepo on bun + tsgo + oxlint + turbo, Measured

Day-to-day costs when a pnpm + Turborepo monorepo of **4,000 Next.js apps and 400 shared
libraries** (4,400 packages; [the workspace under test](README.md#the-workspace-under-test)) runs
on one native-compiled tool per job. Figures trace to `bench/*.json`; extrapolations are labeled.

**Machines.**

- **arm64, 192-core c8g.48xlarge:** the 4,000:400 gate (`optimal-gate-bench.json`), inner-loop
  (`dev-loop-bench.json`), editor (`editor-loop-bench.json`), remote-cache (`ci-cache-bench.json`),
  and Vite Task (`vite-task-bench.json`) records. Each record carries its core count; the
  instance type is stated in the README's Results section and AGENTS.md's Data of Record.
- **64-core dedicated c7gd.metal:** the timing records cited here (fleet-gate, sliced-gate,
  typecheck-parity, install-bench, install-modes, pnpm12, pnp-compat, rspack-pnp, and real-app).
  `bun-safety-bench.json`, a behavior record with no timings, ran on a shared dev box of the
  same instance type. The machine and the record list are in the
  [README](README.md#the-64-core-machine).

**Versions.** The 192-core records: bun 1.4.2, tsgo 7.0.2 (`typescript@7`'s native `tsc`),
oxlint 1.86.0, turbo 2.9.18, typescript 6.0.3 (the oracle), Node 22. The 64-core fleet-gate
record ran the same tsgo, oxlint, and turbo with bun 1.3.14. The real-app record's versions are
under [Real apps](#real-apps).

## The one idea: O(repo) vs O(closure)

Which cost class you pay is decided by what you touch, not by repo size.

- **O(repo)**: whole-workspace operations (install, whole typecheck, revving a package every app
  imports). They scale with package count; on this stack they stay in **seconds**.
- **O(closure)**: anything scoped to one app/lib and the packages it imports (`turbo --filter`).
  The work tracks that closure, **not the repo**. Each turbo invocation also loads the whole
  graph, which grows with the repo: a 100-package focused build takes 11.9s at 2,000 apps and
  39.5s at 20,000, per `bench/results.json`. What `--affected` selects depends on the edit; a
  foundation edit selects every dependent.

A developer's day is almost entirely O(closure). The O(repo) operations (first clone, CI install,
core-lib rev) are infrequent and still fast.

## The Stack

| job                 | tool       | why                                                    |
| ------------------- | ---------- | ------------------------------------------------------ |
| install             | **bun**    | links the 4,400-package workspace in ~2.6s (warm store) |
| typecheck / gate    | **tsgo**   | typescript@7's native tsc; 8.8× tsc 6, same error locations |
| lint                | **oxlint** | native Rust; whole tree in 251ms                       |
| orchestrate + scope | **turbo**  | `--filter`/`--affected` + per-package caching          |

Against Vite+'s task runner (Vite Task), turbo wins whole-repo typecheck by 8.4–10.7× cold and
3.2–4.1× warm. Vite Task's focused warm run is 1.2× faster at 1,000 apps (0.83s vs 1.01s) and 7%
slower at 300 (0.81s vs 0.76s). On the 1,200-task test run Vite Task is 2.7× faster warm (1.0s vs
2.8s) and turbo 2.5× faster cold (7.1s vs 17.6s). Vite Task can't cache `next build`
(`bench/vite-task-bench.json`, [TOOLING.md](TOOLING.md#vite-vp-task-runner-and-tool-layer)).

## By role

Full per-role tables in [OPTIMAL-STACK.md](OPTIMAL-STACK.md).

- **App developer** (O(closure), `bench/dev-loop-bench.json`): keystroke loop is **~220ms tsgo
  typecheck + ~100ms oxlint lint**; onboard `bun install` 1.4s fresh / 0.9s subsequent; focused
  `turbo --filter` gate 7.8s cold (187 tasks) / 3.4s warm. tsgo and oxlint have no incremental
  cache, so first run matches steady state.
- **Lib developer** (O(closure)): tsgo ~230ms, oxlint ~104ms; pre-merge `turbo --filter=...lib` gate
  9.6s cold (237 tasks) / 3.8s warm; the blast radius is the lib's dependents, not the repo. Revving
  a workspace dep is a source edit only (symlinks, no reinstall/publish).
- **Workspace author** (O(repo), the worst case: rev the universal foundation lib all 4,000 apps
  import, `bench/optimal-gate-bench.json`): one tsgo program gates every dependent clean in
  **1.59s** and catches a breaking change in **1.55s**, with 4,000 / 4,000 apps red and named
  (TS2554). The same gate through turbo takes 46.9s / 4,800 tasks; that path also emits dist,
  while the single tsgo process reads each lib's source once and skips the 400 dist builds.
  tsgo agrees with tsc: **0 missed, 0 false-positive** on 25 injected real-type errors, on a
  separate type-heavy 4,000:400 scaffold (`bench/typecheck-parity-bench.json`). An npm-dep
  version bump edits **1** workspace-yaml line with a catalog, and **one manifest per consumer
  (4,399 manifests)** with per-consumer pins (`bench/lib-rev-bench.json`).
- **Workspace author at fleet scale** (30,000 apps, ~1.03M generated files; 64-core box): the
  same gate is **58.1s** clean (10.9× faster than the per-package turbo path, which also emits
  dist) and **58.9s** to a full 30,000-apps-red breaking verdict
  (`bench/fleet-gate-bench.json`, [FLEET.md](FLEET.md)). Sliced into K concurrent programs, the
  same check takes **10.3s** on 64 cores and **6.2s** on 192, with the identical verdict
  union-verified (`bench/sliced-gate-bench.json` + `.pbox.json`,
  [FLEET.md](FLEET.md#the-sliced-gate-using-the-whole-box)).
- **Opening the editor** (`bench/editor-loop-bench.json`, 4,000 apps / 300 libs): cold open
  (spawn → first def) tsserver 1,563ms vs tsgo LSP **113ms** (13.8×); peak RSS 414MB vs **309MB**;
  warm go-to-def/hover ≤2ms both. Cost tracks the opened app's closure (65 libs / 1,123 files), flat
  as the repo grows 8×. Detail in [LIMITS.md](LIMITS.md#editor-and-language-server).

## What stays expensive

Two operations are O(repo) and cannot be scoped away:

- **Install** of the whole workspace (~2.6s warm store at 4,000:400), paid on clean clone or CI.
  pnpm 12.8.1's no-lockfile cold resolve is 2.9s at 1,000:200 and within 3% of a frozen
  warm-store install (2.8s; `bench/install-modes-bench.json`); the JS CLI paid 307.4s on that
  resolve (`bench/pnpm12-bench.json`). Against bun (`bench/install-bench.json`), bun cold is
  ~1.6× faster at 200 apps and ~1.7× faster truly-cold (1.3s vs 2.2s). **pnpm-hoisted is
  3.1–3.4× faster than bun cold at the measured 1,000- and 2,000-app points** and the fastest
  configuration cold and warm there (0.96s/2.5s cold, 0.59s/1.1s warm); bun's cold is the
  slowest configuration at 2,000. yarn-PnP is third cold at 1,000 (2.3s, behind pnpm-isolated's
  2.1s) and second at 2,000 (3.2s), but PnP can't run stock tsgo or Next's default Turbopack
  (`bench/pnp-compat-bench.json`). Native-PnP tsgo is the green path for the checker.
  `next build` under PnP depends on the node version: webpack and rspack build on node 22.22.0,
  and every builder fails on 22.23.3, per `bench/rspack-pnp-bench.json`. The bun-vs-yarn
  reconciliation is in [OPTIMAL-STACK.md](OPTIMAL-STACK.md#installing-the-workspace); yarn as a
  rollout driver is vetted in [ROLLOUT.md](ROLLOUT.md#yarn-as-a-driver).
- **A whole-repo dist build** scales with package count.
- **One large app's `next build`** does not split by package. On a 2,071-route app,
  Turbopack's module graph phase takes <!--v:sc.base.16.graph-->9.62s<!--/v--> at 16 cores and <!--v:sc.base.96.graph-->15.62s<!--/v--> at 96.
  Two Turbopack patches cut it to <!--v:ab.15+22.ratio-->0.360<!--/v-->× on a 24-core lane and the Turbopack compile to
  <!--v:ab.15+22.guard-->0.713<!--/v-->× ([TURBOPACK-GRAPH.md](TURBOPACK-GRAPH.md), `bench/turbopack-graph-ab.json`,
  `bench/turbopack-graph-scaling.json`; on a 192-core c8g.48xlarge).

Whole-repo build and typecheck amortize across a CI fleet via a remote cache: after the first
runner seeds it, each later runner restores instead of recomputing. Whole-repo typecheck goes 9.9s →
1.5s (6.8×) at 300:100 and 24.8s → 3.9s (6.4×) at 1,000:200 (`bench/ci-cache-bench.json`). The cache
helps only the second-and-later consumer of an *unchanged* artifact: at 300:100, a leaf edit lets a
fresh runner restore 486 of 500 tasks, a universal-foundation edit 0 of 500. Detail in
[LIMITS.md](LIMITS.md#remote-cache-amortizing-the-orepo-cold-start).

Everything else is O(closure) or O(repo)-but-small (whole typecheck 1.6s, whole lint 0.25s).

## Real apps

The same tool set on two open-source Next.js apps at pinned commits (`bench/real-app-bench.json`;
bun 1.3.14, tsgo 7.0.2, oxlint 1.71.0, and turbo 2.9.18 per the record's `versions`; the
dedicated 64-core box):

| app             | files / LOC | bun install   | tsgo --noEmit     | oxlint | turbo cold → warm       |
| --------------- | ----------- | ------------- | ----------------- | ------ | ----------------------- |
| vercel/commerce | 65 / 3.9k   | 528ms (76)    | **151ms** / 125MB | 60ms   | 219 → **57ms** (2 of 2) |
| shadcn/taxonomy | 125 / 7.5k  | 3351ms (1029) | **309ms** / 248MB | 59ms   | 358 → 373ms (1 of 2)    |

Per-app typecheck stays in the low hundreds of ms; the friction is config, not speed. **tsgo
refuses to start on a real Next tsconfig**, erroring in 137–280ms on removed options
(`baseUrl`, `moduleResolution: node`; commerce also `downlevelIteration`, taxonomy also
`target: es5`). Wiring an app in means modernizing the config and adding an ambient `*.css` decl.
Commerce then checks clean; taxonomy shows 13 errors (seven TS2307 cannot-find-module, six
from real dependency drift). Turbo won't cache taxonomy's red typecheck until it goes green.

## Tool caveats

- **tsgo emits no `dist`** (turbo uses tsc via `^build`) and is stricter than tsc on
  module-resolution config. Parity is 25 / 25 locations on one `skipLibCheck` corpus, not a general
  proof.
- **bun ignores pnpm `catalog:`**, so catalogs are resolved to concrete versions before a bun
  install (`workspace:*` stays intact).
- **bun is adoptable but not a strict safety superset of pnpm** (`bench/bun-safety-bench.json`,
  vs pnpm 12.8.1). Two gaps: bun runs some registry `postinstall` scripts that pnpm 12 blocks
  and fails the install on, and bun has no fail-closed strict-peer knob (pnpm 12 exits 1 via its
  native config surface and ignores the npm-style env surface pnpm 10 honored). One pnpm edge:
  phantom-dependency isolation in single-package projects. The rest is parity
  ([ROLLOUT.md](ROLLOUT.md#adoption-safety)).
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

# A 4,000-App Monorepo on bun + tsgo + oxlint + turbo, Measured

Day-to-day costs when a pnpm + Turborepo monorepo of **4,000 Next.js apps and 400 shared
libraries** (4,400 packages; [the workspace under test](README.md#the-workspace-under-test)) runs
on one native-compiled tool per job. Figures trace to `bench/*.json`; extrapolations are labeled.

**Machines and versions.** The 4,000:400 gate, inner-loop, editor, remote-cache, and Vite Task
records ran on a 192-core c8g.48xlarge (bun 1.4.2, tsgo 7.0.2, oxlint 1.86.0, turbo 2.9.18,
typescript 6.0.3 as the oracle, Node 22). The fleet-gate, sliced-gate, parity, install, pnpm 12,
PnP, and real-app records ran on the dedicated 64-core c7gd.metal (the fleet gate with bun 1.3.14
and the same tsgo, oxlint, and turbo); `bun-safety-bench.json`, a behavior record with no
timings, ran on a shared box of the same type ([README](README.md#the-64-core-machine)).

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
foundation-lib rev) are infrequent and still fast.

## The Stack

| job                 | tool       | why                                                    |
| ------------------- | ---------- | ------------------------------------------------------ |
| install             | **bun**    | links the 4,400-package workspace in ~2.6s (warm store) |
| typecheck / gate    | **tsgo**   | typescript@7's native tsc; 8.8× faster than tsc 6 on the type-heavy 4,000:400 parity corpus, same injected-error locations |
| lint                | **oxlint** | native Rust; whole tree in 251ms                       |
| orchestrate + scope | **turbo**  | `--filter`/`--affected` + per-package caching          |

Against Vite+'s task runner, turbo wins whole-repo typecheck (8.4–10.7× cold); Vite Task wins the
warm focused run at 1,000 apps and the warm test run, and can't cache `next build`
([TOOLING.md](TOOLING.md#vite-vp-task-runner-and-tool-layer)).

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

Two whole-workspace operations are O(repo) and cannot be scoped away; a large app's build adds a
separate cost:

- **Install** of the whole workspace (~2.6s warm store at 4,000:400), paid on clean clone or CI.
  The fastest installer depends on scale and install state: bun is ~1.6× faster than pnpm-isolated
  cold (no lockfile, warm store) at 200 apps and leads the fresh CI frozen install, while
  pnpm-hoisted is 3.1–3.4× faster than bun cold at 1,000–2,000 apps; pnpm 12's Rust CLI removed
  pnpm 10's 307.4s cold resolve (1,000:200). yarn-PnP is second-fastest cold at 2,000 apps but cannot run stock tsgo or Next's
  default Turbopack. Numbers: [TOOLING.md](TOOLING.md#install-bun-vs-pnpm-vs-yarn-4); the
  bun-vs-yarn reconciliation: [OPTIMAL-STACK.md](OPTIMAL-STACK.md#installing-the-workspace).
- **A whole-repo dist build** scales with package count.
- **One large app's `next build`** does not split by package. On a 2,071-route app,
  Turbopack's module graph phase takes <!--v:sc.base.16.graph-->9.62s<!--/v--> at 16 cores and <!--v:sc.base.96.graph-->15.62s<!--/v--> at 96.
  Two Turbopack patches cut it to <!--v:ab.15+22.ratio-->0.360<!--/v-->× on a 24-core lane and the Turbopack compile to
  <!--v:ab.15+22.guard-->0.713<!--/v-->× ([TURBOPACK-GRAPH.md](TURBOPACK-GRAPH.md), 192-core c8g.48xlarge).
  With new imports, most of a warm `next build`'s emit runs on one core carrying collectible
  changes up the task graph; recording a task's taken collectibles as one operation instead of
  one per collectible (candidate 56) takes emit at 1,000 new imports from
  <!--v:dr.c56.import.base.1000.warm.emit-->39.0s<!--/v--> to <!--v:dr.c56.import.56-batch-unemit-collectibles.1000.warm.emit-->26.9s<!--/v-->
  ([cache-drift.md](bench/turbopack-gym/cache-drift.md)); merging the updates a task's new
  children make on each upper into one (candidate 57) takes it from <!--v:dr.c57.import.15+22+55+56.1000.warm.emit-->26.9s<!--/v--> to
  <!--v:dr.c57.import.15+22+55+56+57.1000.warm.emit-->16.9s<!--/v--> on top of 15 + 22 + 55 + 56.
  Collecting emit's issues without one aggregation root per endpoint (candidate 59) takes the
  warm build's `run-turbopack` at 1,000 new imports from <!--v:dr.c59.import.15+22+55+56+57.1000.warm.turbopack-->52.7s<!--/v--> to
  <!--v:dr.c59.import.15+22+55+56+57+59.1000.warm.turbopack-->34.2s<!--/v-->.
  With every binding change that kept the output, on 24 CPUs a cold `next build` goes from
  <!--v:dr.full24.import.base.0.cold.wall-->63.1s<!--/v--> to <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.0.cold.wall-->35.8s<!--/v--> and a warm one after one new import from <!--v:dr.full24.import.base.1.warm.wall-->74.5s<!--/v--> to
  <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.1.warm.wall-->28.6s<!--/v--> ([cache-drift.md](bench/turbopack-gym/cache-drift.md#everything-together)).

Whole-repo build and typecheck amortize across a CI fleet through a remote cache (typecheck 9.9s →
1.5s at 300:100, 24.8s → 3.9s at 1,000:200), but only for tasks an edit leaves unchanged: at
300:100, after a leaf edit a fresh runner restores 486 of 500 tasks, after a universal-foundation
edit 0 ([LIMITS.md](LIMITS.md#remote-cache-amortizing-the-orepo-cold-start)).

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
- **bun is adoptable but not a strict safety superset of pnpm**: two gaps (registry `postinstall`
  scripts that pnpm 12 blocks and fails the install on; no fail-closed strict-peer knob) and one
  pnpm edge (phantom-dependency isolation in single-package projects); the rest is parity
  ([ROLLOUT.md](ROLLOUT.md#adoption-safety)).
- Focused-gate **warm** numbers carry turbo's per-invocation graph-load over the 4,400-package
  workspace and are noisy (medians of three); the keystroke loop runs tsgo/oxlint directly, not
  through turbo.

## Reproducing

`node scripts/dev-loop-bench.mjs 4000:400` (app + lib inner loops),
`node scripts/optimal-gate-bench.mjs 4000:400` (foundation-lib gate),
`node scripts/typecheck-parity-bench.mjs 4000:400:8` (tsgo-vs-tsc parity). Destructive ones run in a
throwaway git worktree; dev-loop and parity refuse on a loaded box. Side tables draw on
`scripts/real-app-bench.mjs`, `scripts/install-modes-bench.mjs`, `scripts/install-bench.mjs`, and
`scripts/lockfile-merge-bench.mjs`. Source of record is `bench/*.json`.

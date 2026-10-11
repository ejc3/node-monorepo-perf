# The Optimal Stack: bun + tsgo + oxlint + turbo at 4,000 Apps / 400 Libs

One native-compiled tool per job, with no slower baseline in the loop. Sources of record:
`bench/optimal-gate-bench.json` (4000:400), `bench/typecheck-parity-bench.json` (4000:400:8),
`bench/dev-loop-bench.json` (4000:400), `bench/real-app-bench.json`,
`bench/decl-emit-caveat.json`.

| job                 | tool                                     | version |
| ------------------- | ---------------------------------------- | ------- |
| install             | **bun**                                  | 1.4.2   |
| typecheck / gate    | **tsgo** (`typescript@7`'s native `tsc`) | 7.0.2   |
| lint                | **oxlint** (oxc)                         | 1.86.0  |
| orchestrate + scope | **turbo**                                | 2.9.18  |

Pin `typescript` exactly; TypeScript 6 stays installed as the oracle and for tsserver
([TYPECHECKERS.md](TYPECHECKERS.md#tsc-vs-tsgo)). All five records ran typescript 7.0.2: the
gate and inner-loop records on a 192-core c8g.48xlarge, the parity and real-app records on the
dedicated 64-core c7gd.metal ([README](README.md#the-64-core-machine)).

## The Scenario

A library owner revs a foundation lib that every app imports (`@demo/lib-001`;
[the workspace under test](README.md#the-workspace-under-test) generated with `--universal 1`,
which turns the foundation tier on). The daily question at 4,000 apps / 400 libs: catch a
breaking type error from that rev in any of the 4,000 apps before merge, fast.

## Installing the Workspace

`bun install` materializes the 4,400-package workspace in **2.6s** with a warm store, the
lockfile present, and `node_modules` cold (`install.storeWarm: true`): the clone or CI-runner
case. It is one-time setup; revving a lib needs no reinstall.

Which install case matters depends on the runner: bun leads cold at 200 apps (~1.6×) and on
the fresh CI-runner frozen install (pnpm 11% behind, 1.03s vs 0.93s at 1,000 apps), while
pnpm-hoisted is 3.1–3.4× faster than bun cold at 1,000–2,000 apps
([TOOLING.md](TOOLING.md#install-bun-vs-pnpm-vs-yarn-4)).

A yarn-PnP variant has a compatibility boundary: stock tsgo and Next's default Turbopack fail
under PnP while tsc, turbo, and oxlint work, and a native-PnP tsgo build runs the gate through
`.pnp.cjs` at full fleet scale ([TOOLING.md](TOOLING.md#yarn-pnp-toolchain-compatibility)).

## The Whole-Workspace Type-Error Gate

A universal rev has nothing to scope away: every app re-checks. The fastest gate is one tsgo
process over the whole workspace reading lib **source** (`tsgo --noEmit -p
tsconfig.whole.json`, `@demo/*`→`packages/*/src/index.ts`). It parses each lib once, shares it
across every importing app, and skips the per-lib dist builds. At 4,000:400 it typechecks the
tree in **1.59s** at **857MB** peak RSS. It is typecheck-only and emits no `dist`.

Vite+'s one-pass `vp check` takes 2.35s where this gate shape takes 0.42s on a
920-source-file corpus (921 for `vp check`, which also checks the root `vite.config.ts`), with a different type-check model (one tsgo program over lib source
vs tsgolint's per-file typed lint), so it is not a like-for-like engine comparison
([TOOLING.md](TOOLING.md#vite-vp-task-runner-and-tool-layer)).

## Catching a Breaking Change

A breaking foundation signature turns **every** dependent app red in **1.55s**: **4,000 of
4,000 apps** report `error TS2554: Expected 2 arguments, but got 1` (4,399 TS2554: 4,000 apps
+ 399 dependent libs).

The same gate holds at the 30,000-app fleet scale: 58.1s clean and 58.9s to all 30,000 apps
red on 64 cores, 10.3s / 6.2s when sliced across 64 / 192 cores with an identical verdict
([FLEET.md](FLEET.md)).

## Parity with tsc on Real Types

A self-contained vet (`bench/typecheck-parity-bench.json`) runs the whole-program shape over a
throwaway 4,000:400:8 scaffold whose libs carry heavy types (recursive conditional + mapped
types, 48-member unions, cross-lib intersections) instead of the standard workspace's 16-line
re-export modules. One tsgo program checks it in **1.92s** at **1279MB** peak RSS; tsc (the
TypeScript 6 oracle) takes **16.9s** (**8.8×**). On the valid tree both report **0**. With 25
injected error sites, tsgo flags the same **25 locations**, missing **0** and adding **0**.
Codes match on 20 of 25: at the arg-type site tsc emits `TS2345` and tsgo `TS2739`.

## The Orchestrated turbo Path

`turbo run typecheck:tsgo --filter=...@demo/lib-001` runs one tsgo per package against built
`dist`: **4,800 of 4,800 tasks** cold in **46.9s**. It also emits every lib's `dist` (tsc
`^build`), which a deploy needs and the whole-program gate does not. For a universal rev the
whole-program gate is ~30× faster (1.59s vs 46.9s); turbo's value here is the dist artifacts and
the per-package cache on the next run.

## Scoping a Non-Universal Rev

A leaf lib rev (`...@demo/lib-400`) runs **237 of 4,800 tasks** in **8.6s**: the graph tracks
that lib's closure, not the repo. A universal rev takes one tsgo program; a scoped rev takes
`turbo --filter=...<lib>` (or `--affected`).

## The Developer Inner Loops

The two day-to-day roles each touch one package and the libs it imports, so their work is
scoped to that closure by construction. Measured at 4,000:400 for one mid app (`@demo/app-2000`)
and one leaf lib (`@demo/lib-400`), fresh / subsequent (`bench/dev-loop-bench.json`):

| step                               | app dev (fresh / subsequent) | lib dev (fresh / subsequent) |
| ---------------------------------- | ---------------------------- | ---------------------------- |
| typecheck-on-save (tsgo, from src) | 207 / **223ms** (107MB)      | 265 / **232ms** (104MB)      |
| lint-on-save (oxlint, one dir)     | 99 / **104ms**               | 107 / **104ms**              |
| focused gate (turbo, cold / warm)  | **7.8s** / **3.4s** (187)    | **9.6s** / **3.8s** (237)    |

Onboarding `bun install` takes **1.4s** fresh (cold `node_modules`) and **0.9s** subsequent
(warm). tsgo and oxlint keep no incremental cache, so the first run matches steady state within
noise; that is why they run directly on every save, not through turbo. A foundation-lib rev is
O(repo) (1.6s as one tsgo program); a developer's edit reaches only their closure (~220ms).

## Real Apps, Lint, Caveats

- **Real-app vet.** The stack holds on real product code. On vercel/commerce (3.9k LOC) and
  shadcn/taxonomy (7.5k LOC), per-app tsgo `--noEmit` takes 151ms / 309ms and oxlint ~60ms.
  tsgo needs a modernized tsconfig and an ambient `*.css` declaration to start
  (`bench/real-app-bench.json`; bun 1.3.14, oxlint 1.71.0 per its `versions`).
- **Lint.** oxlint checks the whole 4,400-package tree in **251ms** (0 findings), off the
  critical path.
- **Declaration-emit caveat.** The gate's `declaration:false` validates the code but not the
  published `.d.ts`. On a self-contained scaffold, a declaration-portability error passes the
  gate but is flagged under `declaration:true` with no emit needed (`TS2883` under both
  checkers since TypeScript 6; tsc 5.9 reported `TS2742`). `.d.ts` validation therefore stays
  with the per-package build (`bench/decl-emit-caveat.json`).

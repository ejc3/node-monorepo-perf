# The Optimal Stack: bun + tsgo + oxlint + turbo at 4,000 Apps / 400 Libs

One native-compiled tool per job, no slower baseline in the loop. The sources of record are
`bench/optimal-gate-bench.json` (4000:400), `bench/typecheck-parity-bench.json` (4000:400:8),
`bench/dev-loop-bench.json` (4000:400), `bench/real-app-bench.json`,
`bench/decl-emit-caveat.json`, `bench/env.json`.

| job                 | tool                                     | version |
| ------------------- | ---------------------------------------- | ------- |
| install             | **bun**                                  | 1.4.2   |
| typecheck / gate    | **tsgo** (`typescript@7`'s native `tsc`) | 7.0.2   |
| lint                | **oxlint** (oxc)                         | 1.86.0  |
| orchestrate + scope | **turbo**                                | 2.9.18  |

TypeScript 7 is GA: the native compiler ships as `typescript` with a `tsc` binary (the tsgo
name is retired; this repo keeps `tsgo` as the task and record label). Pin the exact version,
the same discipline as the old nightly pin. TypeScript 6, the last JS release, stays
installed as the `typescript6` alias — the oracle checker and the tsserver. The gate and
inner-loop records (`bench/optimal-gate-bench.json`, `bench/dev-loop-bench.json`),
`bench/typecheck-parity-bench.json`, and `bench/decl-emit-caveat.json` are measured on
typescript 7.0.2; the gate and inner-loop records on a 192-core c8g.48xlarge (arm64, per
each record's `machine`/`cores`). `bench/real-app-bench.json` is still the
`7.0.0-dev.20260614.1` nightly on the 64-core box.

## The Scenario

A library owner revs a foundation lib every app imports (`@demo/lib-001`:
[the workspace under test](README.md#the-workspace-under-test) generated `--universal 1`, the
foundation tier on). At 4,000 apps / 400 libs the daily question: rev it and catch a breaking
type error in any of the 4,000 apps before merge, fast.

## Installing the Workspace

`bun install` materializes the 4,400-package workspace in **2.6s** (warm store, lockfile
present, `node_modules` cold — the warm-store clone/CI-runner materialization case;
`install.storeWarm: true`). One-time
setup; revving a lib needs no reinstall. Which install case matters depends on the runner.
Against pnpm 12.8.1 (the Rust CLI) the full re-resolve is scale-dependent — bun ~5× faster
at 200 apps, pnpm-hoisted 2.4–3.8× faster than bun at 1,000–2,000 — and on the fresh CI-runner
frozen install bun is 6% ahead (1.03s vs pnpm 1.09s at 1,000 apps,
`bench/container-install-bench.json`). At 2,000 apps pnpm-hoisted is fastest cold (2.5s, with
yarn-PnP second at 3.2s) and fastest warm (2.1s). Per-cell numbers
in [TOOLING.md](TOOLING.md#install-bun-vs-pnpm-vs-yarn-4). A yarn-PnP variant has a
compatibility boundary (stock tsgo and Next's default Turbopack fail under PnP; tsc/turbo/oxlint
work; measured at 20:10 in `bench/pnp-compat-bench.json` and at full fleet scale in
`bench/yarn-fleet-bench.json`, where stock tsgo fails with 30,000 unresolved-name errors and the
native-PnP build runs the gate through `.pnp.cjs`). The checker's green path is the native-PnP
tsgo; `next build` under PnP builds via webpack/rspack on node 22.22.0 and fails on every
builder on node 22.23.3
(`bench/tsgo-pnp-bench.json` + `bench/rspack-pnp-bench.json`;
[TOOLING.md](TOOLING.md#yarn-pnp-toolchain-compatibility)).

## The Whole-Workspace Type-Error Gate

A universal rev has nothing to scope away — every app re-checks. The fastest gate is a
single tsgo process over the whole workspace reading lib **source** (`tsgo --noEmit -p
tsconfig.whole.json`, `@demo/*`→`packages/*/src/index.ts`): one process parses each lib once,
shares it across every importing app, skips the per-lib dist builds. At 4,000:400 it
typechecks the tree in **1.59s**, peak RSS **857MB**. Typecheck-only;
emits no `dist`.

The integrated alternative, Vite+'s `vp check`, takes 2.56s on a 920-source-file corpus (921 files for `vp check`, which also checks the root
`vite.config.ts`) where this
stack's gate shape takes 0.80s (`bench/vite-plus-tools-bench.json`).

## Catching a Breaking Change

A breaking foundation signature turns **every** dependent app red: **4,000 of 4,000 apps**
report `error TS2554: Expected 2 arguments, but got 1` (4,399 TS2554: 4,000 apps + 399
dependent libs), in **1.55s**. Catch a type error in one of the 4,000 apps before it ships,
in about a second and a half.

The same gate holds at the measured production-fleet scale (30,000 apps / 460 libs,
~1.03M generated files; 64-core box): clean in **61.2s** (10.8× faster than the orchestrated per-package path, which also emits
dist, as at 4,000:400), breaking rev caught with all 30,000 apps red in **61.7s** — and a bigger box
does not speed it up (66.6s on 192 cores)
([FLEET.md](FLEET.md), `bench/fleet-gate-bench.json`, `bench/fleet-gate-bench.pbox.json`).
Slicing the same check into K concurrent programs (all lib source + 1/K of the apps) cuts
it to **12.1s** on 64 cores and **6.2s** on 192 with a union-verified identical verdict
([FLEET.md](FLEET.md#the-sliced-gate-using-the-whole-box), `bench/sliced-gate-bench.json` +
`.pbox.json`).

## Parity with tsc on Real Types

A self-contained vet (`bench/typecheck-parity-bench.json`) runs the one-program shape over its
own throwaway scaffold at 4,000:400:8 — libs carrying genuinely heavy types (recursive
conditional + mapped types, 48-member unions, cross-lib intersections), not the standard
workspace's 16-line re-export modules, so the parity claim rests on real type complexity. One
tsgo program checks it in **2.04s**, peak RSS **1280MB**.
On the valid tree both tsc (the TypeScript 6 oracle) and tsgo report **0**. Injecting 25
error sites, tsgo flags the
same **25 locations**, missing **0** and adding **0**; codes match on 20 of 25 (at the
arg-type site tsc emits `TS2345`, tsgo `TS2739`). On the same check tsc takes **17.8s** to
tsgo's 2.04s (**8.7×**).

## The Orchestrated turbo Path

`turbo run typecheck:tsgo --filter=...@demo/lib-001` runs one tsgo per package against built
`dist`: **4,800 of 4,800 tasks** cold in **46.9s**, also emitting every lib's `dist` (tsc
`^build`), which a deploy needs and the type-error gate does not. For a universal rev the
one-program gate is ~30× faster (1.59s vs 46.9s); turbo's value here is the dist artifacts
and the per-package cache on the next run.

## Scoping a Non-Universal Rev

A leaf lib (`...@demo/lib-400`) runs only **237 of 4,800 tasks** in **8.6s** — the graph
tracks that lib's closure, not the repo. A universal rev takes one tsgo program; a scoped rev
takes `turbo --filter=...<lib>` (or `--affected`).

## The Developer Inner Loops

The two day-to-day roles each touch one package and the libs it imports, scoped to that
closure by construction. Measured at 4,000:400 for one mid app (`@demo/app-2000`) and one
leaf lib (`@demo/lib-400`), fresh / subsequent (`bench/dev-loop-bench.json`):

| step                               | app dev (fresh / subsequent) | lib dev (fresh / subsequent) |
| ---------------------------------- | ---------------------------- | ---------------------------- |
| typecheck-on-save (tsgo, from src) | 207 / **223ms** (107MB)      | 265 / **232ms** (104MB)      |
| lint-on-save (oxlint, one dir)     | 99 / **104ms**               | 107 / **104ms**              |
| focused gate (turbo, cold / warm)  | **7.8s** / **3.4s** (187)    | **9.6s** / **3.8s** (237)    |

Onboarding `bun install` runs fresh in **1.4s** (cold `node_modules`), subsequent **0.9s**
(warm). tsgo and oxlint have no incremental cache, so first run matches steady state within
noise — that is why they run on every save directly, not through turbo. A core-package rev is
O(repo) (1.6s as one tsgo program); a developer's edit reaches only their closure (~220ms).

## Real Apps, Lint, Caveats

- **Real-app vet.** The stack holds on real product code: cloning vercel/commerce (3.9k LOC)
  and shadcn/taxonomy (7.5k LOC), per-app tsgo `--noEmit` stays in the low hundreds of ms
  (128ms / 229ms), oxlint ~60–80ms; tsgo needs a modernized tsconfig + an ambient `*.css`
  decl to start (`bench/real-app-bench.json`).
- **Lint.** oxlint checks the whole 4,400-package tree in **251ms** (0 findings), off the
  critical path.
- **Declaration-emit caveat.** The gate's `declaration:false` validates the code but not the
  published `.d.ts`: on a self-contained scaffold, a declaration-portability error passes the
  gate yet is flagged under
  `declaration:true` (`TS2883` under both checkers since TypeScript 6; tsc 5.9 reported
  `TS2742`) with no emit needed, so `.d.ts` validation
  stays with the per-package build (`bench/decl-emit-caveat.json`).

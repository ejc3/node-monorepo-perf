# The Optimal Stack: bun + tsgo + oxlint + turbo at 4,000 Apps / 400 Libs

One native-compiled tool per job, no slower baseline in the loop. Sources of record:
`bench/optimal-gate-bench.json` (4000:400), `bench/typecheck-parity-bench.json` (4000:400:8),
`bench/dev-loop-bench.json` (4000:400), `bench/real-app-bench.json`,
`bench/decl-emit-caveat.json`, `bench/env.json`.

| job                 | tool                                    | version              |
| ------------------- | --------------------------------------- | -------------------- |
| install             | **bun**                                 | 1.3.14               |
| typecheck / gate    | **tsgo** (`@typescript/native-preview`) | 7.0.0-dev.20260614.1 |
| lint                | **oxlint** (oxc)                        | 1.71.0               |
| orchestrate + scope | **turbo**                               | 2.9.18               |

## The Scenario

A library owner revs a foundation lib every app imports (`@demo/lib-001`, generated
`--universal 1`). At 4,000 apps / 400 libs the daily question: rev it and catch a breaking
type error in any of the 4,000 apps before merge, fast.

## Installing the Workspace

`bun install` materializes the 4,400-package workspace in **20.9s** (warm store, lockfile
present, `node_modules` cold — the clone/CI case; `install.storeWarm: true`). One-time
setup; revving a lib needs no reinstall. Which install case matters depends on the runner:
bun wins the full re-resolve (~62–357× vs pnpm) and the fresh CI-runner install (0.9s vs
pnpm's 8.9s at 1,000 apps); at 2,000 apps yarn 4 is fastest cold and warm. Per-cell numbers
in [TOOLING.md](TOOLING.md#install-bun-vs-pnpm-vs-yarn-4). A yarn-PnP variant has a
compatibility boundary (stock tsgo and Next's default Turbopack fail under PnP; tsc/turbo/oxlint
work; `bench/pnp-compat-bench.json`), with green paths (`bench/tsgo-pnp-bench.json` +
`bench/rspack-pnp-bench.json`).

## The Whole-Workspace Type-Error Gate

A universal rev has nothing to scope away — every app re-checks. The fastest gate is a
single tsgo process over the whole workspace reading lib **source** (`tsgo --noEmit -p
tsconfig.whole.json`, `@demo/*`→`packages/*/src/index.ts`): one process parses each lib once,
shares it across every importing app, skips the per-lib dist builds. At 4,000:400 it
typechecks the tree in **1.32s**, peak RSS **911MB** (0.7% of the 135GB box). Typecheck-only;
emits no `dist`.

The integrated alternative, Vite+'s `vp check`, takes 2.44s on a 920-file corpus where this
stack's gate shape takes 0.77s (`bench/vite-plus-tools-bench.json`).

## Catching a Breaking Change

A breaking foundation signature turns **every** dependent app red: **4,000 of 4,000 apps**
report `error TS2554: Expected 2 arguments, but got 1` (4,399 TS2554: 4,000 apps + 399
dependent libs), in **1.39s**. Catch a type error in one of the 4,000 apps before it ships,
in under a second and a half.

## Parity with tsc on Real Types

A self-contained vet (`bench/typecheck-parity-bench.json`) runs the one-program shape over a
type-heavy tree (recursive conditional + mapped types, 48-member unions, cross-lib
intersections) at 4,000:400:8. One tsgo program checks it in **1.96s**, peak RSS **1281MB**.
On the valid tree both tsc and tsgo report **0**. Injecting 25 error sites, tsgo flags the
same **25 locations**, missing **0** and adding **0**; codes match on 20 of 25 (at the
arg-type site tsc emits `TS2345`, tsgo `TS2739`). On the same check tsc takes **17.2s** to
tsgo's 1.96s (**8.8×**).

## The Orchestrated turbo Path

`turbo run typecheck:tsgo --filter=...@demo/lib-001` runs one tsgo per package against built
`dist`: **4,800 of 4,800 tasks** cold in **80.1s**, also emitting every lib's `dist` (tsc
`^build`), which a deploy needs and the type-error gate does not. For a universal rev the
one-program gate is ~60× faster (1.32s vs 80.1s); turbo's value here is the dist artifacts
and the per-package cache on the next run.

## Scoping a Non-Universal Rev

A leaf lib (`...@demo/lib-400`) runs only **237 of 4,800 tasks** in **22.4s** — the graph
tracks that lib's closure, not the repo. A universal rev takes one tsgo program; a scoped rev
takes `turbo --filter=...<lib>` (or `--affected`).

## The Developer Inner Loops

The two day-to-day roles each touch one package and the libs it imports, scoped to that
closure by construction. Measured at 4,000:400 for one mid app (`@demo/app-2000`) and one
leaf lib (`@demo/lib-400`), fresh / subsequent (`bench/dev-loop-bench.json`):

| step                               | app dev (fresh / subsequent) | lib dev (fresh / subsequent) |
| ---------------------------------- | ---------------------------- | ---------------------------- |
| typecheck-on-save (tsgo, from src) | 167 / **168ms** (187MB)      | 190 / **190ms** (189MB)      |
| lint-on-save (oxlint, one dir)     | 64 / **60ms**                | 70 / **65ms**                |
| focused gate (turbo, cold / warm)  | **19.1s** / **15.2s** (187)  | **22.8s** / **13.6s** (237)  |

Onboarding `bun install` runs fresh in **20.6s** (cold `node_modules`), subsequent **3.8s**
(warm). tsgo and oxlint have no incremental cache, so first run matches steady state within
noise — that is why they run on every save directly, not through turbo. A core-package rev is
O(repo) (1.4s as one tsgo program); a developer's edit reaches only their closure (~170ms).

## Real Apps, Lint, Caveats

- **Real-app vet.** The stack holds on real product code: cloning vercel/commerce (3.9k LOC)
  and shadcn/taxonomy (7.5k LOC), per-app tsgo `--noEmit` stays in the low hundreds of ms
  (128ms / 229ms), oxlint ~60–80ms; tsgo needs a modernized tsconfig + an ambient `*.css`
  decl to start (`bench/real-app-bench.json`).
- **Lint.** oxlint checks the whole 4,400-package tree in **180ms** (0 findings), off the
  critical path.
- **Declaration-emit caveat.** The gate's `declaration:false` validates the code but not the
  published `.d.ts`: a declaration-portability error passes the gate yet is flagged under
  `declaration:true` (tsc `TS2742` / tsgo `TS2883`) with no emit needed, so `.d.ts` validation
  stays with the per-package build (`bench/decl-emit-caveat.json`).

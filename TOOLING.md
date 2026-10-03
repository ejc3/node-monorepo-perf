# Tooling Comparisons

## Install: bun vs pnpm vs yarn 4

`scripts/install-bench.mjs`, installing [the workspace under test](README.md#the-workspace-under-test) at the table's apps/libs scales (`bench/env.json`: Neoverse-V1, 64 cores, 135 GB). Each manager runs its default and alternate linkers; non-linker knobs are normalized across tools (dependency build scripts are disabled for every tool, registries and caches pinned — see the script header). Tool provenance is in the record and pin-asserted: pnpm 12.8.1 — the Rust CLI, probed through the per-scaffold `packageManager` pin — bun 1.3.14, yarn 4.18.1:

- pnpm-isolated (default) / pnpm-hoisted (flat)
- bun (isolated `node_modules/.bun` store since 1.3)
- yarn 4.18.1 under `node-modules` (flat) and PnP (its default: no `node_modules`, a `.pnp.cjs` table over global-cache zips)

**cold** = no lockfile; **warm** = lockfile present, `node_modules` removed; **truly-cold** = network-cold. Every cell is a single sample, taken in the listed tool order within each scale; the fastest cold and warm cell per scale is bold. yarn-PnP's 64 entries are its unplugged native packages.

| scale | manager | cold | warm | CPU | peak RSS | nm entries |
|---|---|---|---|---|---|---|
| 200 / 100 | pnpm 12.8.1 isolated | 0.67s | 0.46s | 325% | 92 MB | 15,701 |
| | pnpm 12.8.1 hoisted | 0.65s | 0.47s | 512% | 91 MB | 12,554 |
| | bun | **0.13s** | **0.14s** | 235% | 42 MB | 15,419 |
| | yarn node-modules | 3.3s | 2.9s | 151% | 937 MB | 11,220 |
| | yarn PnP | 1.8s | 1.5s | 141% | 610 MB | 64 |
| 1,000 / 200 | pnpm 12.8.1 isolated | 3.1s | 2.7s | 148% | 134 MB | 31,133 |
| | pnpm 12.8.1 hoisted | **1.2s** | **0.78s** | 859% | 120 MB | 17,786 |
| | bun | 2.9s | 2.9s | 38% | 69 MB | 29,951 |
| | yarn node-modules | 4.4s | 4.1s | 157% | 1,019 MB | 12,120 |
| | yarn PnP | 2.4s | 2.2s | 150% | 660 MB | 64 |
| 2,000 / 300 | pnpm 12.8.1 isolated | 8.2s | 8.1s | 98% | 196 MB | 50,169 |
| | pnpm 12.8.1 hoisted | **2.5s** | **2.1s** | 734% | 180 MB | 24,222 |
| | bun | 9.6s | 10.1s | 22% | 97 MB | 47,887 |
| | yarn node-modules | 5.7s | 5.5s | 158% | 1,093 MB | 13,220 |
| | yarn PnP | 3.2s | 3.1s | 149% | 722 MB | 64 |

Truly-cold at 200/100 (network-bound, single sample) runs bun 1.2s, pnpm-hoisted 2.1s, yarn PnP 8.2s, yarn node-modules 9.7s.

- pnpm 12 (the Rust CLI) has no cold-resolve wall: pnpm cold is seconds — 0.67s → 8.2s isolated (12× over 10× apps), 0.65s → 2.5s hoisted (3.8×, sublinear) — at 91–196 MB peak install RSS. The pnpm-10-vs-12 rewrite is priced leg-vs-leg [below](#pnpm-12-the-rust-rewrite) (cold resolve 303.7s → 1.01s at 1,000:200).
- The bun-vs-pnpm cold story inverts with scale. bun is ~5× faster at 200/100 (0.13s vs 0.65–0.67s) and ~1.7× faster truly-cold (1.2s vs 2.1s); at 1,000 apps **pnpm-hoisted cold beats bun** (1.2s vs 2.9s, ~2.4×; bun is 7% ahead of pnpm-isolated's 3.1s and behind yarn-PnP's 2.4s), and at 2,000 bun's cold is the slowest of the five configurations (9.6s; pnpm-hoisted 2.5s is ~3.8× faster). bun's install CPU falls with scale (235% → 38% → 22%, under one core from 1,000 apps) while pnpm-hoisted runs at 512–859%.
- Cold fastest per scale: bun at 200 (0.13s), pnpm-hoisted at 1,000 (1.2s) and at 2,000 (2.5s). yarn-PnP is second at both larger scales (2.4s and 3.2s, ×2.0 and ×1.3 of pnpm-hoisted); both yarn linkers grow under 2× across the 10× app sweep (PnP 1.8s → 3.2s, node-modules 3.3s → 5.7s).
- Warm relink shows the linker (pnpm-hoisted 2.1s vs pnpm-isolated 8.1s at 2,000); pnpm-hoisted is the fastest warm at 1,000/2,000 (0.78s/2.1s), bun at 200 (0.14s). bun's warm relink is no faster than its cold at any scale (0.14s/2.9s/10.1s warm vs 0.13s/2.9s/9.6s cold). Footprints at 2,000 apps: yarn-PnP 64, yarn-nm 13,220, pnpm-hoisted 24,222, bun/pnpm-isolated ~48–50k.

bun and yarn ignore `pnpm-workspace.yaml`/`catalog:`, so the bench runs a decataloged copy.

## pnpm 12: the Rust Rewrite

pnpm 12 is a Rust port of the pnpm CLI shipping as a native binary behind the
install surface this bench exercises. `scripts/pnpm12-bench.mjs` prices the rewrite
against the pinned JS baseline on one 1,000:200 workspace per leg (generator
scale/modules pinned and the printed summary asserted; package-identity
equivalence gate: every leg must lock the identical package set — 58 packages,
1,201 importers; leg order rotated per sample round and recorded; completeness
verified by the shared `_verify-install.cjs` after every timed install;
`bench/pnpm12-bench.json`, 64-core, btrfs):

| row | pnpm 10.29.1 (JS) | pnpm 12.8.1 (Rust) | tip (12.8.2 @ 26aeeb11) |
|---|---|---|---|
| cold resolve (no lockfile, warm store; median of 3) | 303.7s | 1.01s | 1.00s |
| warm rebuild (lockfile + store, no `node_modules`; median of 3) | 5.35s | 0.57s | 0.57s |
| frozen rebuild (`--frozen-lockfile`, same tree; median of 3) | 5.17s | 0.53s | 0.53s |
| truly cold (fresh store + cache + network; lockfile retained, frozen; 1 sample, fixed order) | 7.55s | 1.12s | 1.14s |

The rewrite is **301× faster on cold resolution** at this shape — the JS
implementation's cold resolve grows ~linearly with importer count and pays five
minutes on this 1,201-importer workspace — and 9–10× on the warm and frozen rows,
6.7× truly-cold. Tip of main measures within ±2% of stable on every row. These rows
are leg-vs-leg inside this bench (separate runs, its own flag set and install-state
definitions); they are not directly comparable to the install-bench table above,
and the containerized frozen install is measured separately in
[the CI-runner section](#the-ci-runner-install-frozen-in-a-fresh-container).

Migration mechanics (untimed verdicts in the record): pnpm 12 writes the same
`lockfileVersion: '9.0'`; `--frozen-lockfile` against a pnpm-10-authored lockfile
succeeds with the lockfile bytes unchanged; a drifted manifest fails closed with
`ERR_PNPM_OUTDATED_LOCKFILE`; and the measured two-sided build-scripts probe shows
the hardened default — a blocked dependency build script fails the install in 12
(`ERR_PNPM_IGNORED_BUILDS`) where 10 flags it and exits 0. pnpm 12 also ships a
supply-chain gate (`minimumReleaseAge`) that fails lockfile verification closed for
packages published within its cutoff (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`);
its trigger depends on registry publish times relative to the run, so the bench
relaxes it (`--config.minimum-release-age=0` on every leg) rather than gating on
it. Both defaults change CI behavior on upgrade; both are explicit config away.

## yarn PnP toolchain compatibility

`scripts/pnp-compat-bench.mjs` (20 apps / 10 libs, PnP vs node-modules control): oxlint, tsc and turbo focused typecheck run under PnP; **tsgo fails** (`TS2503`/`TS2307`) and **`next build` fails** (on node 22.23.3 it crashes while loading `next.config`, before a bundler runs — below) — both work under node-modules. The PnP install itself depends on the yarn release with TypeScript 7: yarn 4.17.0's builtin TypeScript patch fails on the native `typescript@7.0.2` (`ENOENT` on `typescript/lib/_tsc.js`, a file TypeScript 7 does not ship), and the pinned 4.18.1 installs it — the bench's two-sided control (`bench/pnp-compat-bench.json`).

**Closing the gap:** `scripts/tsgo-pnp-bench.mjs`, on one scaffolded workspace app (a workspace lib + npm deps) — a native PnP resolver for tsgo ([microsoft/typescript-go#460](https://github.com/microsoft/typescript-go/issues/460)) matches the control (0 errors / 83 files vs stock tsgo's 3× `TS2307`, 64 files; `bench/tsgo-pnp-bench.json`).

**Next under PnP depends on the node version.** `scripts/rspack-pnp-bench.mjs`, one Next App Router app (next 16.0.1), three builders, each PnP tree built twice — on the bench's node and on a pinned older node:

| PnP tree, builder | node 22.23.3 | node 22.22.0 (control) | node-modules, node 22.23.3 |
|---|---|---|---|
| Turbopack | fails at config load | fails: no PnP resolver (`next/package.json`) | builds |
| webpack | fails at config load | builds | builds |
| rspack (`next-rspack`) | fails at config load | builds | builds |

On node 22.23.3 every builder fails the same way: the build crashes while loading `next.config` — next's config transpile hook reads `require.extensions['.js']`, which the `require()` it gets under the PnP loader does not carry — before a bundler is selected. The same installed trees on node 22.22.0 separate the bundlers: webpack and **rspack** build under PnP, and Turbopack fails at its own `next/package.json` resolution ([vercel/next.js#42651](https://github.com/vercel/next.js/issues/42651)). All three build under the node-modules linker on 22.23.3, so the crash is specific to PnP. `pnp-compat-bench` records the same config-load crash on its generated app (next 16.2.9) (`bench/rspack-pnp-bench.json`, `bench/pnp-compat-bench.json`).

**yarn 4 at fleet scale** (`scripts/yarn-fleet-bench.mjs`, 30,000 apps / 460 libs, the [FLEET.md](FLEET.md) shape with the fleet gate's exact devDependency set; `bench/yarn-fleet-bench.json`, yarn 4.18.1 on node 22.23.3 with `typescript@7` as the tree's checker, 64-core box, recorded pre-run 1-minute load 6.4): PnP installs the workspace **truly cold in 41.6s** (no lockfile, fresh global cache, network) and 39.9s warm — one 62MB `.pnp.cjs` instead of the node-modules farm. yarn's own node-modules linker takes **222.5s** truly cold (212.8s warm) on the same tree (4,884,956 `node_modules` entries — and its per-app package clones are CoW-or-copy: free reflinks on btrfs, real copies on ext4 — TB-scale at this shape, ENOSPC with 71GB free here); the fleet gate's bun install is 190.0s against the same workload, in the state of yarn's warm rows (lockfile present, warm store, install outputs wiped): PnP warm is 4.8× faster than bun and yarn's node-modules linker warm is 12% slower; PnP truly cold still beats bun's warm install 4.6×. The type gate closes the loop: the native-PnP tsgo build (head of the PR line consolidated in [microsoft/typescript-go#1966](https://github.com/microsoft/typescript-go/pull/1966); binary sha + git sha recorded) runs the whole-program fleet gate **through `.pnp.cjs` in 62.8s / 50.8GB — and the same binary over the node-modules tree in 64.6s / 52.4GB**, the same-binary control that isolates the linker: no linker penalty was observed in this one-timed-run-per-linker comparison (the PnP run is 2.7% lower on wall and 3% lower on peak RSS). It catches the breaking foundation rev with all 30,000 apps red in 63.9s. Stock tsgo on the same PnP tree fails with exactly 30,000 `TS2503` unresolved-name errors, the pnp-compat boundary at full scale. With the resolver in place the check shows no PnP penalty; what still stands between this stack and PnP is `next build` (above: no builder runs under PnP on node 22.23.3; on 22.22.0 webpack and rspack do and Turbopack does not) and the patch not yet being shipped.

**Build speed** (`scripts/rspack-turbopack-speed-bench.mjs`, 60-route app, node-modules, median of 3, `bench/rspack-turbopack-speed-bench.json`): Turbopack **9.4s** cold (×1), rspack 15.7s (×1.67), webpack 19.3s (×2.06). rspack is ~1.23× faster than webpack cold.

**Specifier form and node-linker** (`scripts/perf-matrix.mjs`, pnpm 12.8.1, cold at 300/100): the `workspace:` form is install-neutral (0.91s vs 0.91s versioned, +0.2%). The linker is not: on this catalog workspace hoisted cold runs ~3.1× slower than isolated (2.80s vs 0.91s) and materializes far more (77,781 nm entries / 10.2 GB apparent vs isolated's 18,159 / 0.42 GB). The larger decataloged install-bench trees above point the other way (hoisted cold beats isolated at 1,000–2,000 apps); the two records vary scale and catalog form together, so they do not isolate which causes the reversal. Choose the specifier form for publish semantics.

## The CI-runner install: frozen, in a fresh container

`scripts/container-install-bench.mjs`: a committed lockfile installed frozen (`pnpm --frozen-lockfile`, `bun --frozen-lockfile`, `yarn --immutable`, `npm ci`) in a fresh rootless-podman container at 1,000 apps / 200 libs, median of five (pnpm 12.8.1, bun 1.3.14, yarn 4.18.1). On a fresh runner (empty caches + real network), wall times are **bun 1.03s and pnpm 1.09s (+6%)**, then yarn-PnP 4.8s, yarn-nm 6.7s, npm 10.4s. With a pre-warmed store: bun 0.47s, pnpm 0.54s (+15%), yarn-PnP 2.3s, yarn-nm 4.3s, npm 9.7s. Fail-closed holds on all five (drift → exit 1, lockfile untouched). `bench/container-install-bench.json`.

## Build: Next vs Vite

`scripts/build-bench.mjs` runs `turbo run build` of 40 apps + 24 libs on 64 cores. Next (App Router): 17.2s, 741 MB RSS, 156.8 MB `.next`. Vite (SPA): 7.6s, 193 MB RSS, 7.7 MB `dist`. Vite builds ~2.3x faster and emits ~20x less for these tiny apps (`.next` includes server/RSC bundles; not equivalent features). At scale, not building unchanged apps matters more than per-build time (`bench/build-bench.json`).

## Lint: ESLint vs oxlint

`scripts/lint-bench.mjs` races oxlint (native Rust, from oxc; this repo's linter) against ESLint on a self-contained generated corpus of 800 `.ts`/`.tsx` modules (not the workspace under test), matched for engine speed. ESLint is pointed at oxlint's rule set via `eslint-plugin-oxlint`, running a strict subset (530 rules with an ESLint port that aren't type-checked, vs oxlint's own 598) — the claim is "subset," not "598 > 530." oxlint is multithreaded, ESLint single-process (192-core c8g.48xlarge, so the ratio narrows on fewer cores). (`oxlint` 1.86.0, `eslint` 9.39.5, `oxlint-tsgolint` 7.0.2003.)

| pass                        | ESLint              | oxlint                | ratio |
| --------------------------- | ------------------- | --------------------- | ----- |
| syntactic, no cache         | 9,602ms (530 rules) | **190ms** (598 rules) | 50.5x |
| syntactic, ESLint `--cache` | 1,568ms             | **190ms**             | 8.3x  |
| type-aware                  | 3,566ms             | **388ms**             | 9.2x  |

The type-aware row is mostly the type-checker underneath — oxlint's `oxlint-tsgolint` (alpha; 59 of 61 typescript-eslint type-aware rules; needs TS7+) builds with tsgo (TS7), ESLint with tsc 5.9, and tsgo alone is ~12x faster at whole-program typecheck (`bench/typecheck-bench.json`, [TYPECHECKERS.md](TYPECHECKERS.md)). `eslint-plugin-oxlint` disables oxlint-covered rules, leaving ESLint to lint the residual (0 here) — oxlint on the hot path, a thin ESLint pass for the rest is the migration path.

## Vite+ (`vp`): task runner and tool layer

Vite+ is VoidZero's unified toolchain CLI: one `vp` binary wrapping Rolldown-Vite, Vitest, Oxlint, and **Vite Task**, a Rust monorepo task runner competing with Turborepo. v0.2.2, `scripts/vite-task-bench.mjs` + `scripts/vite-plus-tools-bench.mjs`.

**Task orchestration** (`bench/vite-task-bench.json`; the workspace under test with a dep-free `typecheck:tsgo` task set; 192-core c8g.48xlarge, concurrency 192 on both runners, typescript 7.0.2): turbo hashes declared inputs; Vite Task fs-traces reads and cached the gitignored tree with zero config. Whole-repo typecheck turbo wins 3.2–10.7× — cold ×8.4 at 300:100 (5.2s vs 43.5s) and ×10.7 at 1,000:200 (19.1s vs 204.2s), warm ×3.2 (1.4s vs 4.5s) and ×4.1 (3.5s vs 14.5s). Focused warm is close: vp stays flat across 3× repo growth (0.81s → 0.83s) while turbo's grows with the repo (0.76s → 1.01s, [LIMITS.md](LIMITS.md)), so turbo leads at 300:100 and vp by 1.2× at 1,000:200; focused cold, turbo is faster at both scales (1.4s vs 2.3s; 1.5s vs 2.0s). On a cross-package edit (1,000:200), vp recomputed exactly the 559 tasks whose traced reads touch the file; turbo recomputed 1 of 1,200. On the test axis (1,200 `node:test` tasks at 1,000:200) turbo is faster cold (7.1s vs 17.6s) and vp faster warm (1.0s vs 2.8s). vp refuses to cache self-mutating tasks (`next build`, `vite build`, `tsc --noEmit` with `incremental: true`).

**Tool layer** (`bench/vite-plus-tools-bench.json`, self-contained temp scaffolds): `vp check --no-fmt` (one pass) 2.56s vs the same engines standalone (`oxlint --type-aware --type-check` **1.90s**) vs this repo's gate (`oxlint` + whole-program `tsgo --noEmit` **0.80s**) — 3.2× slower than the optimal-gate shape. `vp build` vs `vite build` (one generated Vite app, 40:24 scaffold): byte-identical `dist`, 969ms vs 560ms (~1.7× wrapper cost). The Vite+ layer costs time on every cold row and on the whole-repo warm typecheck; it is faster on the warm test run and on the focused warm typecheck at 1,000:200. Its fs-traced cache is the first measured runner correct on gitignored source and cross-package edits with zero config.

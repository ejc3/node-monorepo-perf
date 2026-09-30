# Tooling Comparisons

## Install: bun vs pnpm vs yarn 4

`scripts/install-bench.mjs`, installing [the workspace under test](README.md#the-workspace-under-test) at the table's apps/libs scales (`bench/env.json`: Neoverse-V1, 64 cores, 135 GB). Each manager runs its default and alternate linkers; non-linker knobs are normalized across tools (dependency build scripts are disabled for every tool, registries and caches pinned — see the script header). Tool provenance is in the record and pin-asserted: pnpm 12.8.1 — the Rust CLI, probed through the per-scaffold `packageManager` pin — bun 1.3.14, yarn 4.17.0:

- pnpm-isolated (default) / pnpm-hoisted (flat)
- bun (isolated `node_modules/.bun` store since 1.3)
- yarn 4.17.0 under `node-modules` (flat) and PnP (its default: no `node_modules`, a `.pnp.cjs` table over global-cache zips)

**cold** = no lockfile; **warm** = lockfile present, `node_modules` removed; **truly-cold** = network-cold. yarn-PnP's 64 entries are its unplugged native packages.

| scale | manager | cold | warm | CPU | peak RSS | nm entries |
|---|---|---|---|---|---|---|
| 200 / 100 | pnpm 12.8.1 isolated | 0.83s | 0.59s | 324% | 98 MB | 15,701 |
| | pnpm 12.8.1 hoisted | 0.81s | 0.61s | 479% | 98 MB | 12,554 |
| | bun | 0.14s | 0.13s | 191% | 41 MB | 15,419 |
| | yarn node-modules | 3.4s | 3.1s | 152% | 938 MB | 11,220 |
| | yarn PnP | 1.8s | 1.5s | 141% | 609 MB | 64 |
| 1,000 / 200 | pnpm 12.8.1 isolated | 3.1s | 3.3s | 165% | 138 MB | 31,133 |
| | pnpm 12.8.1 hoisted | **1.4s** | **0.9s** | 789% | 118 MB | 17,786 |
| | bun | 2.1s | 3.5s | 48% | 68 MB | 29,951 |
| | yarn node-modules | 4.8s | 4.3s | 157% | 1,015 MB | 12,120 |
| | yarn PnP | 2.5s | 2.2s | 146% | 660 MB | 64 |
| 2,000 / 300 | pnpm 12.8.1 isolated | 7.7s | 7.8s | 114% | 191 MB | 50,169 |
| | pnpm 12.8.1 hoisted | 3.4s | **1.4s** | 558% | 178 MB | 24,222 |
| | bun | 8.7s | 10.1s | 23% | 96 MB | 47,887 |
| | yarn node-modules | 6.6s | 6.1s | 151% | 1,095 MB | 13,220 |
| | yarn PnP | **3.3s** | 3.1s | 148% | 721 MB | 64 |

Truly-cold at 200/100 (network-bound, single sample) runs bun 1.3s, pnpm-hoisted 2.4s, yarn PnP 8.0s, yarn node-modules 9.7s.

- pnpm 12 (the Rust CLI) has no cold-resolve wall: pnpm cold is seconds — 0.83s → 7.7s isolated (roughly linear over 10× apps), 0.81s → 3.4s hoisted (sublinear) — at 98–191 MB peak install RSS. The pnpm-10-vs-12 rewrite is priced leg-vs-leg [below](#pnpm-12-the-rust-rewrite) (cold resolve 303.7s → 1.01s at 1,000:200).
- The bun-vs-pnpm cold story inverts with scale. bun is ~6× faster at 200/100 (0.14s vs 0.83s) and ~1.9× faster truly-cold (1.3s vs 2.4s); at 1,000 apps **pnpm-hoisted cold beats bun** (1.4s vs 2.1s, ~1.5×), and at 2,000 bun's cold is the slowest of the five configurations (8.7s; pnpm-hoisted 3.4s is ~2.5× faster). bun's install CPU falls with scale (191% → 23%, under one core at 2,000) while pnpm-hoisted's rises (479% → 558%).
- Cold fastest per scale: bun at 200 (0.14s), pnpm-hoisted at 1,000 (1.4s), yarn-PnP at 2,000 (3.3s, with pnpm-hoisted 3.4s within 4%).
- Warm relink shows the linker (pnpm-hoisted 1.4s vs pnpm-isolated 7.8s at 2,000); pnpm-hoisted is the fastest warm at 1,000/2,000 (0.9s/1.4s), bun at 200 (0.13s). bun warm is slower than its own cold at 1,000/2,000 (3.5s/10.1s). Footprints at 2,000 apps: yarn-PnP 64, yarn-nm 13,220, pnpm-hoisted 24,222, bun/pnpm-isolated ~48–50k.

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

`scripts/pnp-compat-bench.mjs` (20 apps / 10 libs, PnP vs node-modules control): oxlint, tsc and turbo focused typecheck run under PnP; **tsgo fails** (`TS2503`/`TS2307`) and **`next build` fails** (Turbopack can't find `next/package.json`) — both work under node-modules (`bench/pnp-compat-bench.json`).

**Closing the gap:** `scripts/tsgo-pnp-bench.mjs`, on one scaffolded Next app (a workspace lib + npm deps) — a native PnP resolver for tsgo ([microsoft/typescript-go#460](https://github.com/microsoft/typescript-go/issues/460)) matches the control (0 errors / 83 files vs stock tsgo's 3× `TS2307`, 67 files); `next build --webpack` builds under PnP, Turbopack fails ([vercel/next.js#42651](https://github.com/vercel/next.js/issues/42651), `bench/tsgo-pnp-bench.json`).

**Fast bundler under PnP:** `scripts/rspack-pnp-bench.mjs`, one Next App Router app — **rspack** (via `next-rspack`) builds under PnP alongside webpack; Turbopack still fails (`bench/rspack-pnp-bench.json`).

**yarn 4 at fleet scale** (`scripts/yarn-fleet-bench.mjs`, 30,000 apps / 460 libs, the [FLEET.md](FLEET.md) shape with the fleet gate's exact devDependency set; `bench/yarn-fleet-bench.json`): PnP installs the workspace **truly cold in 40.8s** (no lockfile, fresh global cache, network) and 38.4s warm — one 62MB `.pnp.cjs` instead of the node-modules farm. yarn's own node-modules linker takes **441.5s** on the same tree (4,641,433 `node_modules` entries — and its per-app package clones are CoW-or-copy: free reflinks on btrfs, real copies on ext4 — TB-scale at this shape, ENOSPC with 71GB free here); the fleet gate's bun warm-store install is 180.6s against the same workload (a friendlier state than PnP's truly-cold row, and PnP still wins 4.4×). The type gate closes the loop: the native-PnP tsgo build (head of the PR line consolidated in [microsoft/typescript-go#1966](https://github.com/microsoft/typescript-go/pull/1966); binary sha + git sha recorded) runs the whole-program fleet gate **through `.pnp.cjs` in 60.1s / 53.0GB — and the same binary over the node-modules tree in 58.9s / 50.4GB**, the same-binary control that isolates the linker: PnP costs ~2% wall on the check. It catches the breaking foundation rev with all 30,000 apps red in 59.9s. Stock tsgo on the same PnP tree fails with exactly 30,000 `TS2503` unresolved-name errors, the pnp-compat boundary at full scale. PnP's install win costs ~2% on the check once the resolver exists; what still stands between this stack and PnP is Turbopack (rspack/webpack build, above) and the patch not yet being shipped.

**Build speed** (`scripts/rspack-turbopack-speed-bench.mjs`, 60-route app, node-modules, median of 3, `bench/rspack-turbopack-speed-bench.json`): Turbopack **9.0s** cold (×1), rspack 15.5s (×1.72), webpack 19.0s (×2.10). rspack is ~1.22× faster than webpack cold.

**Specifier form and node-linker** (`scripts/perf-matrix.mjs`, pnpm 12.8.1, cold at 300/100): the `workspace:` form is install-neutral (0.91s vs 0.91s versioned, +0.2%). The linker is not: on this catalog workspace hoisted cold runs ~3.1× slower than isolated (2.80s vs 0.91s) and materializes far more (77,781 nm entries / 10.2 GB apparent vs isolated's 18,159 / 0.42 GB). The larger decataloged install-bench trees above point the other way (hoisted cold beats isolated at 1,000–2,000 apps); the two records vary scale and catalog form together, so they do not isolate which causes the reversal. Choose the specifier form for publish semantics.

## The CI-runner install: frozen, in a fresh container

`scripts/container-install-bench.mjs`: a committed lockfile installed frozen (`pnpm --frozen-lockfile`, `bun --frozen-lockfile`, `yarn --immutable`, `npm ci`) in a fresh rootless-podman container at 1,000 apps / 200 libs, median of five (pnpm 12.8.1). On a fresh runner (empty caches + real network), wall times are **bun 1.04s and pnpm 1.08s — a near-tie**, then yarn-PnP 4.9s, yarn-nm 7.0s, npm 10.6s. With a pre-warmed store: bun 0.47s, pnpm 0.54s, yarn-PnP 2.3s, yarn-nm 4.5s, npm 9.9s. Fail-closed holds on all five (drift → exit 1, lockfile untouched). `bench/container-install-bench.json`.

## Build: Next vs Vite

`scripts/build-bench.mjs` runs `turbo run build` of 40 apps + 24 libs on 64 cores. Next (App Router): 17.2s, 741 MB RSS, 156.8 MB `.next`. Vite (SPA): 7.6s, 193 MB RSS, 7.7 MB `dist`. Vite builds ~2.3x faster and emits ~20x less for these tiny apps (`.next` includes server/RSC bundles; not equivalent features). At scale, not building unchanged apps matters more than per-build time (`bench/build-bench.json`).

## Lint: ESLint vs oxlint

`scripts/lint-bench.mjs` races oxlint (native Rust, from oxc; this repo's linter) against ESLint on a self-contained generated corpus of 800 `.ts`/`.tsx` modules (not the workspace under test), matched for engine speed. ESLint is pointed at oxlint's rule set via `eslint-plugin-oxlint`, running a strict subset (524 rules with an ESLint port that aren't type-checked, vs oxlint's own 567) — the claim is "subset," not "567 > 524." oxlint is multithreaded, ESLint single-process (64-core box, so the ratio narrows on fewer cores). (`oxlint` 1.71.0, `eslint` 9.39.4, `oxlint-tsgolint` 0.23.0.)

| pass                        | ESLint               | oxlint                | ratio |
| --------------------------- | -------------------- | --------------------- | ----- |
| syntactic, no cache         | 12,032ms (524 rules) | **190ms** (567 rules) | 63.3x |
| syntactic, ESLint `--cache` | 1,923ms              | **190ms**             | 10.1x |
| type-aware                  | 4,489ms              | **397ms**             | 11.3x |

The type-aware row is mostly the type-checker underneath — oxlint's `oxlint-tsgolint` (alpha; 59 of 61 typescript-eslint type-aware rules) builds with tsgo (TS7), ESLint with tsc 5.9, and tsgo alone is ~12x faster at whole-program typecheck (`bench/typecheck-bench.json`, [TYPECHECKERS.md](TYPECHECKERS.md)). `eslint-plugin-oxlint` disables oxlint-covered rules, leaving ESLint to lint the residual (0 here) — oxlint on the hot path, a thin ESLint pass for the rest is the migration path.

## Vite+ (`vp`): task runner and tool layer

Vite+ is VoidZero's unified toolchain CLI: one `vp` binary wrapping Rolldown-Vite, Vitest, Oxlint, and **Vite Task**, a Rust monorepo task runner competing with Turborepo. v0.2.2, `scripts/vite-task-bench.mjs` + `scripts/vite-plus-tools-bench.mjs`.

**Task orchestration** (`bench/vite-task-bench.json`; the workspace under test with a dep-free `typecheck:tsgo` task set): turbo hashes declared inputs; Vite Task fs-traces reads and cached the gitignored tree with zero config. Whole-repo typecheck turbo wins 2–3.7× (cold 1,000:200 turbo 31.5s vs vp 117.3s). Focused, vp wins and stays flat across 3× repo growth (0.85s → 0.86s warm) while turbo's focused warm grows O(repo) (1.2s → 3.0s, [LIMITS.md](LIMITS.md)). On a cross-package edit (1,000:200), vp recomputed exactly the 559 tasks whose traced reads touch the file; turbo recomputed 1 of 1,200. vp refuses to cache self-mutating tasks (`next build`, `vite build`, `tsc --noEmit` with `incremental: true`).

**Tool layer** (`bench/vite-plus-tools-bench.json`, self-contained temp scaffolds): `vp check --no-fmt` (one pass) 2.44s vs the same engines standalone (`oxlint --type-aware --type-check` **1.88s**) vs this repo's gate (`oxlint` + whole-program `tsgo --noEmit` **0.77s**) — 3.2× slower than the optimal-gate shape. `vp build` vs `vite build` (one generated Vite app, 40:24 scaffold): byte-identical `dist`, 856ms vs 546ms (~1.6× wrapper cost). The Vite+ layer costs time except the focused loop; its fs-traced cache is the first measured runner correct on gitignored source and cross-package edits with zero config.

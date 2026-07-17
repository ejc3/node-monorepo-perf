# Tooling Comparisons

## Install: bun vs pnpm vs yarn 4

`scripts/install-bench.mjs`, installing [the workspace under test](README.md#the-workspace-under-test) at the table's apps/libs scales (`bench/env.json`: Neoverse-V1, 64 cores, 135 GB). Each manager runs at its default; pnpm and yarn also run under the alternate linker:

- pnpm-isolated (default) / pnpm-hoisted (flat)
- bun (isolated `node_modules/.bun` store since 1.3)
- yarn 4.17.0 under `node-modules` (flat) and PnP (its default: no `node_modules`, a `.pnp.cjs` table over global-cache zips)

**cold** = no lockfile; **warm** = lockfile present, `node_modules` removed; **truly-cold** = network-cold. yarn-PnP's 64 entries are its unplugged native packages.

| scale | manager | cold | warm | CPU | peak RSS | nm entries |
|---|---|---|---|---|---|---|
| 200 / 100 | pnpm isolated | 47.8s | 2.3s | 130% | 779 MB | 15,691 |
| | pnpm hoisted | 46.7s | 1.4s | 131% | 903 MB | 12,246 |
| | bun | 0.13s | 0.12s | 225% | 43 MB | 15,409 |
| | yarn node-modules | 3.2s | 2.8s | 152% | 933 MB | 11,210 |
| | yarn PnP | 1.7s | 1.3s | 143% | 610 MB | 64 |
| 1,000 / 200 | pnpm isolated | 229.5s | 7.3s | 134% | 938 MB | 31,123 |
| | pnpm hoisted | 227.3s | 3.0s | 133% | 992 MB | 16,578 |
| | bun | 2.2s | 2.6s | 42% | 73 MB | 29,941 |
| | yarn node-modules | 4.4s | 4.0s | 158% | 1,017 MB | 12,110 |
| | yarn PnP | 2.3s | 2.1s | 151% | 666 MB | 64 |
| 2,000 / 300 | pnpm isolated | 471.2s | 15.2s | 141% | 1,023 MB | 50,159 |
| | pnpm hoisted | 456.7s | 4.7s | 142% | 1,161 MB | 21,914 |
| | bun | 7.5s | 9.5s | 26% | 97 MB | 47,877 |
| | yarn node-modules | 6.2s | 5.9s | 153% | 1,093 MB | 13,210 |
| | yarn PnP | 3.2s | 2.9s | 149% | 723 MB | 64 |

Truly-cold at 200/100 (network-bound, single sample) runs pnpm-hoisted 24.0s, bun 1.2s, yarn node-modules 9.3s, yarn PnP 7.7s.

- pnpm cold is ~linear (47.8s → 471.2s for 10× apps); bun's constant is far smaller (0.13s → 7.5s): ~357× faster cold than pnpm-isolated at 200/100, ~103× at 1,000, ~62× at 2,000. Truly-cold bun stays faster (1.2s vs 24.0s), not a cache effect.
- yarn's cold grows more slowly, so bun-vs-yarn flips with scale: bun faster at 200 (0.13s vs 1.7s), tied with yarn-PnP at 1,000 (2.24s vs 2.32s), and at 2,000 **yarn is fastest cold** (PnP 3.2s vs bun 7.5s).
- Warm relink shows the linker (pnpm-hoisted 4.7s vs pnpm-isolated 15.2s at 2,000; yarn-PnP warm fastest at 1,000/2,000 apps, 2.1s/2.9s; bun warm fastest at 200, 123ms). Footprints at 2,000 apps: yarn-PnP 64, yarn-nm 13,210, pnpm-hoisted 21,914, bun/pnpm-isolated ~48–50k. pnpm's truly-cold (24.0s) undercuts its warm-store cold (46.7s). The warm metadata cache re-parses large cached packuments, while the committed lockfile skips resolving.

bun and yarn ignore `pnpm-workspace.yaml`/`catalog:`, so the bench runs a decataloged copy.

## yarn PnP toolchain compatibility

`scripts/pnp-compat-bench.mjs` (20 apps / 10 libs, PnP vs node-modules control): oxlint, tsc and turbo focused typecheck run under PnP; **tsgo fails** (`TS2503`/`TS2307`) and **`next build` fails** (Turbopack can't find `next/package.json`) — both work under node-modules (`bench/pnp-compat-bench.json`).

**Closing the gap:** `scripts/tsgo-pnp-bench.mjs`, on one scaffolded Next app (a workspace lib + npm deps) — a native PnP resolver for tsgo ([microsoft/typescript-go#460](https://github.com/microsoft/typescript-go/issues/460)) matches the control (0 errors / 83 files vs stock tsgo's 3× `TS2307`, 67 files); `next build --webpack` builds under PnP, Turbopack fails ([vercel/next.js#42651](https://github.com/vercel/next.js/issues/42651), `bench/tsgo-pnp-bench.json`).

**Fast bundler under PnP:** `scripts/rspack-pnp-bench.mjs`, one Next App Router app — **rspack** (via `next-rspack`) builds under PnP alongside webpack; Turbopack still fails (`bench/rspack-pnp-bench.json`).

**Build speed** (`scripts/rspack-turbopack-speed-bench.mjs`, 60-route app, node-modules, median of 3, `bench/rspack-turbopack-speed-bench.json`): Turbopack **9.0s** cold (×1), rspack 15.5s (×1.72), webpack 19.0s (×2.10). rspack is ~1.22× faster than webpack cold.

**Specifier form and node-linker** (`scripts/perf-matrix.mjs`, cold at 300/100): the `workspace:` form is install-neutral (71.4s vs 71.8s versioned, +0.5%); node-linker barely changes install *time* but the isolated layout has ~3× more symlinks (4,211 vs 1,459). Choose the form for publish semantics, the linker for footprint.

## The CI-runner install: frozen, in a fresh container

`scripts/container-install-bench.mjs`: a committed lockfile installed frozen (`pnpm --frozen-lockfile`, `bun --frozen-lockfile`, `yarn --immutable`, `npm ci`) in a fresh rootless-podman container at 1,000 apps / 200 libs, median of five. On a fresh runner (empty caches + real network), wall times are **bun 0.9s** (10× pnpm, 12× npm), yarn-PnP 4.4s, yarn-nm 6.5s, pnpm 8.9s, npm 10.4s. With a pre-warmed store, bun 0.4s, pnpm 7.0s. bun wins outright here — the warm-store yarn-overtakes-bun crossover does not appear. Fail-closed holds on all five (drift → exit 1, lockfile untouched). `bench/container-install-bench.json`.

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

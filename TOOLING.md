# Tooling comparisons: install and build

## Install: bun vs pnpm (`scripts/install-bench.mjs`)

Environment in `bench/env.json` (Neoverse-V1, 64 cores, 135 GB). pnpm-isolated is pnpm's default; pnpm-hoisted matches bun's flat `node_modules`, so the manager is compared at the same layout.

The three states: **cold** = no lockfile present (full resolve + link against the warm content store, no network); **warm** = lockfile present, `node_modules` removed (relink); **truly-cold** (the pass below the table) = the network-cold case.

Reset discipline: each scale is generated fresh, the whole `node_modules` tree (root + every per-package dir) and the lockfile are removed before each measurement, and the store is pre-warmed once so a "cold" install reflects warm-store work rather than a cache-order artifact. Every install is verified complete afterward — every app and lib must resolve all its declared dependencies and devDependencies, or the bench throws.

Columns: CPU% and peak RSS are from `/usr/bin/time -v`; `nm entries` is the full-tree `node_modules` footprint (root virtual store + every per-package tree).

| scale | manager | cold | warm | CPU | peak RSS | nm entries |
|---|---|---|---|---|---|---|
| 200 / 100 | pnpm isolated | 48.8s | 2.3s | 131% | 825 MB | 15,691 |
| | pnpm hoisted | 47.1s | 1.4s | 132% | 907 MB | 12,246 |
| | bun | 0.11s | 0.12s | 230% | 42 MB | 15,409 |
| 1,000 / 200 | pnpm isolated | 232.4s | 7.4s | 134% | 907 MB | 31,123 |
| | pnpm hoisted | 227.1s | 3.0s | 134% | 933 MB | 16,578 |
| | bun | 2.3s | 2.5s | 43% | 72 MB | 29,941 |
| 2,000 / 300 | pnpm isolated | 476.8s | 15.6s | 141% | 1,011 MB | 50,159 |
| | pnpm hoisted | 453.6s | 4.7s | 142% | 1,157 MB | 21,914 |
| | bun | 8.3s | 10.1s | 23% | 98 MB | 47,877 |

Truly-cold (fresh pnpm store + fresh metadata cache + cleared bun cache, real network) at 200/100: pnpm-hoisted 23.6s, bun 3.1s. This downloads every package and its metadata, so it is network-bound and a single sample — a different regime from the warm-store cold column above (which links from the host's large shared store), and not directly comparable to it. bun stays faster; treat the exact multiple as approximate.

Reading it:
- pnpm cold install is ~linear in package count (48.8s → 476.8s, 10× apps); bun has a far smaller constant (0.11s → 8.3s) — roughly 440× faster cold than pnpm's default isolated at 200/100, ~100× at 1,000, ~58× at 2,000 (against the matched-layout pnpm-hoisted the ratios are ~424× / ~100× / ~55×). The gap isn't just a warm cache: even truly-cold (fresh store + metadata, real network) bun stays faster (3.1s vs 23.6s in one sample), though that path is network-bound — see the note above.
- Warm relink (lockfile present) is where the linker shows up: pnpm-hoisted relinks in 4.7s at 2,000 vs pnpm-isolated's 15.6s — recreating the isolated symlink farm is a real warm-relink cost. bun's warm (10.1s) lands near its cold (8.3s) at 2,000.
- Cold install time is within ~5% across isolated/hoisted (resolution-bound); the isolated layout's costs are footprint (50,159 vs 21,914 `node_modules` entries at 2,000) and that warm-relink time, not cold-install time.
- pnpm uses ~1.3–1.4 cores (install is largely serial) and up to ~1.2 GB RSS; bun stays under 100 MB. Each figure is a single measured run (large installs are measured once).

Methodology:
- bun ignores `pnpm-workspace.yaml` and the `catalog:` protocol, so the bench runs a decataloged copy with a `package.json` `"workspaces"` field both tools read — a like-for-like dependency set.
- bun's `node_modules` is hoisted (flat); pnpm-isolated is a symlinked virtual store that prevents phantom dependencies. The speed comparison is like-for-like at matched layout (pnpm-hoisted vs bun); the strictness guarantees differ.
- Install only; Next/Vite/tsc run on Node either way.

### Specifier form and node-linker (`scripts/perf-matrix.mjs`)

Does the `workspace:` spec form or the linker mode change install perf? Cold install at 300/100:

| variant | install | nm entries | symlinks |
|---|---|---|---|
| `workspace:*`, isolated (baseline) | 71.4s | 18,081 | 4,211 |
| `workspace:^x.y.z`, isolated | 71.8s (+0.5%) | 18,081 | 4,211 |
| `workspace:*`, hoisted | 69.0s (−3.4%) | 13,304 | 1,459 |

The specifier form is install-neutral (a 0.5% single-run difference; identical `node_modules` and lockfile line count, the versioned variant's lockfile marginally larger in bytes from its explicit version strings). node-linker barely changes install *time* here (resolution-bound), but the isolated layout has ~3× more symlinks (4,211 vs 1,459, full-tree) and ~36% more `node_modules` entries — the inode cost that grows with package count. So choose the form for publish semantics and the linker for strictness/footprint, not for install speed.

## Build: Next vs Vite (`scripts/build-bench.mjs`)

Full `turbo run build` of 40 apps + 24 libs, concurrency 12, 64-core machine. Next is App Router (SSR/RSC); Vite is a client SPA, so this compares build tooling and output, not equivalent features.

| framework | build (all 40 apps) | CPU | peak RSS | total output |
|---|---|---|---|---|
| Next (App Router) | 17.2s | 2798% (~28 cores) | 741 MB | 156.8 MB (`.next`) |
| Vite (SPA) | 7.6s | 1187% (~12 cores) | 193 MB | 7.7 MB (`dist`) |

Vite builds ~2.3x faster and emits ~20x less output for these tiny apps. That is expected: `.next` includes server/RSC bundles and per-route artifacts, while Vite emits a static client bundle; Next also parallelizes across more cores. If you need SSR/RSC/server actions you pick Next regardless. At thousands of apps the framework's per-build time matters less than not building unchanged apps — the affected-closure rule applies the same way to both.

## Lint: ESLint vs oxlint (`scripts/lint-bench.mjs`)

oxlint (native Rust, from oxc) reimplements a large subset of the ESLint ecosystem's rules, and this repo uses it as the linter. This races it against ESLint on one generated corpus (800 `.ts`/`.tsx` modules), matched so the number reflects engine speed, not coverage breadth. oxlint runs **standalone** at its full native capability — all plugins + all categories (and, for the type-aware row, `--type-aware` via `oxlint-tsgolint`). ESLint is pointed at *oxlint's own rule set*: `eslint-plugin-oxlint` publishes the exact map of which ESLint rules oxlint covers, and the bench inverts it to turn those rules on in ESLint with the matching plugins registered. ESLint runs a **strict subset** of what oxlint covers — the 524 rules with an ESLint port that aren't type-checked — so it does no *more* work than oxlint, which keeps the ratio conservative. (The two rule counts, 524 ESLint-side and oxlint's own 567, are recorded but aren't a like-for-like tally: an oxlint rule and an ESLint rule don't map 1:1, so the load-bearing claim is "ESLint runs a subset," not "567 > 524.")

Two things shape the wall-clock:

- **oxlint is multithreaded; ESLint is single-process.** These are wall-clock numbers on a 64-core box (`bench/env.json`), so the ratio is amplified by core count — on fewer cores the gap narrows. Parallelism is a real oxlint capability, not a measurement artifact, but the *magnitude* of the speedup is core-dependent.
- **The type-aware row is mostly a type-checker comparison, not a linter comparison** (detailed below): both tools build a TypeScript program to get type information, and the speedup is dominated by tsgo-vs-tsc.

(`oxlint` 1.71.0, `eslint` 9.39.4, `typescript-eslint` 8.62.0, `oxlint-tsgolint` 0.23.0.)

| pass                        | ESLint               | oxlint                | ratio |
| --------------------------- | -------------------- | --------------------- | ----- |
| syntactic, no cache         | 12,032ms (524 rules) | **190ms** (567 rules) | 63.3x |
| syntactic, ESLint `--cache` | 1,923ms              | **190ms**             | 10.1x |
| type-aware                  | 4,489ms              | **397ms**             | 11.3x |

A like-for-like parity proof gates the run: a fixture seeded with five rules both tools implement, and the run hard-fails unless both flag *exactly* that set — so the speed numbers can't come from one tool quietly doing less. Each timed run is also checked to have exited with a lint code and linted all 800 files.

**Syntactic.** oxlint lints the 800-file tree in **190ms**; ESLint, running the smaller matched set, takes **12.0s** without `--cache` and **1.9s** with its persistent `--cache` warmed. oxlint has no persistent cache — its single run is **10.1x** faster than even ESLint's warm-cache run and **63.3x** faster than ESLint without `--cache`. Both are wall-clock on a 64-core box, and oxlint's parallelism is part of why it wins, so the ratio would be smaller on fewer cores. (oxlint reported 18,793 findings to ESLint's 22,349 — different rule sets, so the counts are recorded, not raced.)

**Type-aware — the gap that closed.** The rules that need type information (`no-floating-promises`, `no-misused-promises`, `await-thenable`, …) used to be ESLint-only; `tsc` does not flag an un-awaited promise. oxlint now does them too, through `oxlint-tsgolint` (alpha; **59 of 61** typescript-eslint type-aware rules; requires TypeScript 7+). `oxlint --type-aware` checks the tree — its full native set *plus* the type-aware rules — in **397ms**; ESLint's type-checked pass takes **4.5s**, **11.3x** slower. The gap here is mostly the **type-checker underneath, not the lint engine**: both tools must build the TypeScript program to get type information — `oxlint-tsgolint` builds it with tsgo (TS7), typescript-eslint builds it with tsc 5.9, and tsgo alone is ~12x faster than tsc at whole-program typecheck (`bench/typecheck-bench.json`, [TYPECHECKERS](TYPECHECKERS.md)). So this row largely re-measures that substrate difference; ESLint is not uniquely slow at building the program. Both flag the seeded floating promise (asserted). `oxlint-tsgolint` is alpha — pin it, and treat its coverage as a moving target.

**What ESLint is still for.** Run `eslint-plugin-oxlint` to turn off the rules oxlint covers, and ESLint lints only the *residual* — rules with no oxlint port. On this corpus the residual found **0** (its seeded violations are all oxlint-covered). In practice that residual is the handful of plugin rules oxlint has not ported yet; the layered setup — oxlint on the hot path, a thin ESLint pass for the rest — is the migration path, and with the type-aware alpha covering 59/61 type-aware rules it keeps shrinking.


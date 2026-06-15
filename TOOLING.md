# Tooling comparisons: install and build

## Install: bun vs pnpm (`scripts/install-bench.mjs`)

Environment in `bench/env.json` (Neoverse-V1, 64 cores, 135 GB). pnpm-isolated is pnpm's default; pnpm-hoisted matches bun's flat `node_modules`, so the manager is compared at the same layout. cold = no lockfile present (full resolve + link against the warm content store, no network); warm = lockfile present, `node_modules` removed (relink); the truly-cold pass below is the network-cold case. Each scale is generated fresh; the whole `node_modules` tree (root + every per-package dir) and the lockfile are removed before each measurement, and the store is pre-warmed once so a "cold" install is warm-store rather than a cache-order artifact. Every install is verified complete: every app and lib must resolve all its declared dependencies and devDependencies or the bench throws. CPU% and peak RSS are from `/usr/bin/time -v`; `nm entries` is the full-tree `node_modules` footprint (root virtual store + every per-package tree).

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

Truly-cold (fresh pnpm store + cleared bun cache, network) at 200/100: pnpm-hoisted 48.9s, bun 1.2s.

Reading it:
- pnpm cold install is ~linear in package count (48.8s → 476.8s, 10× apps); bun has a far smaller constant (0.11s → 8.3s) — roughly 430× faster cold at 200/100, ~100× at 1,000, ~55× at 2,000. The gap isn't just a warm cache: even truly-cold (fresh store, network), bun is ~40× faster (1.2s vs 48.9s).
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


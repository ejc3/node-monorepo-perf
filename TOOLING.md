# Tooling comparisons: install and build

## Install: bun vs pnpm (`scripts/install-bench.mjs`)

64-core machine. pnpm-isolated is pnpm's default; pnpm-hoisted matches bun's flat `node_modules`, so the manager is compared at the same layout. cold = no lockfile (resolve); warm = lockfile present, `node_modules` removed (relink). Every install is verified complete (a sample app must resolve all its declared deps). CPU% and peak RSS are from `/usr/bin/time -v`.

| scale | manager | cold | warm | CPU | peak RSS | nm entries |
|---|---|---|---|---|---|---|
| 300 / 100 | pnpm isolated | 84.2s | 5.3s | 111% | 828 MB | 11,460 |
| | pnpm hoisted | 84.8s | 3.1s | 110% | 953 MB | 10,915 |
| | bun | 1.5s | 0.10s | 165% | 587 MB | 11,078 |
| 1500 / 300 | pnpm isolated | 447.5s | 14.6s | 108% | 963 MB | 12,860 |
| | pnpm hoisted | 419.7s | 6.5s | 115% | 1268 MB | 10,915 |
| | bun | 3.1s | 0.68s | 69% | 88 MB | 11,078 |

Truly-cold (cleared pnpm store + bun cache, network) at 300/100: pnpm-hoisted 74.0s, bun 1.7s.

Reading it:
- pnpm cold install is ~linear in package count (84s → 447s for 5x apps); bun is sub-linear with a much smaller constant (1.5s → 3.1s). bun is ~140x faster cold at 1500, ~22x warm, ~43x even truly-cold, so the gap is not just a warm cache.
- pnpm isolated vs hoisted is about the same (within noise), so the isolated symlink layout is not pnpm's install bottleneck; resolution/linking is.
- Install is largely serial (~1.1 cores for pnpm). bun uses far less memory (88 MB vs ~1.3 GB at 1500).

Fairness/caveats:
- bun ignores `pnpm-workspace.yaml` and the `catalog:` protocol, so the bench runs a decataloged copy with a `package.json` `"workspaces"` field both tools read — a like-for-like dependency set, not the repo's catalog setup.
- bun's `node_modules` is hoisted (flat); pnpm-isolated is a symlinked virtual store that prevents phantom dependencies. The speed numbers are real; the guarantees differ.
- This is install only; Next/Vite/tsc still run on Node.

### Specifier form and node-linker (`scripts/perf-matrix.mjs`)

Does the `workspace:` spec form or the linker mode change install perf? Cold install at 300/100:

| variant | install | nm entries | symlinks |
|---|---|---|---|
| `workspace:*`, isolated (baseline) | 70.3s | 11,983 | 461 |
| `workspace:^x.y.z`, isolated | 71.2s (+1.3%) | 11,983 | 461 |
| `workspace:*`, hoisted | 69.2s (−1.5%) | 11,412 | 9 |

The specifier form is install-neutral (+1.3% is noise; identical lockfile and `node_modules`). node-linker barely changes install *time* here (resolution-bound), but the isolated layout has ~50x more symlinks (461 vs 9) — the inode cost that grows with package count. So choose the form for publish semantics and the linker for strictness/footprint, not for install speed.

## Build: Next vs Vite (`scripts/build-bench.mjs`)

Full `turbo run build` of 40 apps + 24 libs, concurrency 12, 64-core machine. Next is App Router (SSR/RSC); Vite is a client SPA, so this compares build tooling and output, not equivalent features.

| framework | build (all 40 apps) | CPU | peak RSS | total output |
|---|---|---|---|---|
| Next (App Router) | 17.1s | 2886% (~29 cores) | 743 MB | 156.8 MB (`.next`) |
| Vite (SPA) | 7.5s | 1168% (~12 cores) | 192 MB | 7.7 MB (`dist`) |

Vite builds ~2.3x faster and emits ~20x less output for these tiny apps. That is expected: `.next` includes server/RSC bundles and per-route artifacts, while Vite emits a static client bundle; Next also parallelizes across more cores. If you need SSR/RSC/server actions you pick Next regardless. At thousands of apps the framework's per-build time matters less than not building unchanged apps — the affected-closure rule applies the same way to both.


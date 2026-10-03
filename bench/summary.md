# Benchmark results

Generated from `bench/results.json` (pnpm 12.8.1, per each row's `versions.pnpm`). The record carries no machine fields; the machine is described in the README's [Results](../README.md#results-scaling-behavior) section.

| scale | gen | install | lockfile | node_modules | typecheck cold | typecheck warm | focus build | full build tasks | focus pkgs | prune |
|---|---|---|---|---|---|---|---|---|---|---|
| **200 apps / 100 libs** | 890ms | 635ms | 10,185 lines / 277KB | 16,359 entries / 392MB | 8.4s | 978ms | 8.3s | 300 | 75 | 548ms |
| **1,000 apps / 200 libs** | 432ms | 1.1s | 41,515 lines / 1.1MB | 31,791 entries / 403MB | 25s | 3.8s | 11s | 1,200 | 124 | 1.6s |
| **2,000 apps / 300 libs** | 1.2s | 1.6s | 80,255 lines / 2.1MB | 50,827 entries / 418MB | 47s | 5.2s | 12s | 2,300 | 100 | 1.9s |
| **5,000 apps / 300 libs** | 2.1s | 3.9s | 191,255 lines / 5.1MB | 104,827 entries / 460MB | 107s | 11s | 15s | 5,300 | 100 | 4.4s |
| **10,000 apps / 300 libs** | 4.8s | 31s | 376,255 lines / 10.1MB | 194,827 entries / 529MB | 223s | 24s | 22s | 10,300 | 121 | 12s |
| **20,000 apps / 300 libs** | 9.3s | 75s | 746,255 lines / 20.0MB | 374,827 entries / 668MB | — | — | 40s | 20,300 | 100 | 25s |

## Charts

![typecheck-cold-vs-warm.svg](charts/typecheck-cold-vs-warm.svg)

![focus-vs-full.svg](charts/focus-vs-full.svg)

![lockfile-vs-scale.svg](charts/lockfile-vs-scale.svg)

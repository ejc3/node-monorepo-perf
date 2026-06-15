# Benchmark results

Machine: linux, generated from `bench/results.json`.

| scale | gen | install | lockfile | node_modules | typecheck cold | typecheck warm | focus build | full build tasks | focus pkgs | prune |
|---|---|---|---|---|---|---|---|---|---|---|
| **200 apps / 100 libs** | 704ms | 48s | 9,897 lines / 268KB | 16,281 entries / 393MB | 19s | 1.5s | 12s | 300 | 75 | 917ms |
| **1,000 apps / 200 libs** | 613ms | 234s | 41,227 lines / 1.1MB | 31,713 entries / 398MB | 69s | 5.0s | 14s | 1,200 | 124 | 2.7s |
| **2,000 apps / 300 libs** | 1.6s | 472s | 79,967 lines / 2.1MB | 50,749 entries / 404MB | 127s | 7.6s | 16s | 2,300 | 100 | 5.3s |

## Charts

![typecheck-cold-vs-warm.svg](charts/typecheck-cold-vs-warm.svg)

![focus-vs-full.svg](charts/focus-vs-full.svg)

![lockfile-vs-scale.svg](charts/lockfile-vs-scale.svg)

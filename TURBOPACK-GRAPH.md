# Turbopack's Whole-App Module Graph on One Large App

On one App Router app at the scale reported in
[vercel/next.js#98043](https://github.com/vercel/next.js/issues/98043) (2,071 routes,
16,068 TypeScript files), the module graph phase of `next build` is fastest at 16 cores and slower with more: 9.56s at 16 cores, 13.58s at 24, 15.92s at 96 and 38.59s at 192 (both NUMA nodes), with 9.5–11.3 cores busy from 24 to 96 cores. Two
patches to Turbopack v16.4.0 shorten the phase to **0.353×** of base on a 24-core lane
(13.20s → 4.60s) and the Turbopack compile (`run-turbopack`) to **0.709×**, with the same
output. Sources: `bench/turbopack-graph-ab.json`, `bench/turbopack-graph-scaling.json`.

## The App

`scripts/monolith-gen.mjs` (`make monolith`) generates one standalone App Router app; both
records ran its defaults (the records' `app`/`apps` fields, with the tree's hash):

| | |
|---|---|
| routes | 2,071: 1,709 pages (the root page included), 362 route handlers |
| section layouts | 192 |
| generated files | 16,071, of which 16,068 TypeScript |
| feature folders | 420, 29 modules each (lib, `'use client'` and server tiers) |
| UI kit | 700 components behind one `export *` barrel, half `'use client'` |
| util layer | 500 modules behind one `export *` barrel |
| Next / React | 16.4.0 / 19.2.7 |

Import edges point to lower indices inside a tier; server components import another
feature's entry with probability 0.25, zipf-weighted toward low feature indices.
Deterministic per `--seed` (98043).

## Method

- **One build** (`scripts/turbopack-gym/bench.mjs`): a cold
  `next build --experimental-build-mode=compile` in a `systemd-run --scope` pinned to a CPU
  set, its memory on that set's NUMA node. Phase durations and start offsets come from
  Next's `.next/trace-build` events (`turbopack-module-graph`, `turbopack-write-entrypoints`,
  `turbopack-emit`, `run-turbopack`, `turbopack-persistence`). Cores per phase are the
  scope's CPU time over the phase's duration (`cpu.stat`, sampled every 100 ms); `sysShare`
  is the part of that CPU time spent in the kernel.
- **Bindings.** Every binding, `base` included, is `next-napi-bindings` built from the
  v16.4.0 tag with `--release`, LTO off and 16 codegen units; a patched binding differs from
  `base` only by its patches. Each run records the hash of its binding's diff against
  v16.4.0, and the records list each binding's patches with their hashes.
- **A/B** (`ab.mjs`): A and B build at the same time on two 24-core lanes of one NUMA node,
  swapping lanes and launch order every rep, 6 reps; the eight A/Bs ran one after another.
  The ratio is the geometric mean of B/A over the reps, which cancels a fixed speed
  difference between the two lanes; `swapRatios` gives each swapped pair. A row wins when
  the ratio is below 0.96, every swap pair is below 1, `run-turbopack` does not regress by
  more than 2%, and the output fingerprint matches. The two builds share the node's memory
  bandwidth and caches, so a ratio measures B built next to A; the scaling record builds
  one binding at a time.
- **Same output.** The fingerprint hashes every emitted file except the persistent cache,
  trace files and `preview-props.json`, after normalizing what varies between builds of one
  binding: the run's output directory name, `.js`/`.css` file names (chunk names carry
  per-build hashes), 32+ character hex strings, and one- and two-character identifiers
  (minified locals). Every file's remaining content is compared. The records also keep each
  build's exact hash, which differs between the two sides of the A/A row.
- **Scaling** (`scaling.mjs`): one build at a time holding every CPU of the box, base and
  15 + 22 interleaved with the order rotating each rep, 3 reps per point; lanes start at CPU
  0, so sizes up to 96 sit on NUMA node 0 and 192 spans both nodes.
- **Machine.** A dedicated c8g.48xlarge: 192 Neoverse-V2 vCPUs in two NUMA nodes, 371 GiB, Node 22.23.3 (the records' `machine` fields).

## Results

<!-- turbopack-graph:ab -->
| B (A = base) | graph phase | ratio | swap pairs | run-turbopack | ratio | cores in graph phase |
|---|---|---|---|---|---|---|
| A/A (base vs base) | 13.03s → 12.42s | 0.965 | 0.967, 0.951, 0.978 | 45.22s → 44.53s | 0.982 | 9.6 → 9.7 |
| 11: topological binding usage | 13.05s → 8.98s | **0.683** | 0.693, 0.687, 0.669 | 45.43s → 40.91s | 0.894 | 9.6 → 13.8 |
| 15: 11 + merged-modules order + interned bitmaps | 13.18s → 9.07s | **0.673** | 0.731, 0.663, 0.630 | 45.38s → 36.26s | 0.800 | 9.6 → 13.4 |
| 22: sharded scheduler queue | 12.72s → 8.66s | **0.677** | 0.664, 0.697, 0.669 | 45.48s → 40.23s | 0.880 | 9.5 → 9.6 |
| 15 + 22 | 13.20s → 4.60s | **0.353** | 0.373, 0.346, 0.340 | 45.63s → 32.46s | 0.709 | 9.6 → 17.2 |
| base, 16 worker threads | 12.88s → 9.73s | **0.764** | 0.785, 0.779, 0.731 | 45.56s → 44.86s | 0.989 | 9.6 → 7.7 |
| base, 8 GiB eviction floor | 13.08s → 13.17s | 1.020 | 0.977, 1.101, 0.987 | 44.47s → 45.48s | 1.017 | 9.5 → 9.4 |
| base, no persistent build cache | 13.07s → 13.93s | 1.060 | 1.113, 1.008, 1.061 | 45.26s → 36.92s | 0.816 | 9.6 → 8.9 |

8 rows, 6 reps each. Output fingerprint: matches base except in base, no persistent build cache.
<!-- /turbopack-graph:ab -->

## What Bounds the Phase

- **The scheduler's queue lock.** turbo-tasks' `PriorityRunner`
  (`turbopack/crates/turbo-tasks/src/priority_runner.rs`) keeps every scheduled task in one
  mutex-guarded queue. Scheduling a task, a reader claiming one to run inline, and a worker
  taking its next task all take that lock. Fewer workers make the phase shorter: capping
  turbo-tasks at 16 worker threads on a 24-core lane gives 0.764× with fewer cores busy, and
  leaves `run-turbopack` at 0.989×. Patch 22 splits the queue into shards (the worker count
  over four, rounded up to a power of two, at most 64; one shard below eight workers). A
  task with a claim key goes to the shard its key hashes to and others rotate over the
  shards; a worker takes the higher-priority head of two non-empty shards, trying the
  second shard's lock without waiting for it: 0.677×.
- **A whole-graph fixed point visited breadth-first.** `compute_binding_usage_info`
  (`turbopack/crates/turbopack-core/src/module_graph/binding_usage_info.rs`) is called twice
  in the phase, for the base graph and the full graph
  (`crates/next-api/src/project.rs`, `whole_app_module_graph_operation`), and walks the graph
  in one sequential loop. Visiting breadth-first, it processes a module that re-exports a
  large barrel again each time a newly visited importer adds a used export, and each pass
  copies the barrel's export set along every `export *` edge. Patch 11 visits modules by
  their DFS post-order index, so each module comes after its importers as far as cycles
  allow; the fixed point it reaches does not depend on the visit order: 0.683×. Patch 15
  adds three things to 11: the same order for the merged-modules fixed point
  (`merged_modules.rs`), the ordering computed once on the graph snapshot (`mod.rs`), and
  merged-module bitmaps interned to small ids instead of hashed: 0.673× on the graph phase,
  0.800× on `run-turbopack`.
- **Together.** 15 + 22 reach 0.353×; the product of their separate ratios is 0.455.
- **Not the bound.** An 8 GiB eviction floor gives 1.020× (not a win). Turning off the
  persistent build cache gives 1.060× on the graph phase and 0.816× on `run-turbopack`; its
  output fingerprint differs from base because Next serializes the setting into the build
  output (`required-server-files.json`).

## Scaling

<!-- turbopack-graph:scaling -->
| cores | base graph phase | cores busy | kernel | 15+22 graph phase | cores busy | kernel | run-turbopack, base → 15+22 |
|---|---|---|---|---|---|---|---|
| 8 | 12.17s | 5.0 | 3.3% | 8.18s | 7.0 | 3.4% | 57.72s → 46.34s |
| 16 | 9.56s | 7.8 | 6.8% | 5.26s | 12.7 | 5.4% | 44.49s → 34.50s |
| 24 | 13.58s | 9.5 | 28.8% | 4.36s | 17.8 | 5.8% | 44.98s → 31.34s |
| 32 | 14.04s | 10.3 | 35.7% | 4.34s | 22.6 | 6.4% | 44.31s → 31.13s |
| 48 | 13.83s | 11.1 | 38.7% | 4.09s | 32.2 | 5.3% | 46.96s → 30.25s |
| 64 | 14.33s | 11.3 | 41.2% | 4.05s | 41.9 | 4.5% | 47.56s → 30.61s |
| 96 | 15.92s | 11.3 | 43.7% | 4.08s | 60.5 | 3.6% | 49.79s → 31.29s |
| 192 | 38.59s | 9.3 | 45.8% | 5.87s | 74.8 | 15.3% | 92.80s → 44.83s |

Medians over 3 interleaved runs per point.
<!-- /turbopack-graph:scaling -->

- **Base is fastest at 16 cores.** From 24 to 96 cores the phase takes 13.58–15.92s,
  cores busy stay at 9.5–11.3, and the kernel's share of the phase's CPU time rises from
  28.8% to 43.7% (6.8% at 16 cores). Across both NUMA nodes it takes 38.59s.
- **15 + 22 holds at 4.05–4.36s from 24 to 96 cores** while cores busy rise from 17.8 to
  60.5 and the kernel share stays at 3.6–6.4%. It is 0.26× base at 96 cores
  (15.92s → 4.08s) and 0.15× at 192 (38.59s → 5.87s). At 24 cores, built alone, it is
  0.32× base (13.58s → 4.36s); the A/B, with the two builds side by side, measures 0.353×.
- **The rest of the compile now bounds it.** With 15 + 22, `run-turbopack` holds at
  30.25–31.34s from 24 to 96 cores, of which `turbopack-write-entrypoints` (it contains the
  graph phase) is 14.11–14.68s.

## Open Items

- After the graph phase, `compute_chunk_group_info` and the merged-modules reconciliation run
  as sequential loops inside `turbopack-write-entrypoints`. Chunk-group ids are assigned in
  visit order and feed the output's ordering, so a reorder there has to keep that order.
- The patches are against v16.4.0.

## Reproduce

```bash
export GYM_ROOT=/path/to/scratch     # next.js clone, one cargo target per binding, the apps
make gym-setup                       # clone v16.4.0, build the base binding, generate + install the apps
make gym-selftest BUILDS=1           # locks, record verification, output fingerprint
make gym-canonical                   # build 11, 15, 22, 15+22 from the patches; A/Bs; scaling; records
node scripts/turbopack-gym/report.mjs   # re-render this doc's tables from the records
```

`GYM_HOST=<name>` runs the measurements on another machine (`hosts.local.json`; see AGENTS.md,
"Turbopack Graph Gym").

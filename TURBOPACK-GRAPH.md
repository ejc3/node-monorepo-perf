# Turbopack's Whole-App Module Graph on One Large App

On one App Router app at the scale reported in
[vercel/next.js#98043](https://github.com/vercel/next.js/issues/98043) (the issue reports
2,070 routes; the generated app has 2,071, with 16,068 TypeScript files), the module graph
phase of `next build` takes <!--v:sc.base.16.graph-->9.62s<!--/v--> at 16 cores, <!--v:sc.base.24.graph-->13.40s<!--/v--> at 24, <!--v:sc.base.96.graph-->15.62s<!--/v--> at 96 and <!--v:sc.base.192.graph-->38.41s<!--/v--> at 192 (both NUMA nodes), with <!--v:sc.base.24-96.cores-->9.7–11.6<!--/v--> cores busy from 24 to 96 cores. Two patches to Turbopack v16.4.0 shorten the phase to
**<!--v:ab.15+22.ratio-->0.360<!--/v-->×** of base on a 24-core lane (<!--v:ab.15+22.graphA-->12.88s<!--/v--> → <!--v:ab.15+22.graphB-->4.59s<!--/v-->) and the Turbopack compile
(`run-turbopack`) to **<!--v:ab.15+22.guard-->0.713<!--/v-->×**, with the same output. Sources:
`bench/turbopack-graph-ab.json`, `bench/turbopack-graph-scaling.json`.

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
  scope's CPU time over the phase's duration (`cpu.stat`, sampled every 100 ms by a separate
  process; a run with a sampling gap over 3 s is rejected); `sysShare` is the part of that
  CPU time spent in the kernel.
- **Bindings.** Every binding, `base` included, is `next-napi-bindings` built from the
  v16.4.0 tag with `--release`, LTO off and 16 codegen units; a patched binding differs from
  `base` only by its patches. A built binding is stored once under the hash of its native
  module and never changed; each run records that hash, its source commit and the hash of
  its diff against v16.4.0, and the records check the commit and diff against the patches
  they list (`bench/turbopack-gym/bindings.json`).
- **A/B** (`ab.mjs`): A and B build at the same time on two 24-core lanes of one NUMA node,
  6 reps; lanes swap every rep and launch order every two reps, so which build starts first
  does not follow the lane, and both are prepared (hashed) before either starts. The eight
  A/Bs ran one after another. The ratio is the geometric mean of B/A over the reps, which
  cancels a fixed speed difference between the two lanes; `swapRatios` gives each swapped
  pair. A row wins when the ratio is below 0.94, every swap pair is below 1, `run-turbopack`
  does not regress by more than 2%, and the output fingerprint matches. The two builds share
  the node's memory bandwidth and caches, so a ratio measures B built next to A; the scaling
  record builds one binding at a time.
- **Same output.** The fingerprint hashes every emitted file except the top-level cache and
  trace files and `server/preview-props.json`, after normalizing what varies between builds
  of one binding: the run's output directory name, `.js`/`.css` file names (chunk names
  carry per-build hashes), 32+ character hex strings, and one- and two-character words
  (minified locals, which the minifier renames between builds). Every file's remaining
  content is compared; a change that only swaps one- or two-character words, even inside a
  string, is not detected. The records also keep each build's exact hash, which differs
  between the two sides of the A/A row.
- **Scaling** (`scaling.mjs`): one build at a time holding every CPU of the box, base and
  15 + 22 interleaved with the order rotating each rep, 3 reps per point; lanes start at CPU
  0, so sizes up to 96 sit on NUMA node 0 and 192 spans both nodes.
- **Machine.** <!--v:machine-->a dedicated c8g.48xlarge: 192 Neoverse-V2 vCPUs in 2 NUMA nodes, 371 GiB, Node 22.23.3<!--/v--> (the records' `machine` fields).

## Results

<!-- turbopack-graph:ab -->
| B (A = base) | graph phase | ratio | swap pairs | run-turbopack | ratio | cores in graph phase |
|---|---|---|---|---|---|---|
| A/A (base vs base) | 13.15s → 12.94s | 0.987 | 1.001, 1.039, 0.924 | 44.44s → 45.08s | 1.009 | 9.5 → 9.6 |
| 11: topological binding usage | 13.11s → 8.80s | **0.667** | 0.654, 0.637, 0.711 | 45.37s → 40.53s | 0.895 | 9.6 → 13.6 |
| 15: 11 + merged-modules order + interned bitmaps | 12.15s → 8.95s | **0.712** | 0.701, 0.749, 0.688 | 45.29s → 36.75s | 0.821 | 9.7 → 13.5 |
| 22: sharded scheduler queue | 13.16s → 8.74s | **0.676** | 0.725, 0.647, 0.659 | 45.41s → 40.74s | 0.900 | 9.6 → 9.7 |
| 15 + 22 | 12.88s → 4.59s | **0.360** | 0.375, 0.348, 0.356 | 45.51s → 32.08s | 0.713 | 9.5 → 17.2 |
| base, 16 worker threads | 13.46s → 9.76s | **0.749** | 0.779, 0.767, 0.703 | 45.13s → 44.67s | 1.000 | 9.6 → 7.7 |
| base, 8 GiB eviction floor | 13.16s → 12.61s | 0.953 | 0.879, 0.918, 1.071 | 45.76s → 45.15s | 0.987 | 9.5 → 9.6 |
| base, no persistent build cache | 13.11s → 13.67s | 1.058 | 1.074, 1.071, 1.029 | 45.16s → 36.73s | 0.821 | 9.5 → 9.0 |

8 rows, 6 reps each. Output fingerprint: matches base except in base, no persistent build cache.
<!-- /turbopack-graph:ab -->

## What Bounds the Phase

- **The scheduler's queue lock.** turbo-tasks' `PriorityRunner`
  (`turbopack/crates/turbo-tasks/src/priority_runner.rs`) keeps every scheduled task in one
  mutex-guarded queue. Scheduling a task, a reader claiming one to run inline, and a worker
  taking its next task all take that lock. Fewer workers make the phase shorter: capping
  turbo-tasks at 16 worker threads on a 24-core lane gives <!--v:ab.workers-16.ratio-->0.749<!--/v-->× with
  <!--v:ab.workers-16.coresB-->7.7<!--/v--> instead of <!--v:ab.workers-16.coresA-->9.6<!--/v--> cores busy, and leaves `run-turbopack` at
  <!--v:ab.workers-16.guard-->1.000<!--/v-->×. Patch 22 splits the queue into shards (the worker count
  over four, rounded up to a power of two, at most 64; one shard below eight workers). A
  task with a claim key goes to the shard its key hashes to and others rotate over the
  shards; a worker takes the higher-priority head of two non-empty shards, trying the
  second shard's lock without waiting for it: <!--v:ab.22.ratio-->0.676<!--/v-->×.
- **A whole-graph fixed point in discovery order.** `compute_binding_usage_info`
  (`turbopack/crates/turbopack-core/src/module_graph/binding_usage_info.rs`) is called twice
  in the phase, for the base graph and the full graph (`crates/next-api/src/project.rs`,
  `whole_app_module_graph_operation`), and walks the graph in one sequential loop
  (`traverse_edges_fixed_point_with_priority` in `module_graph/mod.rs`). Every module has
  the same priority there, and its max-heap breaks the tie by discovery index, so the most
  recently discovered module is taken first (the code comment next to it describes the
  reverse, breadth-first order). In an order that is not topological, a module that
  re-exports a large barrel is processed again each time a newly visited importer adds a
  used export, and each pass copies the barrel's export set along every `export *` edge.
  Patch 11 gives each module its DFS post-order index as priority, so each module comes
  after its importers as far as cycles allow; the fixed point it reaches does not depend on
  the visit order: <!--v:ab.11.ratio-->0.667<!--/v-->×. Patch 15 adds three things to 11: the same order for the
  merged-modules fixed point (`merged_modules.rs`), the ordering computed once on the graph
  snapshot (`mod.rs`), and merged-module bitmaps interned to small ids instead of hashed:
  <!--v:ab.15.ratio-->0.712<!--/v-->× on the graph phase, <!--v:ab.15.guard-->0.821<!--/v-->× on `run-turbopack`.
- **Together.** 15 + 22 reach <!--v:ab.15+22.ratio-->0.360<!--/v-->×; the product of their separate ratios is <!--v:prod.15.22-->0.482<!--/v-->.
- **Not the bound.** An 8 GiB eviction floor gives <!--v:ab.evict-8g.ratio-->0.953<!--/v-->×, with its lane-swapped pairs on both sides of 1 (not a win; the A/A row spreads about as far). Turning off the persistent build
  cache gives <!--v:ab.no-fs-cache.ratio-->1.058<!--/v-->× on the graph phase and <!--v:ab.no-fs-cache.guard-->0.821<!--/v-->× on `run-turbopack`; a changed build
  setting changes the build's output, so its fingerprint differs from base.

## Scaling

<!-- turbopack-graph:scaling -->
| cores | base graph phase | cores busy | kernel | 15+22 graph phase | cores busy | kernel | run-turbopack, base → 15+22 |
|---|---|---|---|---|---|---|---|
| 8 | 12.27s | 5.1 | 3.7% | 8.31s | 7.0 | 3.9% | 58.96s → 45.25s |
| 16 | 9.62s | 7.8 | 7.4% | 5.22s | 12.6 | 5.8% | 45.05s → 34.26s |
| 24 | 13.40s | 9.7 | 28.3% | 4.72s | 18.0 | 5.8% | 45.84s → 33.68s |
| 32 | 13.24s | 10.6 | 35.3% | 4.47s | 22.9 | 6.0% | 44.11s → 32.42s |
| 48 | 13.48s | 11.1 | 39.2% | 4.08s | 32.2 | 5.8% | 45.70s → 30.60s |
| 64 | 14.68s | 11.2 | 41.0% | 4.11s | 42.3 | 4.6% | 48.65s → 31.07s |
| 96 | 15.62s | 11.6 | 44.4% | 4.08s | 61.1 | 3.6% | 49.23s → 31.68s |
| 192 | 38.41s | 9.4 | 46.8% | 5.89s | 75.9 | 13.4% | 91.92s → 45.12s |

Medians over 3 interleaved runs per point.
<!-- /turbopack-graph:scaling -->

- **Base.** The phase takes <!--v:sc.base.16.graph-->9.62s<!--/v--> at 16 cores and <!--v:sc.base.24-96.graph-->13.24–15.62s<!--/v--> from 24 to
  96 cores, where cores busy stay at <!--v:sc.base.24-96.cores-->9.7–11.6<!--/v--> and the kernel's share of the
  phase's CPU time is <!--v:sc.base.24-96.sys-->28.3–44.4%<!--/v--> (<!--v:sc.base.16.sys-->7.4%<!--/v--> at 16 cores). Across both NUMA
  nodes it takes <!--v:sc.base.192.graph-->38.41s<!--/v-->.
- **15 + 22** takes <!--v:sc.15+22.24-96.graph-->4.08–4.72s<!--/v--> from 24 to 96 cores while cores busy rise over
  <!--v:sc.15+22.24-96.cores-->18.0–61.1<!--/v--> and the kernel share stays at <!--v:sc.15+22.24-96.sys-->3.6–6.0%<!--/v-->. It is
  <!--v:ratio.sc.base.15+22.96.graph-->0.26<!--/v-->× base at 96 cores (<!--v:sc.base.96.graph-->15.62s<!--/v--> → <!--v:sc.15+22.96.graph-->4.08s<!--/v-->) and
  <!--v:ratio.sc.base.15+22.192.graph-->0.15<!--/v-->× at 192 (<!--v:sc.base.192.graph-->38.41s<!--/v--> → <!--v:sc.15+22.192.graph-->5.89s<!--/v-->). At 24 cores, built
  alone, it is <!--v:ratio.sc.base.15+22.24.graph-->0.35<!--/v-->× base (<!--v:sc.base.24.graph-->13.40s<!--/v--> → <!--v:sc.15+22.24.graph-->4.72s<!--/v-->); the A/B, with the two
  builds side by side, measures <!--v:ab.15+22.ratio-->0.360<!--/v-->×.
- **The rest of the compile.** With 15 + 22, `run-turbopack` takes <!--v:sc.15+22.24-96.tp-->30.60–33.68s<!--/v--> from
  24 to 96 cores, of which `turbopack-write-entrypoints` (it contains the graph phase) is
  <!--v:sc.15+22.24-96.entry-->14.24–15.36s<!--/v-->.

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

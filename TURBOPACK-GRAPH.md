# Turbopack's Whole-App Module Graph on One Large App

On one App Router app at the scale reported in
[vercel/next.js#98043](https://github.com/vercel/next.js/issues/98043) (the issue reports
2,070 routes; the generated app has 2,071, with 16,068 TypeScript files), the module graph
phase of `next build` takes <!--v:sc.base.16.graph-->9.62s<!--/v--> at 16 cores, <!--v:sc.base.24.graph-->13.40s<!--/v--> at 24, <!--v:sc.base.96.graph-->15.62s<!--/v--> at 96 and <!--v:sc.base.192.graph-->38.41s<!--/v--> at 192 (both NUMA nodes), with <!--v:sc.base.24-96.cores-->9.7–11.6<!--/v--> cores busy from 24 to 96 cores. Two patches to Turbopack v16.4.0 shorten the phase to
**<!--v:ab.15+22.ratio-->0.360<!--/v-->×** of base on a 24-core lane (<!--v:ab.15+22.graphA-->12.88s<!--/v--> → <!--v:ab.15+22.graphB-->4.59s<!--/v-->) and the Turbopack compile
(`run-turbopack`) to **<!--v:ab.15+22.guard-->0.713<!--/v-->×**, with the same output. Sources:
`bench/turbopack-graph-ab.json`, `bench/turbopack-graph-scaling.json`.

## The App

`scripts/monolith-gen.mjs` (`make monolith`) generates one standalone App Router app. Both
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

Import edges point to lower indices inside a tier. Server components import another
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
  module and never changed. Each run records that hash, its source commit and the hash of
  its diff against v16.4.0, and the records check the commit and diff against the patches
  they list (`bench/turbopack-gym/bindings.json`).
- **A/B** (`ab.mjs`): A and B build at the same time on two 24-core lanes of one NUMA node,
  6 reps. Lanes swap every rep and launch order every two reps, so which build starts first
  does not follow the lane; both are prepared (hashed) before either starts. The eight A/Bs
  ran one after another. The ratio is the geometric mean of B/A over the reps, which cancels
  a fixed speed difference between the two lanes; `swapRatios` gives each swapped
  pair. A row wins when the ratio is below 0.94, every swap pair is below 1, `run-turbopack`
  does not regress by more than 2%, and the output fingerprint matches. The two builds share
  the node's memory bandwidth and caches, so a ratio measures B built next to A; the scaling
  record builds one binding at a time.
- **Same output.** The fingerprint hashes every emitted file except the top-level cache and
  trace files and `server/preview-props.json`, after normalizing what varies between builds
  of one binding: the run's output directory name, `.js`/`.css` file names (chunk names
  carry per-build hashes), 32+ character hex strings, and one- and two-character words
  (minified locals, which the minifier renames between builds). Every file's remaining
  content is compared. A change that only swaps one- or two-character words, even inside a
  string, is not detected. The records also keep each build's exact hash, which differs
  between the two sides of the A/A row.
- **Scaling** (`scaling.mjs`): one build at a time holding every CPU of the box; base and
  15 + 22 interleave with the order rotating each rep, 3 reps per point. Lanes start at CPU
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
  <!--v:ab.workers-16.guard-->1.000<!--/v-->×. Patch 22 splits the queue into shards: the worker count
  over four, rounded up to a power of two, at most 64; one shard below eight workers. A
  task with a claim key goes to the shard its key hashes to; others rotate over the shards.
  A worker takes the higher-priority head of two non-empty shards and tries the second
  shard's lock without waiting for it. This gives <!--v:ab.22.ratio-->0.676<!--/v-->×.
- **A whole-graph fixed point in discovery order.** `compute_binding_usage_info`
  (`turbopack/crates/turbopack-core/src/module_graph/binding_usage_info.rs`) is called twice
  in the phase, for the base graph and the full graph (`crates/next-api/src/project.rs`,
  `whole_app_module_graph_operation`), and walks the graph in one sequential loop
  (`traverse_edges_fixed_point_with_priority` in `module_graph/mod.rs`). Every module has
  the same priority there, and the loop's max-heap breaks the tie by discovery index, so the
  most recently discovered module is taken first; the code comment next to it describes the
  reverse, breadth-first order. In an order that is not topological, a module that
  re-exports a large barrel is processed again each time a newly visited importer adds a
  used export, and each pass copies the barrel's export set along every `export *` edge.
  Patch 11 gives each module its DFS post-order index as priority, so each module comes
  after its importers as far as cycles allow; the fixed point it reaches does not depend on
  the visit order. This gives <!--v:ab.11.ratio-->0.667<!--/v-->×. Patch 15 adds three things to 11: the same order for the
  merged-modules fixed point (`merged_modules.rs`), the ordering computed once on the graph
  snapshot (`mod.rs`), and merged-module bitmaps interned to small ids instead of hashed. It
  gives <!--v:ab.15.ratio-->0.712<!--/v-->× on the graph phase and <!--v:ab.15.guard-->0.821<!--/v-->× on `run-turbopack`.
- **Together.** 15 + 22 reach <!--v:ab.15+22.ratio-->0.360<!--/v-->×; the product of their separate ratios is <!--v:prod.15.22-->0.482<!--/v-->.
- **Not the bound.** An 8 GiB eviction floor gives <!--v:ab.evict-8g.ratio-->0.953<!--/v-->×, with its lane-swapped pairs on both sides of 1: not a win, since the A/A row spreads about as far. Turning off the persistent build
  cache gives <!--v:ab.no-fs-cache.ratio-->1.058<!--/v-->× on the graph phase and <!--v:ab.no-fs-cache.guard-->0.821<!--/v-->× on `run-turbopack`. Its fingerprint
  differs from base.

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

- **15 + 22** takes <!--v:sc.15+22.24-96.graph-->4.08–4.72s<!--/v--> from 24 to 96 cores while cores busy rise across
  <!--v:sc.15+22.24-96.cores-->18.0–61.1<!--/v--> and the kernel share stays at <!--v:sc.15+22.24-96.sys-->3.6–6.0%<!--/v-->. It is
  <!--v:ratio.sc.base.15+22.96.graph-->0.26<!--/v-->× base at 96 cores (<!--v:sc.base.96.graph-->15.62s<!--/v--> → <!--v:sc.15+22.96.graph-->4.08s<!--/v-->) and
  <!--v:ratio.sc.base.15+22.192.graph-->0.15<!--/v-->× at 192 (<!--v:sc.base.192.graph-->38.41s<!--/v--> → <!--v:sc.15+22.192.graph-->5.89s<!--/v-->). At 24 cores, built
  alone, it is <!--v:ratio.sc.base.15+22.24.graph-->0.35<!--/v-->× base (<!--v:sc.base.24.graph-->13.40s<!--/v--> → <!--v:sc.15+22.24.graph-->4.72s<!--/v-->); the A/B, with the two
  builds side by side, measures <!--v:ab.15+22.ratio-->0.360<!--/v-->×.
- **The rest of the compile.** With 15 + 22, `run-turbopack` takes <!--v:sc.15+22.24-96.tp-->30.60–33.68s<!--/v--> from
  24 to 96 cores, of which `turbopack-write-entrypoints` (it contains the graph phase) is
  <!--v:sc.15+22.24-96.entry-->14.24–15.36s<!--/v-->.

## A Realistic App: vizdash

`scripts/vizdash-gen.mjs` generates a hand-written data-visualization app (screenshots in
`bench/turbopack-gym/vizdash/`): 2,069 routes of dashboards across product areas, 16,525
TypeScript files, over a shared visualization library (charts, KPI cards, tables, filters)
built on recharts, echarts, visx, d3 modules, TanStack Table, date-fns and lodash-es.
Its record, `bench/turbopack-graph-vizdash.json`, ran on a dedicated 192-core c8g.48xlarge
with nothing else running (one A/B at a time, lanes of 24 CPUs on one NUMA node).

- **15 + 22:** graph phase <!--v:vz.viz-15+22.ratio-->0.475<!--/v-->× (<!--v:vz.viz-15+22.graphA-->15.89s<!--/v--> → <!--v:vz.viz-15+22.graphB-->7.49s<!--/v-->),
  `run-turbopack` <!--v:vz.viz-15+22.guard-->0.686<!--/v-->×, same output.
- **41 and 42 on top of 15 + 22** (`bench/turbopack-gym/next-limit.md`): `run-turbopack`
  <!--v:vz.viz-41+42.guard-->0.993<!--/v-->×. The serial passes they shorten on the monolith are not on this app's
  critical path.
- **All four:** graph phase <!--v:vz.viz-full.ratio-->0.447<!--/v-->×, `run-turbopack` <!--v:vz.viz-full.guard-->0.662<!--/v-->×.

## The Persistent Cache Against Changed Files

The second observation in #98043: a build that restores Turbopack's persistent cache from an
earlier build gets slower as more files change, until it is slower than a cold build.
`scripts/turbopack-gym/drift.mjs` measures it on a copy of the monolith. It builds the
unchanged tree once into a fixed output directory and keeps that directory with its cache.
Then, for N changed feature modules, it builds the edited tree three ways:

- **warm**: that directory and cache restored as a new copy, so none of it is in the page
  cache, as after a CI cache restore;
- **cold**: a fresh directory; the cache starts empty and is written;
- **off**: the persistent cache turned off.

The tree is restored after each N. Warm and cold builds of one tree give the same output; a
cache-off build's differs and is the same across reps. Method, profiles and candidates: [bench/turbopack-gym/cache-drift.md](bench/turbopack-gym/cache-drift.md).

The record, `bench/turbopack-graph-drift.json`, ran on a dedicated 192-core c8gd.48xlarge (24
CPUs per build, one build at a time, 2 reps; the gym root on btrfs over its local NVMe).
Wall times (`run-turbopack` in the cache-read table below):

| changed modules | edit | warm, base | warm, 55 | cold, base | off, base |
|---|---|---|---|---|---|
| 0 | none | <!--v:dr.main.label.base.0.warm.wall-->31.8s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.0.warm.wall-->17.5s<!--/v--> | <!--v:dr.main.label.base.0.cold.wall-->74.3s<!--/v--> | <!--v:dr.main.label.base.0.off.wall-->66.9s<!--/v--> |
| 1,000 | a string literal | <!--v:dr.main.label.base.1000.warm.wall-->46.1s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.1000.warm.wall-->44.4s<!--/v--> | <!--v:dr.main.label.base.1000.cold.wall-->73.9s<!--/v--> | <!--v:dr.main.label.base.1000.off.wall-->89.0s<!--/v--> |
| 1 | a new import | <!--v:dr.main.import.base.1.warm.wall-->58.8s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.1.warm.wall-->53.2s<!--/v--> | <!--v:dr.main.import.base.1.cold.wall-->78.2s<!--/v--> | <!--v:dr.main.import.base.1.off.wall-->68.6s<!--/v--> |
| 10 | a new import | <!--v:dr.main.import.base.10.warm.wall-->77.7s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.10.warm.wall-->74.2s<!--/v--> | <!--v:dr.main.import.base.10.cold.wall-->74.2s<!--/v--> | <!--v:dr.main.import.base.10.off.wall-->65.9s<!--/v--> |
| 1,000 | a new import | <!--v:dr.main.import.base.1000.warm.wall-->112.2s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.1000.warm.wall-->106.3s<!--/v--> | <!--v:dr.main.import.base.1000.cold.wall-->72.5s<!--/v--> | <!--v:dr.main.import.base.1000.off.wall-->68.7s<!--/v--> |

- **What the edit changes matters more than how many files.** After a string changes in
  1,000 modules, base's warm build takes <!--v:dr.main.label.base.1000.warm.over.cold-->0.62<!--/v-->× a cold build's time. One new import adds
  about 26s to the warm build (`run-turbopack` <!--v:dr.main.import.base.0.warm.turbopack-->13.3s<!--/v--> → <!--v:dr.main.import.base.1.warm.turbopack-->39.6s<!--/v-->); ten make it slower than a cold
  build. A new edge changes the whole-app module graph, and the analyses over it run again on
  task state read back from the cache.
- **55 shortens every warm build** (next paragraph), but with new imports it removes 3 to 6s
  of a much longer build. At 10 new imports base's warm build takes <!--v:dr.main.import.base.10.warm.wall-->77.7s<!--/v--> and 55's
  <!--v:dr.main.import.55-sst-mmap-normal-advice.10.warm.wall-->74.2s<!--/v-->, against <!--v:dr.main.import.base.10.cold.wall-->74.2s<!--/v--> cold; 55's warm build exceeds its cold build at the measured 100 and 1,000 new imports.
- With the cache on, a cold build's `run-turbopack` takes longer than a cache-off build's at
  every N (writing the cache, and the operation counter below); the `no-fs-cache` A/B above
  shows the same. One cache-off build at 1,000 changed strings ran 37s longer than its other
  rep, almost all of it after `run-turbopack` and unexplained; it lifts that median.

**A warm start reads its cache one page at a time.** The cache's SST files are mmapped with
`MADV_RANDOM`, which turns off the kernel's read-ahead. Each 4 KiB page of a block that is
not in the page cache is its own read, and the lookups that restore tasks depend on each
other, so those reads queue. On instance A the unchanged tree's warm build (with `base-fp`,
base built with frame pointers) spends
<!--v:cr.pageCache.base-fp.cold.0.turbopack-->38.7s<!--/v--> in `run-turbopack`, and <!--v:cr.pageCache.base-fp.hot.0.turbopack-->4.4s<!--/v--> once the page cache holds the cache files, same output
(`bench/turbopack-gym/cache-read-probes.json`). Candidate 55 drops that advice (one line),
so faults get the default read-ahead, as `TURBO_PERSISTENCE_MMAP=0`'s `pread` reads already
do. Warm builds with the cache not in the page cache, `run-turbopack`, same output:

| instance | change | base | 55 | base, `pread` |
|---|---|---|---|---|
| C | none | <!--v:cr.candidatesC.base.mmap.0.turbopack-->13.0s<!--/v--> | <!--v:cr.candidatesC.55-sst-mmap-normal-advice.mmap.0.turbopack-->4.6s<!--/v--> | <!--v:cr.candidatesC.base.pread.0.turbopack-->6.7s<!--/v--> |
| C | 1 string | <!--v:cr.candidatesC.base.mmap.1.turbopack-->11.0s<!--/v--> | <!--v:cr.candidatesC.55-sst-mmap-normal-advice.mmap.1.turbopack-->5.1s<!--/v--> | <!--v:cr.candidatesC.base.pread.1.turbopack-->7.0s<!--/v--> |
| D | none | <!--v:cr.candidatesD.base.mmap.0.turbopack-->13.1s<!--/v--> | <!--v:cr.candidatesD.55-sst-mmap-normal-advice.mmap.0.turbopack-->4.7s<!--/v--> | <!--v:cr.candidatesD.base.pread.0.turbopack-->6.9s<!--/v--> |
| D | 1 string | <!--v:cr.candidatesD.base.mmap.1.turbopack-->11.3s<!--/v--> | <!--v:cr.candidatesD.55-sst-mmap-normal-advice.mmap.1.turbopack-->5.3s<!--/v--> | <!--v:cr.candidatesD.base.pread.1.turbopack-->7.2s<!--/v--> |

On instances A and B, of the same type (`base-fp` and base), the same build took <!--v:cr.pageCache.base-fp.cold.0.turbopack-->38.7s<!--/v--> and <!--v:cr.accessMode.base.mmap.0.turbopack-->38.6s<!--/v--> where it took 13s on C and D; the cause of that difference is not known.
55 changes nothing when the page cache already holds the cache. Cold builds do not read the
cache (A/B of cold builds: `run-turbopack` ×1.004, same output). Candidates 53 (read a
block's whole range before its first access) and 54 (53 plus the meta files) help less than
55: a warm start reads most of every SST, and read-ahead also fetches the blocks that follow.

**With new imports, emit runs mostly on one core.** A warm build's `turbopack-emit` after
1,000 new imports spends most of its time applying collectible changes up the aggregation
graph, and a task that takes the collectibles of a subgraph records their removal one
collectible at a time, each its own operation.
Candidate 56 removes them as one operation with one aggregated update for the batch
(`bench/turbopack-graph-drift-56.json`, another dedicated c8gd.48xlarge, page-data workers
matched to the build's CPUs; same output at every point). Warm builds, `run-turbopack` /
`turbopack-emit`:

| new imports | base | 56 | 15 + 22 + 55 | 15 + 22 + 55 + 56 |
|---|---|---|---|---|
| 10 | <!--v:dr.c56.import.base.10.warm.turbopack-->74.8s<!--/v--> / <!--v:dr.c56.import.base.10.warm.emit-->12.2s<!--/v--> | <!--v:dr.c56.import.56-batch-unemit-collectibles.10.warm.turbopack-->72.2s<!--/v--> / <!--v:dr.c56.import.56-batch-unemit-collectibles.10.warm.emit-->9.4s<!--/v--> | <!--v:dr.c56.import.15+22+55.10.warm.turbopack-->42.0s<!--/v--> / <!--v:dr.c56.import.15+22+55.10.warm.emit-->11.5s<!--/v--> | <!--v:dr.c56.import.15+22+55+56.10.warm.turbopack-->38.7s<!--/v--> / <!--v:dr.c56.import.15+22+55+56.10.warm.emit-->8.5s<!--/v--> |
| 1,000 | <!--v:dr.c56.import.base.1000.warm.turbopack-->99.7s<!--/v--> / <!--v:dr.c56.import.base.1000.warm.emit-->39.0s<!--/v--> | <!--v:dr.c56.import.56-batch-unemit-collectibles.1000.warm.turbopack-->87.1s<!--/v--> / <!--v:dr.c56.import.56-batch-unemit-collectibles.1000.warm.emit-->26.9s<!--/v--> | <!--v:dr.c56.import.15+22+55.1000.warm.turbopack-->74.5s<!--/v--> / <!--v:dr.c56.import.15+22+55.1000.warm.emit-->39.1s<!--/v--> | <!--v:dr.c56.import.15+22+55+56.1000.warm.turbopack-->60.7s<!--/v--> / <!--v:dr.c56.import.15+22+55+56.1000.warm.emit-->25.8s<!--/v--> |

Base's warm builds on that instance read the cache as slowly as on A and B above, so compare
within the table. With one new import the stacked warm build spends <!--v:dr.c56.import.15+22+55+56.1.warm.turbopack-->27.8s<!--/v--> in `run-turbopack`
against a cold build's <!--v:dr.c56.import.15+22+55+56.1.cold.turbopack-->33.2s<!--/v-->; the rest is the whole-app analyses rerunning, on many cores. Cold builds: paired A/Bs give
`run-turbopack` ×1.005 (base → 56) and ×1.008 (stacked), same output
(`bench/turbopack-gym/ab56-cold.json`).

The task that takes those collectibles sits under one aggregation root per endpoint of the
app (one `pick_endpoint` operation per endpoint), so every collectible change is applied on each of
them, and when a task completes with many new children, each child's diff went up the graph
as a job of its own. Candidate 57 merges the diffs that one job's new followers make on an
upper into one update for that upper's uppers (`bench/turbopack-graph-drift-57.json`,
another dedicated c8gd.48xlarge, same output at every point). Warm builds on top of
15 + 22 + 55 + 56, `run-turbopack` / `turbopack-emit`:

| new imports | 15 + 22 + 55 + 56 | + 57 |
|---|---|---|
| 10 | <!--v:dr.c57.import.15+22+55+56.10.warm.turbopack-->38.5s<!--/v--> / <!--v:dr.c57.import.15+22+55+56.10.warm.emit-->8.4s<!--/v--> | <!--v:dr.c57.import.15+22+55+56+57.10.warm.turbopack-->36.1s<!--/v--> / <!--v:dr.c57.import.15+22+55+56+57.10.warm.emit-->5.5s<!--/v--> |
| 1,000 | <!--v:dr.c57.import.15+22+55+56.1000.warm.turbopack-->62.1s<!--/v--> / <!--v:dr.c57.import.15+22+55+56.1000.warm.emit-->26.9s<!--/v--> | <!--v:dr.c57.import.15+22+55+56+57.1000.warm.turbopack-->52.1s<!--/v--> / <!--v:dr.c57.import.15+22+55+56+57.1000.warm.emit-->16.9s<!--/v--> |

Cold builds: a paired A/B gives `run-turbopack` ×0.989, same output
(`bench/turbopack-gym/ab57-cold.json`).

Those per-endpoint roots come from the build's emit step, which wraps the emit operation in
`EntrypointsOperation::new` only to keep its issues and effects; the per-endpoint operations
it creates are discarded. Candidate 59 collects the issues and effects from the emit
operation directly (`bench/turbopack-graph-drift-59.json`, another dedicated c8gd.48xlarge,
same output at every point). On top of 15 + 22 + 55 + 56 + 57, `run-turbopack` /
`turbopack-emit`:

| new imports | warm | warm, + 59 | cold | cold, + 59 |
|---|---|---|---|---|
| 10 | <!--v:dr.c59.import.15+22+55+56+57.10.warm.turbopack-->36.8s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57.10.warm.emit-->5.5s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.10.warm.turbopack-->29.5s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57+59.10.warm.emit-->1.3s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57.10.cold.turbopack-->33.3s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.10.cold.turbopack-->30.2s<!--/v--> |
| 1,000 | <!--v:dr.c59.import.15+22+55+56+57.1000.warm.turbopack-->52.7s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57.1000.warm.emit-->16.5s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.1000.warm.turbopack-->34.2s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57+59.1000.warm.emit-->1.2s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57.1000.cold.turbopack-->34.6s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.1000.cold.turbopack-->29.9s<!--/v--> |

Emit no longer grows with the number of new imports, and cold builds are 2.3 to 4.6s
shorter at every point. With 1,000 new imports the warm build is now within 5s of a cold
one; the rest is recomputation before emit. Candidate 58 (the same merge as 57 for removed
children) made no difference (`bench/turbopack-graph-drift-58.json`).

**Client reference manifests repeat per-reference work in every page.** After 59, most of
a warm build's recomputation is `build_manifest`, which for every page re-reads each client
reference's module ids and chunk components although they do not depend on the page.
Candidate 61 computes them once, as turbo-tasks functions every page reads
(`bench/turbopack-graph-drift-61.json`, on top of 15 + 22 + 55 + 56 + 57 + 59, same output at
every point): warm `run-turbopack` with one new import <!--v:dr.c61.import.15+22+55+56+57+59.1.warm.turbopack-->27.1s<!--/v--> → <!--v:dr.c61.import.15+22+55+56+57+59+61.1.warm.turbopack-->22.8s<!--/v-->, with 1,000
<!--v:dr.c61.import.15+22+55+56+57+59.1000.warm.turbopack-->34.5s<!--/v--> → <!--v:dr.c61.import.15+22+55+56+57+59+61.1000.warm.turbopack-->29.1s<!--/v-->; cold builds <!--v:dr.c61.import.15+22+55+56+57+59.0.cold.turbopack-->30.4s<!--/v--> → <!--v:dr.c61.import.15+22+55+56+57+59+61.0.cold.turbopack-->25.9s<!--/v-->.

**After `run-turbopack`, one core reads 775 MB of manifests as JavaScript.** Every
Turbopack build runs Next.js's route bundle stats step, which `require()`s each app page's
client reference manifest (<!--v:rs.c60.manifests-->2,073 files, 774.6 MB<!--/v--> on the monolith) to read one field.
Candidate 60 parses the JSON value each file assigns instead, falling back to `require()`
for any other shape. Measured alone on one monolith build's output
(`bench/turbopack-gym/route-stats-60.json`, `scripts/turbopack-gym/route-stats.mjs`): <!--v:rs.c60.base.s-->7.79s<!--/v-->
→ <!--v:rs.c60.candidate.s-->2.95s<!--/v--> (×<!--v:rs.c60.ratio-->0.379<!--/v-->), resident memory at the step's end <!--v:rs.c60.base.rssMiB-->1,310 MiB<!--/v--> → <!--v:rs.c60.candidate.rssMiB-->113 MiB<!--/v-->, the same stats file as the build's.

## A Counter Every Operation Writes

In cold builds the largest on-CPU leaf in Turbopack's workers is an atomic add: 9.29% of
worker samples in a cold monolith build with base (`cache-drift-probes.json`,
`operationCounterLeaf`). It is `SnapshotCoordinator::in_progress_operations`, one counter
that every backend operation increments and decrements while the persistent cache is on, so
every worker writes the same cache line. A probe that skips the count (incorrect; a
measurement only) shows about what removing it saves: `run-turbopack` <!--v:oc.mono-p52.guard-->0.953<!--/v-->×, graph phase
<!--v:oc.mono-p52.ratio-->0.988<!--/v-->×. Candidate 52 counts operations in per-thread stripes, with the snapshot flags in a
separate word (bench/turbopack-gym/cache-drift.md); the atomic leaves the profile (0.21% of
samples). Its A/Bs are cold builds (`bench/turbopack-graph-52.json`, a dedicated 192-core
c8g.48xlarge, lanes of 24 CPUs, one A/B at a time), all same output:

- base → 52 on the monolith: `run-turbopack` <!--v:oc.mono-52.guard-->0.962<!--/v-->×, but the graph phase <!--v:oc.mono-52.ratio-->1.057<!--/v-->×, where the
  probe gives <!--v:oc.mono-p52.ratio-->0.988<!--/v-->×. What costs 52's graph phase is not known yet: no leaf in the profile
  accounts for it.
- base → 52 on vizdash: `run-turbopack` <!--v:oc.viz-52.guard-->1.016<!--/v-->×, no gain.
- 15 + 22 → 15 + 22 + 52 on the monolith: `run-turbopack` <!--v:oc.mono-15+22+52.guard-->0.922<!--/v-->× (<!--v:oc.mono-15+22+52.tpA-->32.47s<!--/v--> → <!--v:oc.mono-15+22+52.tpB-->29.77s<!--/v-->).
- Stacked on 15 + 22 + 55 + 56, in the drift sweep's single builds
  (`bench/turbopack-graph-drift-52w.json`): cold `run-turbopack` <!--v:dr.c52w.import.15+22+55+56.0.cold.turbopack-->31.6s<!--/v--> → <!--v:dr.c52w.import.15+22+52+55+56.0.cold.turbopack-->29.6s<!--/v-->
  with nothing changed and <!--v:dr.c52w.import.15+22+55+56.1000.cold.turbopack-->32.4s<!--/v--> → <!--v:dr.c52w.import.15+22+52+55+56.1000.cold.turbopack-->30.5s<!--/v--> at 1,000 new imports; warm builds no
  different outside the spread between reps.

## Open Items

- After the graph phase, `compute_chunk_group_info` and the merged-modules reconciliation run
  as sequential loops inside `turbopack-write-entrypoints`. Candidates 41 and 42
  (`bench/turbopack-gym/next-limit.md`) shorten them on the monolith with the same output
  and do not change vizdash's compile.
- 55 and 52 are not in the canonical run; 52 is not ready to propose alone (see the counter
  section).
- A warm build's wall time after `run-turbopack` varies from run to run (most builds near 12s
  or near 21s) in every access mode (bench/turbopack-gym/cache-drift.md); not explained yet.
- New imports rerun the whole-app analyses on restored task state, on many cores; after 59
  and 61 that recomputation is what is left of a warm build's extra time, and each page's
  client reference manifest whose chunk names changed is still rebuilt whole
  (bench/turbopack-gym/cache-drift.md, Open).
- After `run-turbopack`, forking Next.js's page-data workers from a process holding
  Turbopack's heap copies its page tables once per worker (bench/turbopack-gym/cache-drift.md,
  Open).
- `drift.mjs` restores an interrupted sweep's tree when the next sweep on that app starts; it
  has no restore command of its own.
- The patches are against v16.4.0. Upstream checks of 11 and 22 (next.js's Rust checks, a
  Turbopack integration subset, `next dev`), their PR drafts, and the heap tie-break in
  `traverse_edges_fixed_point_with_priority`:
  [bench/turbopack-gym/upstream-readiness.md](bench/turbopack-gym/upstream-readiness.md).

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

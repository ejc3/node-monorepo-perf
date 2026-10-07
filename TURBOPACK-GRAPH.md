# Turbopack's Whole-App Module Graph on One Large App

On one App Router app at the scale reported in
[vercel/next.js#98043](https://github.com/vercel/next.js/issues/98043) (2,070 routes,
16,071 generated files), `next build`'s module graph phase keeps about 9 of 24 cores busy
and is fastest at 16 cores: 9.59s, against 13.21s at 32 cores, 15.91s at 96 and 38.06s at
192 (both NUMA nodes). Two patches to Turbopack v16.4.0 cut the phase to **0.33×** (14.75s
→ 4.99s on a 24-core lane) and the whole Turbopack compile to **0.71×** (49.05s → 34.68s),
with the same emitted output. Sources: `bench/turbopack-graph-ab.json`,
`bench/turbopack-graph-scaling.json`.

## The App

`scripts/monolith-gen.mjs` (`make monolith`) generates one standalone App Router app; the
records were measured on its defaults (the `apps.monolith` field of the A/B record):

| | |
|---|---|
| routes | 2,070: 1,708 pages, 362 route handlers |
| section layouts | 192 |
| generated files | 16,071 |
| feature folders | 420, 29 modules each (lib, `'use client'`, and server tiers) |
| UI kit | 700 components behind one `export *` barrel, half `'use client'` |
| util layer | 500 modules behind one `export *` barrel |
| Next / React | 16.4.0 / 19.2.7 |

Import edges point to lower indices inside a tier (a DAG); server components import
another feature's entry with probability 0.25, zipf-weighted toward low feature indices.
Deterministic per `--seed` (98043).

## Method

- **One run** (`scripts/turbopack-gym/bench.mjs`): a cold
  `next build --experimental-build-mode=compile` in a `systemd-run --scope` pinned to a CPU
  set, its memory on that set's NUMA node. Phase durations come from Next's own
  `.next/trace-build` events (`turbopack-module-graph`, `turbopack-write-entrypoints`,
  `turbopack-emit`, `run-turbopack`, `turbopack-persistence`); cores per phase are the
  scope's CPU time (`cpu.stat`, sampled every 100 ms) over the phase's duration.
- **Bindings.** Every row, including `base`, runs a `next-napi-bindings` built from the
  v16.4.0 tag with `--release`, LTO off and 16 codegen units; a patched binding differs
  from `base` only by its patches. Each record's `bindings` field lists the patches in each
  binding with their hashes.
- **A/B** (`ab.mjs`): A and B build at the same time on two 24-core lanes of one NUMA node
  and swap lanes every rep; 6 reps. The ratio is the geometric mean of B/A over the reps,
  which cancels a fixed speed difference between the two lanes; `swapRatios` gives each
  swapped pair. A row is a win when the ratio is below 0.96, every swap pair is below 1,
  `run-turbopack` does not regress by more than 2%, and the output fingerprint matches.
- **Same output.** The fingerprint is the multiset of (directory, file size) over the
  emitted `server/` and `static/` files (26,875 in every row). Turbopack's output is not
  byte-reproducible across builds of the same binding: its minifier assigns some local
  names in a different order, which also changes content-hashed chunk names, and both keep
  file sizes.
- **Machine.** A dedicated c8g.48xlarge: 192 Neoverse-V2 vCPUs in two NUMA nodes, 371 GB
  (the record's `machine` fields), Node 22.23.3. Four A/B pairs ran at once, so a row's
  absolute times include load from the other builds on the box; rows are compared by
  ratio. An A/A pair of the base binding measures 0.969× (swap pairs 0.90, 0.96, 1.05).

## Results

Graph phase and `run-turbopack` medians over the 6 reps of each side; ratios are the
geometric means described above. Cores are the median cores busy during the graph phase.

| B (vs base) | graph phase | ratio | run-turbopack | ratio | cores in graph phase |
|---|---|---|---|---|---|
| A/A (base) | 13.45s → 12.94s | 0.969 | 45.82s → 45.53s | 1.001 | 9.5 → 9.5 |
| 11: topological binding usage | 15.21s → 10.18s | **0.662** | 49.29s → 44.18s | 0.898 | 9.0 → 12.6 |
| 15: 11 + merged-modules order, interned bitmaps | 12.95s → 9.36s | **0.705** | 47.91s → 40.37s | 0.839 | 9.3 → 12.9 |
| 22: sharded scheduler queue | 13.07s → 8.77s | **0.669** | 45.16s → 40.57s | 0.895 | 9.5 → 9.7 |
| 15 + 22 | 14.75s → 4.99s | **0.334** | 49.05s → 34.68s | **0.710** | 9.1 → 17.0 |
| 16 worker threads (env) | 13.77s → 10.18s | 0.767 | 47.65s → 47.67s | 1.008 | 9.2 → 7.6 |
| eviction floor 8 GiB (env) | 14.01s → 14.06s | 1.010 | 46.48s → 46.64s | 1.000 | 9.0 → 9.0 |
| no persistent build cache | 13.82s → 13.98s | 1.010 | 47.10s → 37.65s | 0.796 | 9.4 → 8.9 |

Every row's output fingerprint matches its base.

## What Bounds the Phase

Two independent limits, each hidden behind the other.

- **The scheduler's queue lock.** turbo-tasks' `PriorityRunner` keeps every scheduled task
  in one mutex-guarded queue; scheduling a task, a reader claiming one to run inline, and
  a worker taking its next task all take that lock. More workers wait longer on it:
  capping turbo-tasks at 16 worker threads on a 24-core lane shortens the phase to 0.767×
  while fewer cores are busy (9.2 → 7.6), and leaves `run-turbopack` unchanged (1.008×).
  Patch 22 splits the queue into shards (one per four workers, a shard chosen by the task's
  key; a worker compares the heads of two shards and takes the higher priority): 0.669×.
- **A whole-graph fixed point run breadth-first.** `compute_binding_usage_info` runs twice
  in the phase (base graph, full graph), on one thread. It visits modules breadth-first,
  so a module that re-exports a large barrel is processed again each time a newly visited
  importer adds a used export, and each pass copies the barrel's export set along every
  `export *` edge. Patch 11 orders the visit by each module's DFS post-order index (every
  module after all its importers); the fixed point it reaches does not depend on visit
  order: 0.662×. Patch 15 adds the same order to the merged-modules fixed point and
  replaces bitmap hashing there with interned ids, which also shortens
  `turbopack-write-entrypoints` (28.59s → 21.01s; 0.839× `run-turbopack`).
- **Together.** 15 + 22 reach 0.334×, below the product of their separate ratios (0.47):
  with the lock removed the serial fixed points bound the phase, and with them removed the
  lock does. Cores busy in the phase rise from 9.1 to 17.0.
- **Not the bound.** Raising the eviction floor to 8 GiB changes nothing (1.010×). Turning
  off the persistent build cache leaves the graph phase unchanged (1.010×) and removes its
  write: `run-turbopack` 0.796×.

## Scaling

One build per lane size, run one at a time while holding every CPU of the box; lanes
start at CPU 0, so 8 to 96 cores sit on NUMA node 0 and 192 spans both nodes. One run per
point. "Kernel" is the share of the phase's CPU time spent in the kernel
(`sysShare`).

| cores | base graph phase | cores busy | kernel | 15 + 22 graph phase | cores busy | kernel | run-turbopack, base → 15 + 22 |
|---|---|---|---|---|---|---|---|
| 8 | 12.27s | 5.1 | 3.5% | 8.26s | 7.0 | 3.8% | 59.11s → 46.30s |
| 16 | 9.59s | 7.7 | 7.4% | 5.33s | 12.8 | 5.2% | 43.36s → 35.42s |
| 32 | 13.21s | 10.7 | 34.9% | 4.13s | 22.3 | 6.8% | 44.88s → 29.90s |
| 64 | 13.99s | 11.2 | 39.9% | 4.21s | 42.4 | 4.4% | 46.73s → 31.35s |
| 96 | 15.91s | 11.2 | 42.9% | 3.95s | 59.7 | 3.7% | 49.42s → 30.82s |
| 192 | 38.06s | 9.3 | 44.9% | 5.56s | 80.9 | 15.2% | 91.81s → 45.27s |

- **Base slows down above 16 cores.** Cores busy stay at about 11 while the kernel's share
  of them rises from 3.5% to 42.9%: waits on the scheduler's queue lock turn into
  sleeps and wake-ups. Spanning two NUMA nodes takes the phase to 38.06s.
- **15 + 22 stops getting faster at 32 cores.** The phase holds at 3.95–4.21s from 32 to
  96 cores while cores busy rise from 22.3 to 59.7, with the kernel share at 3.7–6.8%: more
  cores no longer slow it, and no longer shorten it. It is 0.25× base at 96 cores and
  0.15× at 192.
- **The compile now ends on the rest of the build.** `run-turbopack` with 15 + 22 holds at
  29.90–31.35s from 32 to 96 cores, of which `turbopack-write-entrypoints` (which includes
  the graph phase) is 14.06–14.45s.

## Open Items

- After the graph phase, `compute_chunk_group_info` and the merged-modules reconciliation
  still run on one thread inside `turbopack-write-entrypoints`. Chunk-group ids are assigned
  in visit order and feed the output's ordering, so a reorder there has to keep that order.
- Persistence under load: in this record, `turbopack-persistence` took 73–101s per build
  while four A/B pairs built at once, and 7.9–9.4s in the pair that ran alone (the
  patch-22 row). The graph phase and `run-turbopack` end before persistence starts.
- The patches are against v16.4.0 and have not been proposed upstream.

## Reproduce

```bash
export GYM_ROOT=/path/to/scratch            # ~100 GB: next.js clone, cargo targets, apps
make gym-setup                              # clone v16.4.0, build base (+ frame-pointer) binding, apps
node scripts/turbopack-gym/build.mjs 15+22 --from gym/base \
  --patch bench/turbopack-gym/candidates/15-graph-algos-combined.patch \
  --patch bench/turbopack-gym/candidates/22-sharded-runner-2choice.patch
node scripts/turbopack-gym/ab.mjs --a base --b 15+22   # 6 lane-swapped reps
make gym-scaling                            # graph phase vs lane size
make gym-record                             # -> bench/turbopack-graph-{scaling,ab}.json
```

Tooling (lanes, CPU locks, other hosts, the candidate queue, profiling) is described in
AGENTS.md under "Turbopack Graph Gym".

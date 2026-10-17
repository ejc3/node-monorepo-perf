# Persistent Cache Against Changed Files

The second observation in vercel/next.js#98043: a `next build` that restores Turbopack's
persistent cache gets slower as more source files change since the cached build, until it is
slower than building cold. This note is the method, what the profiles show, and the
candidates that came out of it. Every number here was measured on dedicated 192-core boxes
(no other gym work on them):

- `bench/turbopack-graph-drift.json`: the drift sweeps, base and candidate 55, on a
  c8gd.48xlarge, one build at a time on 24 of its CPUs, the gym root on btrfs over the
  instance's local NVMe drives.
- `ab56-cold.json`: paired A/Bs of cold builds for candidate 56, on another c8gd.48xlarge.
- `ab57-cold.json`: the same for candidate 57 on 15 + 22 + 55 + 56, on another c8gd.48xlarge.
- `bench/turbopack-graph-drift-56.json`: the `import` sweep for candidate 56, base and 56
  alone and on top of 15 + 22 + 55, on another c8gd.48xlarge set up the same way, with
  Next.js's page-data workers matched to the build's CPUs (below).
- `bench/turbopack-graph-drift-52w.json` and `bench/turbopack-graph-drift-57.json`: the
  `import` sweeps for candidates 52 and 57, each against 15 + 22 + 55 + 56, 3 reps, set up as
  the drift-56 sweep, each on its own c8gd.48xlarge.
- `bench/turbopack-graph-drift-58.json` and `bench/turbopack-graph-drift-59.json`: the same
  for candidates 58 and 59, each against 15 + 22 + 55 + 56 + 57;
  `bench/turbopack-graph-drift-61.json` for 61 against 15 + 22 + 55 + 56 + 57 + 59.
- `cache-read-probes.json`: single warm builds that locate where a warm start waits (page
  cache, access mode, candidates 53 to 55, profiles), set up the same way, on four instances
  (A, B and D are c8gd.48xlarge, C an m8gd.48xlarge). The same build's time differed between
  instances (below), so compare rows only within one set. Its `coldAB` is a paired A/B (two
  builds at once on CPUs 0-23 and 24-47).
- `bench/turbopack-graph-52.json` and `cache-drift-probes.json`: the operation counter, on a
  c8g.48xlarge (no local NVMe); the A/Bs run two builds at once on two 24-CPU lanes.

TURBOPACK-GRAPH.md renders the headline numbers from the records.

## Method

`scripts/turbopack-gym/drift.mjs` on `drift-monolith`, a copy of the monolith app (the sweep
edits source, so it refuses the shared apps):

1. Per binding, build the unchanged tree cold into a fixed output directory (`.next-drift`;
   one name for every binding, since the name appears in emitted code) and keep a reflink
   copy of that directory, cache included.
2. For each N, edit N feature modules (journaled, so an interrupted sweep restores the
   tree), then per binding build **warm** (the kept directory restored), **cold** (a fresh
   directory, cache on) and **off** (cache off), in an order rotated per point; restore the
   tree and check its hash.
3. Two edits: `label` appends to one string literal per module (the emitted code changes, the
   module graph does not); `import` also adds an import of a util the module did not import,
   used by a new export (one new edge per module).
4. Checks per point: warm output = cold output per binding, equal outputs across bindings,
   an edit changes the output, the unchanged tree's warm build has no module-graph span (the
   cache was read), and no build logged the cache as disabled. A cache-off build's output
   differs from the cold one's (a changed build setting changes the output); `drift.mjs
   record` checks it is one output per binding and N across reps.
5. The snapshot and every restore are reflink copies (`cp --reflink=always`), so the restored
   cache files are new inodes with nothing in the page cache, as after a fresh checkout or a
   CI cache restore.
6. A sweep interrupted by a lost machine (a reclaimed spot instance) continues with
   `--resume` on the same instance type: finished points are kept, the snapshots are rebuilt
   and must give the first attempt's outputs, and each point's runs all come from one
   attempt. A record states how many boots its sweep took.

Every build sets `TURBO_ENGINE_IGNORE_DIRTY=1`. A binding built from a modified next.js tree
(every patched one) counts as dirty, and Turbopack keeps a dirty build's cache in a
directory it deletes on the next build (`db_versioning.rs`), so without it a patched
binding never builds warm. The cache directory is also named after the binding's embedded
`git describe`: a binding built from a commit other than `gym/base` finds no cache seeded
by base and builds cold with the same output, so candidate changes stay uncommitted on top of
`gym/base` (one probe run of 54 hit this; `cache-read-probes.json`, `invalid`).

## Results

`bench/turbopack-graph-drift.json`: base and 55, both edits, N = 0, 1, 10, 100 and 1,000,
2 reps, on a dedicated c8gd.48xlarge. Medians; wall time, then `run-turbopack`:

`label` (a string literal per module):

| N | warm, base | warm, 55 | cold, base | cold, 55 | off, base |
|---|---|---|---|---|---|
| 0 | <!--v:dr.main.label.base.0.warm.wall-->31.8s<!--/v--> / <!--v:dr.main.label.base.0.warm.turbopack-->13.2s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.0.warm.wall-->17.5s<!--/v--> / <!--v:dr.main.label.55-sst-mmap-normal-advice.0.warm.turbopack-->4.7s<!--/v--> | <!--v:dr.main.label.base.0.cold.wall-->74.3s<!--/v--> / <!--v:dr.main.label.base.0.cold.turbopack-->44.8s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.0.cold.wall-->78.5s<!--/v--> / <!--v:dr.main.label.55-sst-mmap-normal-advice.0.cold.turbopack-->44.4s<!--/v--> | <!--v:dr.main.label.base.0.off.wall-->66.9s<!--/v--> / <!--v:dr.main.label.base.0.off.turbopack-->36.0s<!--/v--> |
| 1 | <!--v:dr.main.label.base.1.warm.wall-->28.5s<!--/v--> / <!--v:dr.main.label.base.1.warm.turbopack-->11.4s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.1.warm.wall-->17.6s<!--/v--> / <!--v:dr.main.label.55-sst-mmap-normal-advice.1.warm.turbopack-->5.3s<!--/v--> | <!--v:dr.main.label.base.1.cold.wall-->74.4s<!--/v--> / <!--v:dr.main.label.base.1.cold.turbopack-->46.3s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.1.cold.wall-->82.6s<!--/v--> / <!--v:dr.main.label.55-sst-mmap-normal-advice.1.cold.turbopack-->43.6s<!--/v--> | <!--v:dr.main.label.base.1.off.wall-->66.8s<!--/v--> / <!--v:dr.main.label.base.1.off.turbopack-->36.5s<!--/v--> |
| 10 | <!--v:dr.main.label.base.10.warm.wall-->36.9s<!--/v--> / <!--v:dr.main.label.base.10.warm.turbopack-->19.7s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.10.warm.wall-->27.1s<!--/v--> / <!--v:dr.main.label.55-sst-mmap-normal-advice.10.warm.turbopack-->14.0s<!--/v--> | <!--v:dr.main.label.base.10.cold.wall-->79.1s<!--/v--> / <!--v:dr.main.label.base.10.cold.turbopack-->45.1s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.10.cold.wall-->79.6s<!--/v--> / <!--v:dr.main.label.55-sst-mmap-normal-advice.10.cold.turbopack-->46.0s<!--/v--> | <!--v:dr.main.label.base.10.off.wall-->68.7s<!--/v--> / <!--v:dr.main.label.base.10.off.turbopack-->36.0s<!--/v--> |
| 100 | <!--v:dr.main.label.base.100.warm.wall-->40.6s<!--/v--> / <!--v:dr.main.label.base.100.warm.turbopack-->23.4s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.100.warm.wall-->34.2s<!--/v--> / <!--v:dr.main.label.55-sst-mmap-normal-advice.100.warm.turbopack-->17.1s<!--/v--> | <!--v:dr.main.label.base.100.cold.wall-->79.0s<!--/v--> / <!--v:dr.main.label.base.100.cold.turbopack-->45.0s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.100.cold.wall-->74.2s<!--/v--> / <!--v:dr.main.label.55-sst-mmap-normal-advice.100.cold.turbopack-->45.0s<!--/v--> | <!--v:dr.main.label.base.100.off.wall-->67.0s<!--/v--> / <!--v:dr.main.label.base.100.off.turbopack-->36.4s<!--/v--> |
| 1,000 | <!--v:dr.main.label.base.1000.warm.wall-->46.1s<!--/v--> / <!--v:dr.main.label.base.1000.warm.turbopack-->28.4s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.1000.warm.wall-->44.4s<!--/v--> / <!--v:dr.main.label.55-sst-mmap-normal-advice.1000.warm.turbopack-->22.6s<!--/v--> | <!--v:dr.main.label.base.1000.cold.wall-->73.9s<!--/v--> / <!--v:dr.main.label.base.1000.cold.turbopack-->45.1s<!--/v--> | <!--v:dr.main.label.55-sst-mmap-normal-advice.1000.cold.wall-->75.3s<!--/v--> / <!--v:dr.main.label.55-sst-mmap-normal-advice.1000.cold.turbopack-->45.9s<!--/v--> | <!--v:dr.main.label.base.1000.off.wall-->89.0s<!--/v--> / <!--v:dr.main.label.base.1000.off.turbopack-->36.4s<!--/v--> |

`import` (a new import per module):

| N | warm, base | warm, 55 | cold, base | cold, 55 | off, base |
|---|---|---|---|---|---|
| 0 | <!--v:dr.main.import.base.0.warm.wall-->32.0s<!--/v--> / <!--v:dr.main.import.base.0.warm.turbopack-->13.3s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.0.warm.wall-->26.9s<!--/v--> / <!--v:dr.main.import.55-sst-mmap-normal-advice.0.warm.turbopack-->4.7s<!--/v--> | <!--v:dr.main.import.base.0.cold.wall-->77.1s<!--/v--> / <!--v:dr.main.import.base.0.cold.turbopack-->44.6s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.0.cold.wall-->80.1s<!--/v--> / <!--v:dr.main.import.55-sst-mmap-normal-advice.0.cold.turbopack-->45.2s<!--/v--> | <!--v:dr.main.import.base.0.off.wall-->66.4s<!--/v--> / <!--v:dr.main.import.base.0.off.turbopack-->36.9s<!--/v--> |
| 1 | <!--v:dr.main.import.base.1.warm.wall-->58.8s<!--/v--> / <!--v:dr.main.import.base.1.warm.turbopack-->39.6s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.1.warm.wall-->53.2s<!--/v--> / <!--v:dr.main.import.55-sst-mmap-normal-advice.1.warm.turbopack-->33.8s<!--/v--> | <!--v:dr.main.import.base.1.cold.wall-->78.2s<!--/v--> / <!--v:dr.main.import.base.1.cold.turbopack-->45.3s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.1.cold.wall-->79.6s<!--/v--> / <!--v:dr.main.import.55-sst-mmap-normal-advice.1.cold.turbopack-->44.2s<!--/v--> | <!--v:dr.main.import.base.1.off.wall-->68.6s<!--/v--> / <!--v:dr.main.import.base.1.off.turbopack-->35.9s<!--/v--> |
| 10 | <!--v:dr.main.import.base.10.warm.wall-->77.7s<!--/v--> / <!--v:dr.main.import.base.10.warm.turbopack-->53.8s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.10.warm.wall-->74.2s<!--/v--> / <!--v:dr.main.import.55-sst-mmap-normal-advice.10.warm.turbopack-->50.4s<!--/v--> | <!--v:dr.main.import.base.10.cold.wall-->74.2s<!--/v--> / <!--v:dr.main.import.base.10.cold.turbopack-->45.2s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.10.cold.wall-->74.6s<!--/v--> / <!--v:dr.main.import.55-sst-mmap-normal-advice.10.cold.turbopack-->45.0s<!--/v--> | <!--v:dr.main.import.base.10.off.wall-->65.9s<!--/v--> / <!--v:dr.main.import.base.10.off.turbopack-->35.5s<!--/v--> |
| 100 | <!--v:dr.main.import.base.100.warm.wall-->82.6s<!--/v--> / <!--v:dr.main.import.base.100.warm.turbopack-->58.4s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.100.warm.wall-->78.0s<!--/v--> / <!--v:dr.main.import.55-sst-mmap-normal-advice.100.warm.turbopack-->54.0s<!--/v--> | <!--v:dr.main.import.base.100.cold.wall-->81.1s<!--/v--> / <!--v:dr.main.import.base.100.cold.turbopack-->46.0s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.100.cold.wall-->76.9s<!--/v--> / <!--v:dr.main.import.55-sst-mmap-normal-advice.100.cold.turbopack-->45.4s<!--/v--> | <!--v:dr.main.import.base.100.off.wall-->67.3s<!--/v--> / <!--v:dr.main.import.base.100.off.turbopack-->36.5s<!--/v--> |
| 1,000 | <!--v:dr.main.import.base.1000.warm.wall-->112.2s<!--/v--> / <!--v:dr.main.import.base.1000.warm.turbopack-->87.0s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.1000.warm.wall-->106.3s<!--/v--> / <!--v:dr.main.import.55-sst-mmap-normal-advice.1000.warm.turbopack-->80.9s<!--/v--> | <!--v:dr.main.import.base.1000.cold.wall-->72.5s<!--/v--> / <!--v:dr.main.import.base.1000.cold.turbopack-->43.4s<!--/v--> | <!--v:dr.main.import.55-sst-mmap-normal-advice.1000.cold.wall-->80.2s<!--/v--> / <!--v:dr.main.import.55-sst-mmap-normal-advice.1000.cold.turbopack-->46.3s<!--/v--> | <!--v:dr.main.import.base.1000.off.wall-->68.7s<!--/v--> / <!--v:dr.main.import.base.1000.off.turbopack-->37.5s<!--/v--> |

- With string edits, a warm build stays well under a cold one up to 1,000 changed modules,
  and 55 takes its `run-turbopack` from <!--v:dr.main.label.base.0.warm.turbopack-->13.2s<!--/v--> to <!--v:dr.main.label.55-sst-mmap-normal-advice.0.warm.turbopack-->4.7s<!--/v--> with nothing changed and from
  <!--v:dr.main.label.base.1000.warm.turbopack-->28.4s<!--/v--> to <!--v:dr.main.label.55-sst-mmap-normal-advice.1000.warm.turbopack-->22.6s<!--/v--> at 1,000.
- One new import costs a warm build about 26s of `run-turbopack` (<!--v:dr.main.import.base.0.warm.turbopack-->13.3s<!--/v--> → <!--v:dr.main.import.base.1.warm.turbopack-->39.6s<!--/v--> for
  base); from 10 on, base's warm build is slower than a cold one (<!--v:dr.main.import.base.10.warm.wall-->77.7s<!--/v--> against
  <!--v:dr.main.import.base.10.cold.wall-->74.2s<!--/v-->). 55 shortens the warm build by less here than with nothing changed (<!--v:dr.main.import.55-sst-mmap-normal-advice.10.warm.wall-->74.2s<!--/v--> at 10, 3.5s less than base; its warm build passes its
  cold one from 100 on) and does not change the rest: the time is the whole-app analyses
  rerunning on restored task state.
- A cache-off build's `run-turbopack` is shorter than a cold one's at every N (the cold build
  writes the cache; the operation counter below). One cache-off build in the `label` sweep at
  N = 1,000 ran 107.5s, 71s of it after `run-turbopack`, against its other rep's 70.4s and 33s;
  the 37s difference is all after `run-turbopack` and not explained. The median is the mean of the two.


## A warm start reads its cache one page at a time

Profiles and probes: `cache-read-probes.json`. Each probe restores the snapshot as the sweep
does, so the cache is on disk and not in the page cache, then builds the unchanged tree
(N = 0) or the tree with one changed string (N = 1).

- **Most of a warm build waits on reads.** On instance A, the unchanged tree's warm build
  with `base-fp` (base built with frame pointers, for the profiles)
  spends <!--v:cr.pageCache.base-fp.cold.0.turbopack-->38.7s<!--/v--> in `run-turbopack`; with every cache file read first (the page cache
  holding it) the same build takes <!--v:cr.pageCache.base-fp.hot.0.turbopack-->4.4s<!--/v-->, same output (N = 1: <!--v:cr.pageCache.base-fp.cold.1.turbopack-->27.0s<!--/v--> and <!--v:cr.pageCache.base-fp.hot.1.turbopack-->5.0s<!--/v-->).
  For most of the cold one, one thread at a time is blocked on the disk, which reads about
  16 MiB/s, and the build is at 0.1 of a busy core; the build reads 0.9 GiB from disk in
  all, about the size of the cache.
- **Where it faults.** The major faults are in `turbo_persistence`'s block reads during
  lookups (`StaticSortedFile::lookup` → `get_or_read_block`, faulting in
  `get_raw_block_slice` and in the CRC check that walks the block), under the backend's
  `batch_lookup_data` as aggregation updates restore tasks.
- **Why one page at a time.** SST files are mmapped with `MADV_RANDOM`, which turns the
  kernel's read-ahead off, so each 4 KiB page of a block that is not cached is its own read.
  turbo-persistence sizes key blocks at about 16 KiB and value blocks at about 132 KiB on
  average (`KEY_BLOCK_AVG_SIZE`, `VALUE_BLOCK_AVG_SIZE` in its `constants.rs`), and the
  lookups depend on each other, so those reads queue one behind another.
- **The same reads through `pread`.** `TURBO_PERSISTENCE_MMAP=0` (file mode, already in
  v16.4.0) reads each block with one `pread`. On instance B: <!--v:cr.accessMode.base.mmap.0.turbopack-->38.6s<!--/v--> with mmap, <!--v:cr.accessMode.base.pread.0.turbopack-->8.8s<!--/v--> with
  `pread` (N = 1: <!--v:cr.accessMode.base.mmap.1.turbopack-->27.1s<!--/v--> and <!--v:cr.accessMode.base.pread.1.turbopack-->8.8s<!--/v-->), same output.
- **The instances differed.** The no-change warm build took <!--v:cr.pageCache.base-fp.cold.0.turbopack-->38.7s<!--/v-->
  and <!--v:cr.accessMode.base.mmap.0.turbopack-->38.6s<!--/v--> on instances A (`base-fp`) and B (base), <!--v:cr.candidatesC.base.mmap.0.turbopack-->13.0s<!--/v--> and <!--v:cr.candidatesD.base.mmap.0.turbopack-->13.1s<!--/v--> on C and D, while `pread` took
  <!--v:cr.accessMode.base.pread.0.turbopack-->8.8s<!--/v-->, <!--v:cr.candidatesC.base.pread.0.turbopack-->6.7s<!--/v--> and <!--v:cr.candidatesD.base.pread.0.turbopack-->6.9s<!--/v--> on B, C and D. A, B and D are the same instance type. Single-read latency was not
  measured; the instances differ most in the builds that read one page at a time.

## Candidates for the reads

- **53 `sst-block-willneed`**: before a block's first read in the process (its bit in the
  existing `verified_blocks` bitmap unset), `madvise(WILLNEED)` the block's byte range, so a
  block arrives as one read instead of one per page. Instance B: <!--v:cr.accessMode.53-sst-block-willneed.mmap.0.turbopack-->17.6s<!--/v--> against base's
  38.6s (N = 1: <!--v:cr.accessMode.53-sst-block-willneed.mmap.1.turbopack-->13.7s<!--/v--> against 27.1s); instance C: <!--v:cr.candidatesC.53-sst-block-willneed.mmap.0.turbopack-->11.4s<!--/v--> against <!--v:cr.candidatesC.base.mmap.0.turbopack-->13.0s<!--/v-->.
  `pread` is still faster on both.
- **54 `sst-meta-willneed`**: 53 plus `madvise(WILLNEED)` over each whole meta file at open
  (the filters every lookup probes). Instance C: <!--v:cr.candidatesC.54-sst-meta-willneed.mmap.0.turbopack-->11.4s<!--/v-->, the same
  as 53.
- **55 `sst-mmap-normal-advice`**: drop the `MADV_RANDOM` advice on the SST mapping (keep
  `Sequential` on the block-offset table). A fault then gets the kernel's default read-ahead,
  as a `pread` of the same file does. One line.

Profiles of the no-change warm build on instance C show why 53 is not enough: in
`run-turbopack`, workers spent 10.7s (summed over threads) blocked in `filemap_fault` with
53; with `pread` they spent 2.7s blocked in all, 0.9s of it waiting for reads in
`filemap_get_pages` and the rest on btrfs and path-lookup locks. A warm start reads most of every SST, and
read-ahead fetches the following blocks in the same request; 53 asks only for the block it
is about to read.

Results for 55, same output in every case:

| `run-turbopack`, warm build, cache not in the page cache | base | 55 | base, `pread` |
|---|---|---|---|
| instance C, no change | <!--v:cr.candidatesC.base.mmap.0.turbopack-->13.0s<!--/v--> | <!--v:cr.candidatesC.55-sst-mmap-normal-advice.mmap.0.turbopack-->4.6s<!--/v--> | <!--v:cr.candidatesC.base.pread.0.turbopack-->6.7s<!--/v--> |
| instance C, 1 string changed | <!--v:cr.candidatesC.base.mmap.1.turbopack-->11.0s<!--/v--> | <!--v:cr.candidatesC.55-sst-mmap-normal-advice.mmap.1.turbopack-->5.1s<!--/v--> | <!--v:cr.candidatesC.base.pread.1.turbopack-->7.0s<!--/v--> |
| instance D, no change | <!--v:cr.candidatesD.base.mmap.0.turbopack-->13.1s<!--/v--> | <!--v:cr.candidatesD.55-sst-mmap-normal-advice.mmap.0.turbopack-->4.7s<!--/v--> | <!--v:cr.candidatesD.base.pread.0.turbopack-->6.9s<!--/v--> |
| instance D, 1 string changed | <!--v:cr.candidatesD.base.mmap.1.turbopack-->11.3s<!--/v--> | <!--v:cr.candidatesD.55-sst-mmap-normal-advice.mmap.1.turbopack-->5.3s<!--/v--> | <!--v:cr.candidatesD.base.pread.1.turbopack-->7.2s<!--/v--> |

- With the cache already in the page cache, 55 changes nothing (instance C, no change: <!--v:cr.candidatesC.55-sst-mmap-normal-advice.hot.0.turbopack-->4.2s<!--/v-->
  against base's <!--v:cr.candidatesC.base.hot.0.turbopack-->4.3s<!--/v-->).
- Cold builds do not read the cache: a paired A/B of cold builds on instance D (6 reps) gives
  `run-turbopack` ×1.004, same output (`coldAB`).
- History: #84379 added a `Sequential` hint per compressed block on top of the file's
  `Random` advice; #91263 removed it because each per-range `madvise` split the mapping's
  VMA until large builds hit `vm.max_map_count`, and called the file-level `MADV_RANDOM`
  "sufficient on its own". 55 removes an advice call and splits nothing. 53's per-block
  `WILLNEED` does not change the VMA's flags, so it does not split it either.
- Candidate 51 (`sst-willneed`, `madvise(WILLNEED)` over the whole SST at open) came before
  these; its only measurements were on a shared box and were discarded. 53 and 55 replace it.

## A shared counter on every operation

Profiles of cold builds (`perf` cpu-clock at 499 Hz without call graphs, on the build's
CPUs) show the largest on-CPU leaf in the Turbopack workers as `__aarch64_ldadd8_acq_rel`:
9.29% of tokio-worker samples in a cold monolith build with base
(`cache-drift-probes.json`, `operationCounterLeaf`). Frame-pointer unwinding on arm64 drops
the direct caller of a leaf atomic, so it was found in the disassembly: the decrement of
`SnapshotCoordinator::in_progress_operations` when an `OperationGuard` drops (one
`fetch_add` and one `fetch_sub` on one `AtomicUsize` for every backend operation, only while
the persistent cache is on).

About what it costs the build, measured with a probe binding that skips the accounting
(wrong whenever a snapshot runs during an operation, so a measurement only): graph phase
<!--v:oc.mono-p52.ratio-->0.988<!--/v-->×, `run-turbopack` <!--v:oc.mono-p52.guard-->0.953<!--/v-->×, same output (`bench/turbopack-graph-52.json`). That is
less than the sample share suggests; one guess, not measured, is that a worker waiting for
that cache line is mostly not on the build's critical path. With the probe or candidate 52,
the atomic leaves the profile (0.03% and 0.21%). → candidate 52 is the correct version of
the probe.

- **52 `striped-op-count`**: the coordinator counts active operations in cache-line-padded
  per-thread stripes; the snapshot flags move to their own read-mostly word. A phase closes
  admission by setting the running bit and then summing the stripes, both `SeqCst`, against
  each operation's increment-then-load; if it counted an operation it clears the bit again,
  so admission stays open while it waits, as before. A guard decrements the stripe it
  incremented. Only a decrement that empties its stripe, while a phase waits, and after
  which the stripes sum to zero takes the state mutex to notify, so operation ends do not
  queue on that mutex while a phase waits for others. With no phase waiting an operation
  touches only its own stripe and reads the flags word. The cost is while a phase waits: in
  a microbenchmark of empty operations on 24 threads, 19 M operations/s against 49.5 M for
  the original (1,321 M against 49.5 M with no phase waiting; `cache-drift-probes.json`,
  `operationCounterMicrobench`). `try_begin_snapshot` refuses while any flag is set, as the
  original's contract says. The coordinator's 13 unit tests pass with the count read
  through a helper; three new ones cover operation ends that must not notify while others
  are active, `try_begin_snapshot` during a waiting phase, and guards dropped on other
  threads.
- **Results** (`bench/turbopack-graph-52.json`, cold builds): on the monolith
  `run-turbopack` <!--v:oc.mono-52.guard-->0.962<!--/v-->× but the graph phase <!--v:oc.mono-52.ratio-->1.057<!--/v-->× (the probe: <!--v:oc.mono-p52.ratio-->0.988<!--/v-->×); on vizdash
  `run-turbopack` <!--v:oc.viz-52.guard-->1.016<!--/v-->×; stacked on 15 + 22, `run-turbopack` <!--v:oc.mono-15+22+52.guard-->0.922<!--/v-->× (a WIN with `--metric
  turbopack`). Same output in all. The first version of 52 and this one measured the same in
  a direct A/B (a diagnostic run, not in the record). The cause of the slower graph phase is
  open: the profile shows no leaf for it, and no samples in glibc's TLS-descriptor paths
  (`stripe()` reads a thread-local).
- **Warm and cold, stacked** (`bench/turbopack-graph-drift-52w.json`: 15 + 22 + 55 + 56
  against the same with 52, `import` edits, single builds, 3 reps). Cold builds' `run-turbopack`
  is shorter with 52 at every N: <!--v:dr.c52w.import.15+22+55+56.0.cold.turbopack-->31.6s<!--/v--> → <!--v:dr.c52w.import.15+22+52+55+56.0.cold.turbopack-->29.6s<!--/v--> with nothing changed, <!--v:dr.c52w.import.15+22+55+56.1.cold.turbopack-->34.4s<!--/v--> → <!--v:dr.c52w.import.15+22+52+55+56.1.cold.turbopack-->29.7s<!--/v--> at 1 new import,
  <!--v:dr.c52w.import.15+22+55+56.10.cold.turbopack-->32.9s<!--/v--> → <!--v:dr.c52w.import.15+22+52+55+56.10.cold.turbopack-->30.0s<!--/v--> at 10 and <!--v:dr.c52w.import.15+22+55+56.1000.cold.turbopack-->32.4s<!--/v--> → <!--v:dr.c52w.import.15+22+52+55+56.1000.cold.turbopack-->30.5s<!--/v--> at 1,000; at 0, 1 and 10 the three builds of each do not
  overlap. Warm builds show no difference outside the spread between reps: <!--v:dr.c52w.import.15+22+55+56.1.warm.turbopack-->28.6s<!--/v--> → <!--v:dr.c52w.import.15+22+52+55+56.1.warm.turbopack-->27.6s<!--/v--> at 1,
  <!--v:dr.c52w.import.15+22+55+56.10.warm.turbopack-->37.8s<!--/v--> → <!--v:dr.c52w.import.15+22+52+55+56.10.warm.turbopack-->38.9s<!--/v--> at 10, <!--v:dr.c52w.import.15+22+55+56.1000.warm.turbopack-->60.8s<!--/v--> → <!--v:dr.c52w.import.15+22+52+55+56.1000.warm.turbopack-->59.0s<!--/v--> at 1,000. A whole-build profile of a warm build with one new
  import (on a dedicated box, not in a record) has this counter's atomic as its largest leaf;
  that does not show in the warm build's time. Same output in all.

## New imports: the collectibles update in emit

With new imports, most of a warm build's `turbopack-emit` runs on one core: in
`bench/turbopack-graph-drift-56.json` (below), base at 1,000 new imports spends <!--v:dr.c56.import.base.1000.warm.emit-->39.0s<!--/v--> in it (a cold build:
<!--v:dr.c56.import.base.1000.cold.emit-->16.0s<!--/v-->, on about 19 cores). Whole-build profiles on a dedicated box (`perf`
with frame pointers; the perf data went with the instance) put that one-core time in the
backend's aggregation update queue, applying `AggregatedDataUpdate` jobs that carry
collectible changes up the aggregation graph, queued by `UpdateCollectibleOperation` and by
`cleanup_old_edges`. When a task takes the collectibles that an operation's subgraph emitted
(`drop_collectibles` / `take_collectibles`), it records a negative count for each of them on
itself, so they stop propagating above it (`unemit_collectibles`); the manager calls the
backend once per collectible, and each call is its own operation that walks the graph above
the task.

- **56 `batch-unemit-collectibles`**: `unemit_collectibles` records those negative counts as
  one `UpdateCollectibleOperation` (a new `Backend::unemit_collectibles`, whose default is
  the old per-collectible loop). Each change is applied to the task as before; dependents of
  a collectible type are invalidated once per type, as `cleanup_old_edges` does; the task's
  uppers get one aggregated data update for the batch, so the graph above the task is walked
  once instead of once per collectible. `turbo-tasks-backend`'s tests pass.

`bench/turbopack-graph-drift-56.json` (`import` edits, 2 reps). Warm builds, `run-turbopack` /
`turbopack-emit`; the last column is a cold build's `run-turbopack`:

| new imports | base | 56 | 15 + 22 + 55 | 15 + 22 + 55 + 56 | cold, 15 + 22 + 55 |
|---|---|---|---|---|---|
| 1 | <!--v:dr.c56.import.base.1.warm.turbopack-->61.1s<!--/v--> / <!--v:dr.c56.import.base.1.warm.emit-->3.2s<!--/v--> | <!--v:dr.c56.import.56-batch-unemit-collectibles.1.warm.turbopack-->60.6s<!--/v--> / <!--v:dr.c56.import.56-batch-unemit-collectibles.1.warm.emit-->2.8s<!--/v--> | <!--v:dr.c56.import.15+22+55.1.warm.turbopack-->29.7s<!--/v--> / <!--v:dr.c56.import.15+22+55.1.warm.emit-->2.1s<!--/v--> | <!--v:dr.c56.import.15+22+55+56.1.warm.turbopack-->27.8s<!--/v--> / <!--v:dr.c56.import.15+22+55+56.1.warm.emit-->1.7s<!--/v--> | <!--v:dr.c56.import.15+22+55.1.cold.turbopack-->33.2s<!--/v--> |
| 10 | <!--v:dr.c56.import.base.10.warm.turbopack-->74.8s<!--/v--> / <!--v:dr.c56.import.base.10.warm.emit-->12.2s<!--/v--> | <!--v:dr.c56.import.56-batch-unemit-collectibles.10.warm.turbopack-->72.2s<!--/v--> / <!--v:dr.c56.import.56-batch-unemit-collectibles.10.warm.emit-->9.4s<!--/v--> | <!--v:dr.c56.import.15+22+55.10.warm.turbopack-->42.0s<!--/v--> / <!--v:dr.c56.import.15+22+55.10.warm.emit-->11.5s<!--/v--> | <!--v:dr.c56.import.15+22+55+56.10.warm.turbopack-->38.7s<!--/v--> / <!--v:dr.c56.import.15+22+55+56.10.warm.emit-->8.5s<!--/v--> | <!--v:dr.c56.import.15+22+55.10.cold.turbopack-->33.7s<!--/v--> |
| 1,000 | <!--v:dr.c56.import.base.1000.warm.turbopack-->99.7s<!--/v--> / <!--v:dr.c56.import.base.1000.warm.emit-->39.0s<!--/v--> | <!--v:dr.c56.import.56-batch-unemit-collectibles.1000.warm.turbopack-->87.1s<!--/v--> / <!--v:dr.c56.import.56-batch-unemit-collectibles.1000.warm.emit-->26.9s<!--/v--> | <!--v:dr.c56.import.15+22+55.1000.warm.turbopack-->74.5s<!--/v--> / <!--v:dr.c56.import.15+22+55.1000.warm.emit-->39.1s<!--/v--> | <!--v:dr.c56.import.15+22+55+56.1000.warm.turbopack-->60.7s<!--/v--> / <!--v:dr.c56.import.15+22+55+56.1000.warm.emit-->25.8s<!--/v--> | <!--v:dr.c56.import.15+22+55.1000.cold.turbopack-->32.2s<!--/v--> |

- Same output for every binding at every point (the sweep's checks).
- At 1,000 new imports 56 shortens emit by 12 to 13s, alone and stacked, and the seconds
  of `run-turbopack` under 1.5 busy cores go from <!--v:dr.c56.import.base.1000.warm.lowCoreS-->44.5s<!--/v--> to <!--v:dr.c56.import.56-batch-unemit-collectibles.1000.warm.lowCoreS-->32.0s<!--/v--> (base → 56) and from
  <!--v:dr.c56.import.15+22+55.1000.warm.lowCoreS-->27.5s<!--/v--> to <!--v:dr.c56.import.15+22+55+56.1000.warm.lowCoreS-->16.5s<!--/v--> (stacked). At 10, about 3s of emit. With one new import emit is short to start with.
- With 15 + 22 + 55 + 56, a warm build with one new import spends <!--v:dr.c56.import.15+22+55+56.1.warm.turbopack-->27.8s<!--/v--> in `run-turbopack`
  against a cold build's <!--v:dr.c56.import.15+22+55+56.1.cold.turbopack-->33.2s<!--/v-->; from 10 it is slower than cold, as without 56 (wall
  <!--v:dr.c56.import.15+22+55+56.10.warm.wall-->54.0s<!--/v--> against <!--v:dr.c56.import.15+22+55+56.10.cold.wall-->52.1s<!--/v-->). What is left of the warm build with one new import is mostly parallel:
  the recomputation outside emit (`run-turbopack` as a whole averages about 13 busy cores).
- On this instance base's unchanged-tree warm build spent <!--v:dr.c56.import.base.0.warm.turbopack-->38.6s<!--/v--> in `run-turbopack`, as on
  instances A and B of `cache-read-probes.json` (15 + 22 + 55: <!--v:dr.c56.import.15+22+55.0.warm.turbopack-->5.1s<!--/v-->), so its base numbers
  are not comparable to the sweeps above; compare within this record.
- Cold builds here are single builds per rep, not A/Bs. Their medians lean slower with 56:
  56's cold `run-turbopack` is 0.0 to 1.9s longer than base's at every N, and 15 + 22 + 55 +
  56's is 0.9s shorter to 2.6s longer than 15 + 22 + 55's. Paired A/Bs of cold builds
  (`ab56-cold.json`: 6 reps on two 24-CPU lanes, same instance type) put it in the noise:
  `run-turbopack` ×1.005 for base → 56 (swap pairs 0.985, 1.014, 1.016) and ×1.008 for
  15 + 22 + 55 → 15 + 22 + 55 + 56 (0.990, 1.009, 1.026), same output.

**Page-data workers.** Next.js sizes its page-data worker pool from `os.cpus()`, every CPU of
the machine rather than the build's CPU set, so on these boxes a build pinned to 24 CPUs
forks 191 workers from the process holding Turbopack's heap. `drift.mjs` and `bench.mjs`
take `--page-workers match`, which sets `CIRCLE_NODE_TOTAL` (which Next.js reads first) to
the build's CPU count. The count is part of the config that the output embeds, so the output
fingerprint differs between settings; the drift-56 record states `pageWorkers: "match"`, and
`drift.mjs record` refuses sweeps with different settings. With it, 15 + 22 + 55's
unchanged-tree warm build takes <!--v:dr.c56.import.15+22+55.0.warm.wall-->16.3s<!--/v--> wall, <!--v:dr.c56.import.15+22+55.0.warm.turbopack-->5.1s<!--/v--> of it in `run-turbopack`.

**Upstream form.** As measured, 56 fails `rustfmt --check` in four places and had no
targeted test. `upstream/56-batch-unemit-collectibles.patch` is the measured code formatted
with the project's nightly rustfmt, with the `Backend::unemit_collectibles` doc comment
corrected (the task records the removal; it need not have emitted the collectibles) and a
new test, `turbo-tasks-backend/tests/take_many_collectibles.rs`. In it a task takes the
collectibles of a child that emits n of them, one twice, for n = 5, 8, 3, 0, 6, 6, 1, 9; the
taker must see exactly the current n and a task above it none. The test fails when the
batch's update to the uppers carries only its first change (4 of 5 collectibles visible
above the taker). Apart from whitespace, one trailing comma and that comment, the code is
the measured code; the bindings and records stay tied to
`candidates/56-batch-unemit-collectibles.patch`. Clippy (`-p turbo-tasks -p
turbo-tasks-backend --tests -D warnings`) is clean and `cargo test -p turbo-tasks-backend`
passes 276 of 276.

## New imports: one update per upper for a task's new children

After 56, a warm build with 1,000 new imports still spends <!--v:dr.c57.import.15+22+55+56.1000.warm.emit-->26.9s<!--/v--> in emit
(`bench/turbopack-graph-drift-57.json`). Counters added to the backend in a diagnostic
build (one warm build with 10 new imports on a dedicated box; its counts are not kept, so
they are not quoted here) show where it goes:

- `emit_assets` completes with thousands of new children. Connecting them queues millions of
  `AggregatedDataUpdate` jobs carrying collectible changes, and removing its old children
  (`cleanup_old_edges`) queues more.
- The task that takes the build's collectibles (`entrypoints_without_collectibles_operation`)
  has an aggregating ancestor per endpoint of the app: the `pick_endpoint` tasks, plus the
  `EntrypointsOperation` and the emit operation above them. `pick_endpoint`
  (`crates/next-api/src/operation.rs`) is a `root` operation, one per endpoint, and each
  reads the whole `Entrypoints` operation strongly consistently, so each is an aggregation
  root over all of it: a collectible change below it is applied once per endpoint.
- In the aggregation update queue, when one job gives an upper new followers, the diff that
  each follower's data makes on the upper is pushed to the upper's own uppers as a job of
  its own, so a task that completes with k new children has the graph above walked k times.

- **57 `merge-new-follower-data`**: the diffs that one job's new followers make on an upper
  are merged into one `AggregatedDataUpdate` (collectible changes appended, dirty-container
  counts of the same container summed; a dirty-container update for another container stays
  a separate update) and pushed to that upper's uppers once. Applied to a task, the merged
  update has the same effect as the diffs one after another. The collectible changes
  applied on each upper are the same; the number of jobs and walks above it is what drops.

`bench/turbopack-graph-drift-57.json` (`import` edits, 3 reps). Warm builds,
`run-turbopack` / `turbopack-emit`, then cold builds' `run-turbopack`:

| new imports | 15 + 22 + 55 + 56 | 15 + 22 + 55 + 56 + 57 | cold, 15 + 22 + 55 + 56 | cold, + 57 |
|---|---|---|---|---|
| 1 | <!--v:dr.c57.import.15+22+55+56.1.warm.turbopack-->29.3s<!--/v--> / <!--v:dr.c57.import.15+22+55+56.1.warm.emit-->1.8s<!--/v--> | <!--v:dr.c57.import.15+22+55+56+57.1.warm.turbopack-->28.8s<!--/v--> / <!--v:dr.c57.import.15+22+55+56+57.1.warm.emit-->1.8s<!--/v--> | <!--v:dr.c57.import.15+22+55+56.1.cold.turbopack-->32.4s<!--/v--> | <!--v:dr.c57.import.15+22+55+56+57.1.cold.turbopack-->32.4s<!--/v--> |
| 10 | <!--v:dr.c57.import.15+22+55+56.10.warm.turbopack-->38.5s<!--/v--> / <!--v:dr.c57.import.15+22+55+56.10.warm.emit-->8.4s<!--/v--> | <!--v:dr.c57.import.15+22+55+56+57.10.warm.turbopack-->36.1s<!--/v--> / <!--v:dr.c57.import.15+22+55+56+57.10.warm.emit-->5.5s<!--/v--> | <!--v:dr.c57.import.15+22+55+56.10.cold.turbopack-->32.5s<!--/v--> | <!--v:dr.c57.import.15+22+55+56+57.10.cold.turbopack-->34.2s<!--/v--> |
| 1,000 | <!--v:dr.c57.import.15+22+55+56.1000.warm.turbopack-->62.1s<!--/v--> / <!--v:dr.c57.import.15+22+55+56.1000.warm.emit-->26.9s<!--/v--> | <!--v:dr.c57.import.15+22+55+56+57.1000.warm.turbopack-->52.1s<!--/v--> / <!--v:dr.c57.import.15+22+55+56+57.1000.warm.emit-->16.9s<!--/v--> | <!--v:dr.c57.import.15+22+55+56.1000.cold.turbopack-->33.4s<!--/v--> | <!--v:dr.c57.import.15+22+55+56+57.1000.cold.turbopack-->32.4s<!--/v--> |

- Same output for both bindings at every point.
- At 1,000 new imports 57 shortens emit by 10s and `run-turbopack` by as much; the three
  warm builds of each do not overlap (`run-turbopack` 61.6 to 64.1s against 50.9 to 54.7s).
  At 10, emit is 2.9s shorter (`run-turbopack` 37.7 to 39.0s against 34.2 to 37.5s). With
  one new import and with nothing changed, no difference outside the spread between reps.
- Cold builds here are single builds per rep. Their medians differ by -1.0 to +1.7s, the
  +1.7s at 10 new imports with the reps barely overlapping (31.8 to 32.7s against 32.6 to
  34.4s). A paired A/B of cold builds (`ab57-cold.json`: 6 reps on two 24-CPU lanes, same
  instance type) puts it in the noise: `run-turbopack` ×0.989 for 15 + 22 + 55 + 56 → + 57
  (swap pairs 0.976, 0.977, 1.014), same output.
- `cargo test -p turbo-tasks-backend` passes 275 of 275 and clippy (`--tests -D warnings`)
  is clean. `upstream/57-merge-new-follower-data.patch` is the measured code (it passes the
  project's nightly `rustfmt --check` as measured) plus a new test,
  `turbo-tasks-backend/tests/many_new_children_collectibles.rs`: a task calls n children
  that each emit one collectible, the set of children changing between steps (offsets and
  counts (0, 50), (50, 200), (100, 200), (0, 7), (1000, 300), (0, 0), (5, 64)), and a task
  two levels above must see exactly the current children's collectibles. It fails when the
  merge keeps only the first diff.

## Removed children: one update per upper (no gain)

- **58 `merge-lost-follower-data`** (on top of 57): when one job takes several followers
  away from an upper (a task dropping many old children), the data of every follower that
  loses its last edge to the upper is removed from the upper under one lock, and what that
  changes goes to the upper's uppers as one merged update, instead of one lock and one
  update per follower. 57's merge moves into a helper both paths use.
  `upstream/58-merge-lost-follower-data.patch` carries 57's test, whose steps already drop
  children; with 58 it also fails when only the first removed follower's data is applied
  (49 collectibles of removed children stay visible). `cargo test -p
  turbo-tasks-backend` passes 276 of 276; clippy is clean.
- `bench/turbopack-graph-drift-58.json` (15 + 22 + 55 + 56 + 57 against 15 + 22 + 55 + 56 +
  58, `import` edits, 3 reps, same output at every point): no difference outside the spread
  between reps. Warm emit at 1,000 new imports <!--v:dr.c58.import.15+22+55+56+57.1000.warm.emit-->16.7s<!--/v--> against <!--v:dr.c58.import.15+22+55+56+58.1000.warm.emit-->16.8s<!--/v-->, `run-turbopack`
  <!--v:dr.c58.import.15+22+55+56+57.1000.warm.turbopack-->52.6s<!--/v--> against <!--v:dr.c58.import.15+22+55+56+58.1000.warm.turbopack-->52.2s<!--/v-->; at 10, emit <!--v:dr.c58.import.15+22+55+56+57.10.warm.emit-->5.6s<!--/v--> against <!--v:dr.c58.import.15+22+55+56+58.10.warm.emit-->5.7s<!--/v-->. The removed children's updates are
  not where the rest of emit's time goes; the fan-out below is.

## The endpoint roots over emit

The per-endpoint `pick_endpoint` roots above the collectibles' taker (above) come from the emit
step of `next build`. `emit_all_output_assets_once_with_issues_operation`
(`crates/next-napi-bindings/src/next_api/project.rs`) wraps the emit operation in
`EntrypointsOperation::new`, which creates one root `pick_endpoint` operation per endpoint,
each reading the whole (collectible-free) emit operation strongly consistently, and so each
an aggregation root over all of it. The step keeps only the issues and effects
(`let (_, issues, effects) = ...`): the `EntrypointsOperation` value is discarded. Every
task below them that completes with new children queues one update job per root.

- **59 `emit-without-endpoint-ops`**: the emit step collects issues and effects from the emit
  operation itself, without the wrapper. The issues and effects are the same: the wrapper's
  collectibles were the emit operation's, which it connects directly, while the
  collectible-free copy under the `pick_endpoint` roots adds none. The write phase's
  `EntrypointsOperation`, whose value goes to JavaScript, is unchanged.

`bench/turbopack-graph-drift-59.json` (15 + 22 + 55 + 56 + 57 against the same with 59,
`import` edits, 3 reps, same output at every point). `run-turbopack` / `turbopack-emit`:

| new imports | warm, 15 + 22 + 55 + 56 + 57 | warm, + 59 | cold, 15 + 22 + 55 + 56 + 57 | cold, + 59 |
|---|---|---|---|---|
| 0 | <!--v:dr.c59.import.15+22+55+56+57.0.warm.turbopack-->5.1s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57.0.warm.emit-->1.3s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.0.warm.turbopack-->5.2s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57+59.0.warm.emit-->1.4s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57.0.cold.turbopack-->33.7s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57.0.cold.emit-->16.8s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.0.cold.turbopack-->31.4s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57+59.0.cold.emit-->14.5s<!--/v--> |
| 1 | <!--v:dr.c59.import.15+22+55+56+57.1.warm.turbopack-->29.0s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57.1.warm.emit-->1.8s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.1.warm.turbopack-->30.2s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57+59.1.warm.emit-->1.4s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57.1.cold.turbopack-->33.0s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57.1.cold.emit-->15.7s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.1.cold.turbopack-->29.0s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57+59.1.cold.emit-->12.7s<!--/v--> |
| 10 | <!--v:dr.c59.import.15+22+55+56+57.10.warm.turbopack-->36.8s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57.10.warm.emit-->5.5s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.10.warm.turbopack-->29.5s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57+59.10.warm.emit-->1.3s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57.10.cold.turbopack-->33.3s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57.10.cold.emit-->16.5s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.10.cold.turbopack-->30.2s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57+59.10.cold.emit-->13.6s<!--/v--> |
| 1,000 | <!--v:dr.c59.import.15+22+55+56+57.1000.warm.turbopack-->52.7s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57.1000.warm.emit-->16.5s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.1000.warm.turbopack-->34.2s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57+59.1000.warm.emit-->1.2s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57.1000.cold.turbopack-->34.6s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57.1000.cold.emit-->17.3s<!--/v--> | <!--v:dr.c59.import.15+22+55+56+57+59.1000.cold.turbopack-->29.9s<!--/v--> / <!--v:dr.c59.import.15+22+55+56+57+59.1000.cold.emit-->12.9s<!--/v--> |

- Warm builds with new imports: emit no longer grows with them (<!--v:dr.c59.import.15+22+55+56+57+59.10.warm.emit-->1.3s<!--/v--> at 10, <!--v:dr.c59.import.15+22+55+56+57+59.1000.warm.emit-->1.2s<!--/v--> at
  1,000); `run-turbopack` is 7s shorter at 10 and 18s at 1,000, the three builds of each
  not overlapping. With 1,000 new imports the warm build's `run-turbopack` (<!--v:dr.c59.import.15+22+55+56+57+59.1000.warm.turbopack-->34.2s<!--/v-->) is now
  within 5s of a cold one (<!--v:dr.c59.import.15+22+55+56+57+59.1000.cold.turbopack-->29.9s<!--/v-->); what is left of it is the recomputation before emit
  (<!--v:dr.c59.import.15+22+55+56+57+59.1000.warm.preEmit-->30.0s<!--/v-->). With one new import, no difference outside the spread.
- Cold builds: `run-turbopack` 2.3 to 4.6s shorter at every N (emit 2.3 to 4.4s), the
  three builds of each not overlapping at any N. A cold build creates one root per endpoint and
  connects each to the finished emit graph; with 59 it does neither.

## After `run-turbopack`: the route bundle stats step

Whole-build profiles of 15 + 22 + 55 + 56 + 57 + 59 (warm, 1, 10 and 1,000 new imports, on
a dedicated box; profiles, not records) put 13 to 15s on one core in Next.js's own
JavaScript after `run-turbopack`. The largest part is `writeRouteBundleStats`
(`packages/next/src/build/route-bundle-stats.ts`, the `write-route-bundle-stats` span),
which every Turbopack build runs to write `diagnostics/route-bundle-stats.json`. For each
app page it `require()`s the page's client reference manifest to read its `entryJSFiles`,
and V8 parses and compiles each one as a script. On the monolith the manifests are
<!--v:rs.c60.manifests-->2,073 files, 774.6 MB<!--/v-->. In each file one line assigns a JSON value,
`globalThis.__RSC_MANIFEST[<key>] = <JSON>;`, which Turbopack writes with `serde_json`.

- **60 `route-stats-json-manifest`** (JavaScript, not the binding): the step finds that
  line and parses the key and the value with `JSON.parse`. A file with any other shape
  (no such line, more than one, or a value that is not JSON) falls back to `require()`, as
  before; the fallback now restores `globalThis.__RSC_MANIFEST` when the file throws.

`scripts/turbopack-gym/route-stats.mjs` measures the step alone, on one build's output:
Next.js's `route-bundle-stats.ts` as of v16.4.0 (`bench/turbopack-gym/sources/`, byte for
byte) against the same file with the candidate's patch, both transpiled with the app's
TypeScript, each run a fresh node process on one CPU, sides alternating. Every run's stats
file must equal the first, and base's must equal the build's own. The selftest runs it on
a kept build of the quick app and checks that a patch that changes the stats is refused.

`bench/turbopack-gym/route-stats-60.json` (a cold monolith build of 15 + 22 + 55 + 56 + 57,
7 runs per side, a dedicated c8gd.48xlarge): <!--v:rs.c60.base.s-->7.79s<!--/v--> → <!--v:rs.c60.candidate.s-->2.95s<!--/v--> (×<!--v:rs.c60.ratio-->0.379<!--/v-->), the runs not
overlapping; the process's resident memory when the step ends (`process.memoryUsage().rss`, not a peak) <!--v:rs.c60.base.rssMiB-->1,310 MiB<!--/v--> → <!--v:rs.c60.candidate.rssMiB-->113 MiB<!--/v-->. Same stats file, and the same as the
build's. The step runs on the main thread after `run-turbopack` in every build, warm or
cold, and the build awaits it before finishing; whole builds with 60 were not measured.

## Client reference manifests: shared parts computed once

After 59, profiles of warm builds put most of the recomputation before emit in
`client_reference_manifest::build_manifest` (Open, below). For every client reference a
page uses, `build_manifest` reads the reference's server path and looks up three module
ids (client, SSR, RSC), each lookup going through the chunking context's id strategy, the
module's ident and a keyed read of the id map, and for every JavaScript chunk of it the
chunk's component chunks (`client_chunk_components`, which reads the chunk's runtime
info and each component's path and content). None of these depend on the page, and the
monolith's 1,709 page manifests share most of their client references.

- **61 `shared-manifest-entry-parts`**: the server path and the three module ids of a
  client reference (`client_reference_ids`) and a chunk's components
  (`client_chunk_components`) are turbo-tasks functions, so each is computed once and read
  by every page's `build_manifest`; after an edit only those whose inputs changed run
  again. The manifests are built from the same values in the same order. Clippy on
  `next-core` (`-D warnings`) is clean.

`bench/turbopack-graph-drift-61.json` (15 + 22 + 55 + 56 + 57 + 59 against the same with 61,
`import` edits, 3 reps, same output at every point). Warm `run-turbopack`, then cold
`run-turbopack` / `turbopack-emit`:

| new imports | warm | warm, + 61 | cold | cold, + 61 |
|---|---|---|---|---|
| 0 | <!--v:dr.c61.import.15+22+55+56+57+59.0.warm.turbopack-->5.1s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59+61.0.warm.turbopack-->5.1s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59.0.cold.turbopack-->30.4s<!--/v--> / <!--v:dr.c61.import.15+22+55+56+57+59.0.cold.emit-->13.8s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59+61.0.cold.turbopack-->25.9s<!--/v--> / <!--v:dr.c61.import.15+22+55+56+57+59+61.0.cold.emit-->9.5s<!--/v--> |
| 1 | <!--v:dr.c61.import.15+22+55+56+57+59.1.warm.turbopack-->27.1s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59+61.1.warm.turbopack-->22.8s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59.1.cold.turbopack-->30.2s<!--/v--> / <!--v:dr.c61.import.15+22+55+56+57+59.1.cold.emit-->13.7s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59+61.1.cold.turbopack-->26.6s<!--/v--> / <!--v:dr.c61.import.15+22+55+56+57+59+61.1.cold.emit-->10.0s<!--/v--> |
| 10 | <!--v:dr.c61.import.15+22+55+56+57+59.10.warm.turbopack-->29.6s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59+61.10.warm.turbopack-->25.5s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59.10.cold.turbopack-->28.9s<!--/v--> / <!--v:dr.c61.import.15+22+55+56+57+59.10.cold.emit-->12.7s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59+61.10.cold.turbopack-->26.5s<!--/v--> / <!--v:dr.c61.import.15+22+55+56+57+59+61.10.cold.emit-->10.0s<!--/v--> |
| 1,000 | <!--v:dr.c61.import.15+22+55+56+57+59.1000.warm.turbopack-->34.5s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59+61.1000.warm.turbopack-->29.1s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59.1000.cold.turbopack-->29.4s<!--/v--> / <!--v:dr.c61.import.15+22+55+56+57+59.1000.cold.emit-->13.0s<!--/v--> | <!--v:dr.c61.import.15+22+55+56+57+59+61.1000.cold.turbopack-->26.7s<!--/v--> / <!--v:dr.c61.import.15+22+55+56+57+59+61.1000.cold.emit-->9.4s<!--/v--> |

- Warm builds with new imports: `run-turbopack` 4 to 5.5s shorter, the three builds of each
  not overlapping at 1, 10 and 1,000; with nothing changed, the same.
- Cold builds: `run-turbopack` 2.4 to 4.5s shorter and emit 2.7 to 4.3s shorter at every N,
  the builds of each not overlapping. The cache is about 5% smaller
  (0.81 → 0.77 GiB after a warm build with one new import).

## Client reference manifests: async flags read once per reference

Profiles of a warm build with one new import on the full stack (15 + 22 + 41 + 42 + 52 + 55 +
56 + 57 + 59 + 61, built with frame pointers, 24 and 192 CPUs;
`bench/turbopack-gym/profiles-warm1.json`, its first two profiles) put the largest share of the
workers' CPU attributed to a task function in `build_manifest`, and half or more of that in one
closure (`{closure#2}`): for every client reference of every page, whether its client, SSR and
RSC modules are async, three keyed reads of the app's one `AsyncModulesInfo` cell. Each keyed
read records a dependency on that one task, so all 1,709 page manifests contend on it; the top
leaves of both profiles are lock and atomic operations. The flags do not depend on the page.

- **64 `shared-async-flags`** (on 61): `client_reference_ids`, the per-reference task of 61,
  also reads the three flags, so they are read once per client reference and every page's
  manifest takes them from that task's cell; the page also no longer awaits each reference's
  module value, which only that task needs. Same manifests, same order; clippy on `next-core`
  (`-D warnings`) is clean.

`bench/turbopack-graph-drift-64-24.json` (the full stack against the same with 64, `import`
edits, 3 reps, 24 CPUs, same output at every point; a resumed sweep, two boots of one instance
type). Warm `run-turbopack`, then cold `run-turbopack` / `turbopack-emit`:

| new imports | warm | warm, + 64 | cold | cold, + 64 |
|---|---|---|---|---|
| 0 | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.0.warm.turbopack-->5.1s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.0.warm.turbopack-->5.1s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.0.cold.turbopack-->18.8s<!--/v--> / <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.0.cold.emit-->7.2s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.0.cold.turbopack-->17.1s<!--/v--> / <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.0.cold.emit-->5.4s<!--/v--> |
| 1 | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.1.warm.turbopack-->16.8s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.1.warm.turbopack-->13.1s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.1.cold.turbopack-->19.5s<!--/v--> / <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.1.cold.emit-->7.3s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.1.cold.turbopack-->17.2s<!--/v--> / <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.1.cold.emit-->5.4s<!--/v--> |
| 10 | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.10.warm.turbopack-->19.6s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.10.warm.turbopack-->16.0s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.10.cold.turbopack-->19.3s<!--/v--> / <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.10.cold.emit-->7.5s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.10.cold.turbopack-->17.2s<!--/v--> / <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.10.cold.emit-->5.4s<!--/v--> |
| 1,000 | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.1000.warm.turbopack-->21.0s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.1000.warm.turbopack-->17.0s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.1000.cold.turbopack-->19.1s<!--/v--> / <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61.1000.cold.emit-->7.2s<!--/v--> | <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.1000.cold.turbopack-->18.0s<!--/v--> / <!--v:dr.c64s24.import.15+22+41+42+52+55+56+57+59+61+64.1000.cold.emit-->5.5s<!--/v--> |

- Warm builds with new imports: `run-turbopack` 3.6 to 4.0s shorter at 1, 10 and 1,000, the
  three builds of each not overlapping; with nothing changed, the same.
- Cold builds: `run-turbopack` 1.1 to 2.3s shorter and emit 1.8 to 2.1s shorter at every N, the
  builds of each not overlapping.

`bench/turbopack-graph-drift-64-192.json`, the same on 192 CPUs (one boot). `run-turbopack` /
`turbopack-emit`, warm then cold:

| new imports | warm | warm, + 64 | cold | cold, + 64 |
|---|---|---|---|---|
| 0 | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.0.warm.turbopack-->5.8s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.0.warm.emit-->1.6s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.0.warm.turbopack-->5.6s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.0.warm.emit-->1.5s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.0.cold.turbopack-->25.6s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.0.cold.emit-->11.1s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.0.cold.turbopack-->20.9s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.0.cold.emit-->6.3s<!--/v--> |
| 1 | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.1.warm.turbopack-->22.1s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.1.warm.emit-->2.2s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.1.warm.turbopack-->16.8s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.1.warm.emit-->5.0s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.1.cold.turbopack-->24.9s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.1.cold.emit-->10.8s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.1.cold.turbopack-->20.9s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.1.cold.emit-->6.5s<!--/v--> |
| 10 | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.10.warm.turbopack-->24.9s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.10.warm.emit-->2.4s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.10.warm.turbopack-->19.5s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.10.warm.emit-->4.8s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.10.cold.turbopack-->25.5s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.10.cold.emit-->10.8s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.10.cold.turbopack-->20.8s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.10.cold.emit-->6.4s<!--/v--> |
| 1,000 | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.1000.warm.turbopack-->25.7s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.1000.warm.emit-->2.5s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.1000.warm.turbopack-->22.2s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.1000.warm.emit-->5.5s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.1000.cold.turbopack-->25.3s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61.1000.cold.emit-->10.7s<!--/v--> | <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.1000.cold.turbopack-->20.9s<!--/v--> / <!--v:dr.c64s192.import.15+22+41+42+52+55+56+57+59+61+64.1000.cold.emit-->6.5s<!--/v--> |

- Warm builds with new imports: `run-turbopack` 3.5 to 5.4s shorter, the builds of each not
  overlapping; with nothing changed, the same. Their emit span is longer with 64 (about 2.2s
  against 5.0s at one new import) while `run-turbopack` as a whole is shorter; why the work
  shifts into emit there is not measured.
- Cold builds: `run-turbopack` 4.0 to 4.7s shorter and emit 4.2 to 4.8s shorter at every N, the
  builds of each not overlapping.

## Client reference manifests: chunk lists per chunk group

With 64, the largest part of a page manifest's work is its chunk lists: for every client
reference, the URL of each JavaScript chunk of the reference's chunk group, with the component
chunks of a merged chunk. All the client references of a layout segment use the segment's chunk
group, and pages under the same layouts share those groups, so the same list is built once per
reference per page.

- **65 `chunk-lists-on-64`** (63, rebased onto 64): a chunk group's client chunk list and a layout
  segment's SSR chunk paths are turbo-tasks functions, computed once per group and shared by
  every client reference and page using it; a page adds each group's assets to its references
  once. Same manifests, same order. 63 alone, before 64, changed little in early runs (not a
  record): the per-page async checks of 64 were the larger cost then.

`bench/turbopack-graph-drift-65-192.json` (the full stack + 64 against the same with 65, `import`
edits, 3 reps, 192 CPUs, same output at every point). `run-turbopack` / `turbopack-emit`:

| new imports | warm | warm, + 65 | cold | cold, + 65 |
|---|---|---|---|---|
| 0 | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.0.warm.turbopack-->5.2s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.0.warm.emit-->1.5s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.0.warm.turbopack-->4.9s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.0.warm.emit-->1.4s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.0.cold.turbopack-->20.7s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.0.cold.emit-->6.1s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.0.cold.turbopack-->19.0s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.0.cold.emit-->4.6s<!--/v--> |
| 1 | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.1.warm.turbopack-->16.5s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.1.warm.emit-->4.7s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.1.warm.turbopack-->14.2s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.1.warm.emit-->1.9s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.1.cold.turbopack-->20.7s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.1.cold.emit-->6.6s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.1.cold.turbopack-->18.9s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.1.cold.emit-->4.5s<!--/v--> |
| 10 | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.10.warm.turbopack-->19.7s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.10.warm.emit-->4.2s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.10.warm.turbopack-->17.3s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.10.warm.emit-->2.0s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.10.cold.turbopack-->21.3s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.10.cold.emit-->6.6s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.10.cold.turbopack-->19.0s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.10.cold.emit-->4.6s<!--/v--> |
| 1,000 | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.1000.warm.turbopack-->20.8s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.1000.warm.emit-->5.4s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.1000.warm.turbopack-->17.5s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.1000.warm.emit-->2.3s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.1000.cold.turbopack-->20.6s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64.1000.cold.emit-->6.4s<!--/v--> | <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.1000.cold.turbopack-->18.6s<!--/v--> / <!--v:dr.c65s192.import.15+22+41+42+52+55+56+57+59+61+64+65.1000.cold.emit-->4.4s<!--/v--> |

`bench/turbopack-graph-drift-65-24.json`, the same on 24 CPUs (a resumed sweep, two boots):

| new imports | warm | warm, + 65 | cold | cold, + 65 |
|---|---|---|---|---|
| 0 | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.0.warm.turbopack-->5.0s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.0.warm.emit-->1.4s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.0.warm.turbopack-->5.1s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.0.warm.emit-->1.4s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.0.cold.turbopack-->17.1s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.0.cold.emit-->5.4s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.0.cold.turbopack-->16.0s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.0.cold.emit-->4.4s<!--/v--> |
| 1 | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.1.warm.turbopack-->13.0s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.1.warm.emit-->1.3s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.1.warm.turbopack-->12.1s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.1.warm.emit-->1.3s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.1.cold.turbopack-->17.8s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.1.cold.emit-->5.4s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.1.cold.turbopack-->16.0s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.1.cold.emit-->4.3s<!--/v--> |
| 10 | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.10.warm.turbopack-->16.1s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.10.warm.emit-->1.3s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.10.warm.turbopack-->14.8s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.10.warm.emit-->1.4s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.10.cold.turbopack-->17.1s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.10.cold.emit-->5.4s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.10.cold.turbopack-->16.2s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.10.cold.emit-->4.4s<!--/v--> |
| 1,000 | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.1000.warm.turbopack-->17.0s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.1000.warm.emit-->1.2s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.1000.warm.turbopack-->16.2s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.1000.warm.emit-->1.4s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.1000.cold.turbopack-->17.3s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64.1000.cold.emit-->5.5s<!--/v--> | <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.1000.cold.turbopack-->16.9s<!--/v--> / <!--v:dr.c65s24.import.15+22+41+42+52+55+56+57+59+61+64+65.1000.cold.emit-->4.5s<!--/v--> |

- 192 CPUs: warm builds with new imports 2.3 to 3.3s shorter, and their emit span is back near 2s
  (with 64 alone it was near 5s); cold builds 1.7 to 2.3s shorter. With nothing changed, the same.
- 24 CPUs: warm builds with new imports 0.8 to 1.3s shorter, cold builds 0.4 to 1.8s shorter. A
  warm build with nothing changed is 0.07s slower, the builds of each not overlapping.
- At every point with new imports, and at every cold point, the builds of each binding do not
  overlap. With nothing changed on 192 CPUs they do (65's median is lower, its range wider).

## What a warm build reruns: whole-app values that always change

Turbopack's task statistics (`NEXT_TURBOPACK_TASK_STATISTICS=<file>`, which counted cache hits
and misses per function), with two more counters per function (executions, and cell updates
that invalidated other tasks, with how many; `bench/turbopack-gym/tools/task-exec-stats.patch`,
a measurement patch, not a candidate). `bench/turbopack-gym/task-stats-warm1.json`: with the
full stack + 64, a warm build of `drift-monolith` after one new import ran 164,472 to 176,294
task executions in three builds, against 3,006,586 in a cold build and 14,575 in a warm build
with nothing changed; the counts vary between builds (a task read while its input is stale runs
again). Most of the reruns fan out from a few
whole-app values that change on every module graph rebuild:

- `ChunkGroupContentInner`, the content of each chunk group, is declared `cell = "new"`: every
  rerun counts as a change, even with the same content. Every chunk group's traversal reruns
  after any graph change (8,156 to 8,245 times), and they invalidated 16,312 to 16,322 readers.
- `BindingUsageInfo` holds the graph edges of the unused references as a field. Edge indices
  are assigned anew on every graph rebuild, so the value changes, and the chunking contexts'
  per-module `module_export_usage` tasks (22,758), which read it and then their module's keyed
  entry, all ran again.

Two candidates, in order:

- **66 `chunk-group-content-eq`**: `ChunkGroupContentInner` is compared on update. The readers
  invalidated by chunk group content went to 14.
- **67 `binding-usage-stable`** (on 66): the unused reference edges move to a cell of their own
  (`UnusedReferenceEdges`); graph traversals read that cell. `BindingUsageInfo` is then the same
  across rebuilds, and `module_export_usage` reruns went from 22,758 to none.

With 66 a warm build after one new import ran 148,168 and 148,391 tasks (two builds), with both
124,098 and 125,249. Same
output in every build. What still reruns is mostly output asset lists (`OutputAssets::concatenate`,
`all_assets`), which do change: one new import renames hundreds of content-hashed chunks.

`bench/turbopack-graph-drift-6667-24.json` and `-6667-192.json` (the full stack + 64, + 66 and
+ 66 + 67, `import` edits, 3 reps, same output at every point; the 24-CPU sweep resumed across
three boots). `run-turbopack`, 24 CPUs:

| new imports | warm | + 66 | + 66 + 67 | cold | + 66 | + 66 + 67 |
|---|---|---|---|---|---|---|
| 0 | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64.0.warm.turbopack-->5.1s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66.0.warm.turbopack-->5.1s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66+67.0.warm.turbopack-->5.1s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64.0.cold.turbopack-->17.2s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66.0.cold.turbopack-->17.1s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66+67.0.cold.turbopack-->17.1s<!--/v--> |
| 1 | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64.1.warm.turbopack-->13.5s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66.1.warm.turbopack-->13.0s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66+67.1.warm.turbopack-->12.4s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64.1.cold.turbopack-->17.1s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66.1.cold.turbopack-->17.1s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66+67.1.cold.turbopack-->17.0s<!--/v--> |
| 10 | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64.10.warm.turbopack-->15.8s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66.10.warm.turbopack-->15.9s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66+67.10.warm.turbopack-->15.6s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64.10.cold.turbopack-->17.3s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66.10.cold.turbopack-->17.2s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66+67.10.cold.turbopack-->17.3s<!--/v--> |
| 1,000 | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64.1000.warm.turbopack-->17.4s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66.1000.warm.turbopack-->17.4s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66+67.1000.warm.turbopack-->16.5s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64.1000.cold.turbopack-->17.3s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66.1000.cold.turbopack-->17.3s<!--/v--> | <!--v:dr.c6667s24.import.15+22+41+42+52+55+56+57+59+61+64+66+67.1000.cold.turbopack-->17.4s<!--/v--> |

192 CPUs:

| new imports | warm | + 66 | + 66 + 67 | cold | + 66 | + 66 + 67 |
|---|---|---|---|---|---|---|
| 0 | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64.0.warm.turbopack-->5.0s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66.0.warm.turbopack-->5.0s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66+67.0.warm.turbopack-->5.4s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64.0.cold.turbopack-->20.4s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66.0.cold.turbopack-->20.8s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66+67.0.cold.turbopack-->21.1s<!--/v--> |
| 1 | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64.1.warm.turbopack-->16.9s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66.1.warm.turbopack-->16.6s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66+67.1.warm.turbopack-->15.4s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64.1.cold.turbopack-->20.7s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66.1.cold.turbopack-->20.9s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66+67.1.cold.turbopack-->20.6s<!--/v--> |
| 10 | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64.10.warm.turbopack-->19.5s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66.10.warm.turbopack-->19.0s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66+67.10.warm.turbopack-->18.1s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64.10.cold.turbopack-->20.8s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66.10.cold.turbopack-->20.7s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66+67.10.cold.turbopack-->20.6s<!--/v--> |
| 1,000 | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64.1000.warm.turbopack-->21.3s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66.1000.warm.turbopack-->21.4s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66+67.1000.warm.turbopack-->20.2s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64.1000.cold.turbopack-->20.6s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66.1000.cold.turbopack-->20.9s<!--/v--> | <!--v:dr.c6667s192.import.15+22+41+42+52+55+56+57+59+61+64+66+67.1000.cold.turbopack-->20.8s<!--/v--> |

- 66 alone: on 192 CPUs, warm after one new import, 0.3s shorter with the builds not
  overlapping; at every other point, no difference beyond the spread of the builds.
- 66 + 67, warm builds with new imports: 24 CPUs 0.2 to 1.1s shorter (the builds do not overlap
  at 10 and 1,000; at 1 they overlap by 0.01s); 192 CPUs 1.1 to 1.5s shorter (not overlapping at 1, overlapping
  at 10 and 1,000). Cold builds: no difference.
- 66 + 67 on 192 CPUs, warm with nothing changed: 0.4s slower, the builds not overlapping; on
  24 CPUs, the same as without. Not explained.

## Upstream's scalability PRs, a sharded heap band, worker threads

Five vercel/next.js canary PRs (#99773, #100146, #100147, #100165, #100187, named in
vercel/next.js#100250) apply cleanly to v16.4.0: **u1 `upstream-scalability`**. #99773 replaces
the priority runner's queue (a lock-free band for `TaskPriority::Initial`, everything else in one
`Mutex<BinaryHeap>`) and conflicts with 22, so the stack on top of u1 leaves 22 out. **full67**
is every candidate through 67.

`bench/turbopack-graph-drift-up-24.json` and `-up-192.json` (`import` edits, 2 reps, same output
at every point). 24 CPUs:

| `run-turbopack` | v16.4.0 | u1 | full67 | u1 + full67 − 22 |
|---|---|---|---|---|
| warm, 0 | <!--v:dr.up24.import.base.0.warm.turbopack-->13.5s<!--/v--> | <!--v:dr.up24.import.u1.0.warm.turbopack-->13.3s<!--/v--> | <!--v:dr.up24.import.full67.0.warm.turbopack-->4.7s<!--/v--> | <!--v:dr.up24.import.u1+full67-22.0.warm.turbopack-->4.7s<!--/v--> |
| cold, 0 | <!--v:dr.up24.import.base.0.cold.turbopack-->45.5s<!--/v--> | <!--v:dr.up24.import.u1.0.cold.turbopack-->38.1s<!--/v--> | <!--v:dr.up24.import.full67.0.cold.turbopack-->16.1s<!--/v--> | <!--v:dr.up24.import.u1+full67-22.0.cold.turbopack-->16.0s<!--/v--> |
| warm, 1 | <!--v:dr.up24.import.base.1.warm.turbopack-->41.6s<!--/v--> | <!--v:dr.up24.import.u1.1.warm.turbopack-->40.2s<!--/v--> | <!--v:dr.up24.import.full67.1.warm.turbopack-->11.1s<!--/v--> | <!--v:dr.up24.import.u1+full67-22.1.warm.turbopack-->11.7s<!--/v--> |
| cold, 1 | <!--v:dr.up24.import.base.1.cold.turbopack-->44.4s<!--/v--> | <!--v:dr.up24.import.u1.1.cold.turbopack-->37.9s<!--/v--> | <!--v:dr.up24.import.full67.1.cold.turbopack-->16.9s<!--/v--> | <!--v:dr.up24.import.u1+full67-22.1.cold.turbopack-->16.1s<!--/v--> |
| warm, 10 | <!--v:dr.up24.import.base.10.warm.turbopack-->55.2s<!--/v--> | <!--v:dr.up24.import.u1.10.warm.turbopack-->53.2s<!--/v--> | <!--v:dr.up24.import.full67.10.warm.turbopack-->14.3s<!--/v--> | <!--v:dr.up24.import.u1+full67-22.10.warm.turbopack-->14.3s<!--/v--> |
| cold, 10 | <!--v:dr.up24.import.base.10.cold.turbopack-->43.2s<!--/v--> | <!--v:dr.up24.import.u1.10.cold.turbopack-->38.6s<!--/v--> | <!--v:dr.up24.import.full67.10.cold.turbopack-->16.2s<!--/v--> | <!--v:dr.up24.import.u1+full67-22.10.cold.turbopack-->16.2s<!--/v--> |
| warm, 1,000 | <!--v:dr.up24.import.base.1000.warm.turbopack-->85.1s<!--/v--> | <!--v:dr.up24.import.u1.1000.warm.turbopack-->74.1s<!--/v--> | <!--v:dr.up24.import.full67.1000.warm.turbopack-->16.6s<!--/v--> | <!--v:dr.up24.import.u1+full67-22.1000.warm.turbopack-->16.2s<!--/v--> |
| cold, 1,000 | <!--v:dr.up24.import.base.1000.cold.turbopack-->45.7s<!--/v--> | <!--v:dr.up24.import.u1.1000.cold.turbopack-->39.7s<!--/v--> | <!--v:dr.up24.import.full67.1000.cold.turbopack-->16.3s<!--/v--> | <!--v:dr.up24.import.u1+full67-22.1000.cold.turbopack-->16.4s<!--/v--> |

192 CPUs:

| `run-turbopack` | v16.4.0 | u1 | full67 | u1 + full67 − 22 |
|---|---|---|---|---|
| warm, 0 | <!--v:dr.up192.import.base.0.warm.turbopack-->40.3s<!--/v--> | <!--v:dr.up192.import.u1.0.warm.turbopack-->40.1s<!--/v--> | <!--v:dr.up192.import.full67.0.warm.turbopack-->5.4s<!--/v--> | <!--v:dr.up192.import.u1+full67-22.0.warm.turbopack-->5.5s<!--/v--> |
| cold, 0 | <!--v:dr.up192.import.base.0.cold.turbopack-->92.2s<!--/v--> | <!--v:dr.up192.import.u1.0.cold.turbopack-->49.0s<!--/v--> | <!--v:dr.up192.import.full67.0.cold.turbopack-->18.7s<!--/v--> | <!--v:dr.up192.import.u1+full67-22.0.cold.turbopack-->18.4s<!--/v--> |
| warm, 1 | <!--v:dr.up192.import.base.1.warm.turbopack-->74.5s<!--/v--> | <!--v:dr.up192.import.u1.1.warm.turbopack-->73.3s<!--/v--> | <!--v:dr.up192.import.full67.1.warm.turbopack-->13.5s<!--/v--> | <!--v:dr.up192.import.u1+full67-22.1.warm.turbopack-->16.5s<!--/v--> |
| cold, 1 | <!--v:dr.up192.import.base.1.cold.turbopack-->91.9s<!--/v--> | <!--v:dr.up192.import.u1.1.cold.turbopack-->47.9s<!--/v--> | <!--v:dr.up192.import.full67.1.cold.turbopack-->20.0s<!--/v--> | <!--v:dr.up192.import.u1+full67-22.1.cold.turbopack-->19.0s<!--/v--> |
| warm, 10 | <!--v:dr.up192.import.base.10.warm.turbopack-->91.3s<!--/v--> | <!--v:dr.up192.import.u1.10.warm.turbopack-->87.8s<!--/v--> | <!--v:dr.up192.import.full67.10.warm.turbopack-->17.5s<!--/v--> | <!--v:dr.up192.import.u1+full67-22.10.warm.turbopack-->18.2s<!--/v--> |
| cold, 10 | <!--v:dr.up192.import.base.10.cold.turbopack-->91.8s<!--/v--> | <!--v:dr.up192.import.u1.10.cold.turbopack-->48.0s<!--/v--> | <!--v:dr.up192.import.full67.10.cold.turbopack-->19.3s<!--/v--> | <!--v:dr.up192.import.u1+full67-22.10.cold.turbopack-->19.2s<!--/v--> |
| warm, 1,000 | <!--v:dr.up192.import.base.1000.warm.turbopack-->129.6s<!--/v--> | <!--v:dr.up192.import.u1.1000.warm.turbopack-->116.2s<!--/v--> | <!--v:dr.up192.import.full67.1000.warm.turbopack-->18.1s<!--/v--> | <!--v:dr.up192.import.u1+full67-22.1000.warm.turbopack-->20.8s<!--/v--> |
| cold, 1,000 | <!--v:dr.up192.import.base.1000.cold.turbopack-->91.6s<!--/v--> | <!--v:dr.up192.import.u1.1000.cold.turbopack-->47.7s<!--/v--> | <!--v:dr.up192.import.full67.1000.cold.turbopack-->19.3s<!--/v--> | <!--v:dr.up192.import.u1+full67-22.1000.cold.turbopack-->19.1s<!--/v--> |

- u1 alone: cold builds 4.6 to 7.4s shorter on 24 CPUs and 43 to 44s shorter on 192 (91.7–92.8s
  against 48.4–49.6s at 0 new imports); warm builds little changed except after 1,000 new
  imports.
- u1 + full67 − 22 against full67: cold builds the same or slightly shorter; warm builds on 192 CPUs 0.7 to 3.0s longer, the builds not overlapping at 1, 10 and 1,000 new imports.

- **68 `sharded-heap-band`** (on u1): 22's sharding applied to the band #99773 keeps locked. The
  heap band is split into `workers/4` cache-padded heap shards by key hash (one below 8 workers),
  with a bit mask of non-empty shards in place of `heap_non_empty`; a pop takes the top of the
  better of two non-empty shards, the second via `try_lock`, then the other set shards, then the
  lowest band. Tests: every item popped once across 8 shards with replacements and claims, exact
  order with one shard; all `turbo-tasks` and `turbo-tasks-backend` tests pass.

`bench/turbopack-graph-drift-up68-24.json` and `-up68-192.json` (3 reps, same output at every
point; the 24-CPU sweep resumed across three boots). 192 CPUs:

| `run-turbopack` | full67 | u1 + full67 − 22 | + 68 |
|---|---|---|---|
| warm, 0 | <!--v:dr.up68s192.import.full67.0.warm.turbopack-->5.9s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22.0.warm.turbopack-->5.5s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22+68.0.warm.turbopack-->5.5s<!--/v--> |
| cold, 0 | <!--v:dr.up68s192.import.full67.0.cold.turbopack-->18.7s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22.0.cold.turbopack-->18.5s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22+68.0.cold.turbopack-->18.5s<!--/v--> |
| warm, 1 | <!--v:dr.up68s192.import.full67.1.warm.turbopack-->13.7s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22.1.warm.turbopack-->16.3s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22+68.1.warm.turbopack-->14.6s<!--/v--> |
| cold, 1 | <!--v:dr.up68s192.import.full67.1.cold.turbopack-->18.9s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22.1.cold.turbopack-->18.7s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22+68.1.cold.turbopack-->18.3s<!--/v--> |
| warm, 10 | <!--v:dr.up68s192.import.full67.10.warm.turbopack-->16.9s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22.10.warm.turbopack-->18.4s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22+68.10.warm.turbopack-->16.6s<!--/v--> |
| cold, 10 | <!--v:dr.up68s192.import.full67.10.cold.turbopack-->19.0s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22.10.cold.turbopack-->18.1s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22+68.10.cold.turbopack-->18.7s<!--/v--> |
| warm, 1,000 | <!--v:dr.up68s192.import.full67.1000.warm.turbopack-->18.2s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22.1000.warm.turbopack-->20.3s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22+68.1000.warm.turbopack-->17.4s<!--/v--> |
| cold, 1,000 | <!--v:dr.up68s192.import.full67.1000.cold.turbopack-->18.7s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22.1000.cold.turbopack-->18.4s<!--/v--> | <!--v:dr.up68s192.import.u1+full67-22+68.1000.cold.turbopack-->18.6s<!--/v--> |

24 CPUs:

| `run-turbopack` | full67 | u1 + full67 − 22 | + 68 |
|---|---|---|---|
| warm, 0 | <!--v:dr.up68s24.import.full67.0.warm.turbopack-->4.7s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22.0.warm.turbopack-->4.6s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22+68.0.warm.turbopack-->4.6s<!--/v--> |
| cold, 0 | <!--v:dr.up68s24.import.full67.0.cold.turbopack-->16.0s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22.0.cold.turbopack-->16.0s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22+68.0.cold.turbopack-->16.0s<!--/v--> |
| warm, 1 | <!--v:dr.up68s24.import.full67.1.warm.turbopack-->11.8s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22.1.warm.turbopack-->11.5s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22+68.1.warm.turbopack-->11.1s<!--/v--> |
| cold, 1 | <!--v:dr.up68s24.import.full67.1.cold.turbopack-->16.2s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22.1.cold.turbopack-->16.1s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22+68.1.cold.turbopack-->16.2s<!--/v--> |
| warm, 10 | <!--v:dr.up68s24.import.full67.10.warm.turbopack-->13.8s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22.10.warm.turbopack-->13.9s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22+68.10.warm.turbopack-->15.0s<!--/v--> |
| cold, 10 | <!--v:dr.up68s24.import.full67.10.cold.turbopack-->16.1s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22.10.cold.turbopack-->16.2s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22+68.10.cold.turbopack-->16.3s<!--/v--> |
| warm, 1,000 | <!--v:dr.up68s24.import.full67.1000.warm.turbopack-->15.6s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22.1000.warm.turbopack-->16.0s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22+68.1000.warm.turbopack-->16.0s<!--/v--> |
| cold, 1,000 | <!--v:dr.up68s24.import.full67.1000.cold.turbopack-->16.4s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22.1000.cold.turbopack-->16.6s<!--/v--> | <!--v:dr.up68s24.import.u1+full67-22+68.1000.cold.turbopack-->16.4s<!--/v--> |

- 192 CPUs: 68 takes 1.8 to 2.9s off warm builds at 10 and 1,000 new imports against u1 + full67
  − 22 (not overlapping), about where full67 is; at one new import it is 0.9s behind full67.
- 24 CPUs, where it makes 8 shards: 1.1s longer at 10 new imports (not overlapping), the same
  elsewhere. The next sweep did not repeat it (0.2s).
- Found in review of 68: when the first of the two shards a pop compares has its lock taken, the
  pop still takes that shard and waits on it, even if the second is free. **69
  `heap-pick-free-shard`** takes the free one (with a test that fails against 68).
- **70 `heap-shards-from-64-workers`** (on 69): one heap below 64 workers, 16 shards at 64, 64 at
  192 and above, for the 24-CPU loss above. Test: the shard count at 4, 24, 63, 64 and 192
  workers (fails against 69). At 192 CPUs it shards as 69 does, so it was measured on 24 only.

`bench/turbopack-graph-drift-up70-192.json` and `-up70-24.json` (3 reps, same output at every
point; the 24-CPU sweep resumed across four boots). 192 CPUs:

| `run-turbopack` | full67 | u1 + full67 − 22 | + 68 | + 69 |
|---|---|---|---|---|
| warm, 0 | <!--v:dr.up70s192.import.full67.0.warm.turbopack-->5.1s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22.0.warm.turbopack-->5.1s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+68.0.warm.turbopack-->5.1s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+69.0.warm.turbopack-->5.1s<!--/v--> |
| cold, 0 | <!--v:dr.up70s192.import.full67.0.cold.turbopack-->18.9s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22.0.cold.turbopack-->18.9s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+68.0.cold.turbopack-->18.7s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+69.0.cold.turbopack-->19.1s<!--/v--> |
| warm, 1 | <!--v:dr.up70s192.import.full67.1.warm.turbopack-->13.8s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22.1.warm.turbopack-->14.9s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+68.1.warm.turbopack-->13.1s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+69.1.warm.turbopack-->13.7s<!--/v--> |
| cold, 1 | <!--v:dr.up70s192.import.full67.1.cold.turbopack-->18.6s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22.1.cold.turbopack-->18.6s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+68.1.cold.turbopack-->18.8s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+69.1.cold.turbopack-->18.5s<!--/v--> |
| warm, 10 | <!--v:dr.up70s192.import.full67.10.warm.turbopack-->16.5s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22.10.warm.turbopack-->17.8s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+68.10.warm.turbopack-->16.5s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+69.10.warm.turbopack-->16.3s<!--/v--> |
| cold, 10 | <!--v:dr.up70s192.import.full67.10.cold.turbopack-->19.1s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22.10.cold.turbopack-->18.4s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+68.10.cold.turbopack-->18.8s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+69.10.cold.turbopack-->18.8s<!--/v--> |
| warm, 1,000 | <!--v:dr.up70s192.import.full67.1000.warm.turbopack-->17.5s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22.1000.warm.turbopack-->20.0s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+68.1000.warm.turbopack-->16.8s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+69.1000.warm.turbopack-->17.2s<!--/v--> |
| cold, 1,000 | <!--v:dr.up70s192.import.full67.1000.cold.turbopack-->18.9s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22.1000.cold.turbopack-->18.6s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+68.1000.cold.turbopack-->18.9s<!--/v--> | <!--v:dr.up70s192.import.u1+full67-22+69.1000.cold.turbopack-->18.3s<!--/v--> |

24 CPUs:

| `run-turbopack` | u1 + full67 − 22 | + 68 | + 69 | + 70 |
|---|---|---|---|---|
| warm, 0 | <!--v:dr.up70s24.import.u1+full67-22.0.warm.turbopack-->4.7s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+68.0.warm.turbopack-->4.7s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+69.0.warm.turbopack-->4.7s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+70.0.warm.turbopack-->4.7s<!--/v--> |
| cold, 0 | <!--v:dr.up70s24.import.u1+full67-22.0.cold.turbopack-->16.2s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+68.0.cold.turbopack-->16.1s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+69.0.cold.turbopack-->16.1s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+70.0.cold.turbopack-->16.0s<!--/v--> |
| warm, 1 | <!--v:dr.up70s24.import.u1+full67-22.1.warm.turbopack-->11.8s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+68.1.warm.turbopack-->11.8s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+69.1.warm.turbopack-->11.5s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+70.1.warm.turbopack-->12.0s<!--/v--> |
| cold, 1 | <!--v:dr.up70s24.import.u1+full67-22.1.cold.turbopack-->16.1s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+68.1.cold.turbopack-->16.2s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+69.1.cold.turbopack-->16.0s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+70.1.cold.turbopack-->16.1s<!--/v--> |
| warm, 10 | <!--v:dr.up70s24.import.u1+full67-22.10.warm.turbopack-->14.6s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+68.10.warm.turbopack-->14.7s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+69.10.warm.turbopack-->14.0s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+70.10.warm.turbopack-->14.3s<!--/v--> |
| cold, 10 | <!--v:dr.up70s24.import.u1+full67-22.10.cold.turbopack-->16.2s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+68.10.cold.turbopack-->16.1s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+69.10.cold.turbopack-->16.0s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+70.10.cold.turbopack-->16.1s<!--/v--> |
| warm, 1,000 | <!--v:dr.up70s24.import.u1+full67-22.1000.warm.turbopack-->16.2s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+68.1000.warm.turbopack-->15.8s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+69.1000.warm.turbopack-->16.4s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+70.1000.warm.turbopack-->16.7s<!--/v--> |
| cold, 1,000 | <!--v:dr.up70s24.import.u1+full67-22.1000.cold.turbopack-->16.3s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+68.1000.cold.turbopack-->16.3s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+69.1000.cold.turbopack-->16.4s<!--/v--> | <!--v:dr.up70s24.import.u1+full67-22+70.1000.cold.turbopack-->16.4s<!--/v--> |

- 192 CPUs: 69 takes 1.2 to 2.7s off warm builds after 1, 10 and 1,000 new imports against
  u1 + full67 − 22 (not overlapping) and is level with full67 (overlapping at each). Against 68 it
  overlaps at 10 and 1,000; at one new import 68 is 0.6s shorter (not overlapping, and shorter
  than full67 too). Cold builds are within 0.7s of each other.
- 24 CPUs: the medians are within 0.9s of each other at every point. Builds separate only at 10
  new imports warm, where 69 is 0.6s shorter than the unsharded heap and 68 0.2s longer than the
  other three, and at 1,000 cold, under 0.1s. 68's 1.1s in the previous sweep did not repeat, so
  70 has nothing to recover: sharding from 8 workers, as 69 does, costs nothing measurable at 24
  CPUs. 70 is not taken.

`experimental.workerThreads` (page-data workers as `worker_threads` instead of child
processes), u1 + full67 − 22, 3 builds each: `bench/turbopack-gym/worker-threads-probe.json`
(a probe; the build output differs only in `required-server-files.json` recording the setting).
Wall time, cold: 33.1–33.2s against 25.1–25.5s on 24 CPUs, 44.0–51.6s against 28.6–29.9s on 192.
Warm after one new import: the same on 24 CPUs, 34.5–39.6s against 27.1–28.3s on 192. `run-turbopack` is about the same with threads except in the warm 24-CPU builds, where it is 11.6–11.8s forked against 13.2–14.2s with threads (not overlapping) while wall time is the same; elsewhere the difference is starting the page-data workers.

## Restoring a warm build's task data in parallel

Before a task from the persistent cache runs again, the backend prefetches the stored data of
every task it read, in one batch: a database read per key, then a decode, both on the one
thread that is starting the task. A task that walks the whole module graph reads at least one
task per module it visits, so its batch has at least that many keys, and the task does not start
until the batch is restored.

- **71 `parallel-batch-restore`** (on 69): a batch of at least 128 keys is split into chunks of
  at least 64, read and decoded in parallel with `turbo_tasks::parallel`, and put back in key
  order. The restore runs inside `with_turbo_tasks`, which holds the thread's turbo-tasks
  context borrowed, and `parallel` runs some of its jobs on the calling thread; 71 makes
  `turbo-tasks`' `scope_bounded` run such a job directly when the thread is already in the
  same context. Tests: `parallel::map_collect` inside `with_turbo_tasks` (fails without the
  `scope_bounded` change); a split lookup keeps each result at its key's position (fails with
  the chunks merged in reverse); and a split lookup against a real database finds each stored
  id and only those.

`bench/turbopack-graph-drift-up71-192.json` and `-up71-24.json` (3 reps, same output at every
point; each sweep resumed across two boots). 192 CPUs:

| new imports | warm, + 69 | + 71 | cold, + 69 | + 71 |
|---|---|---|---|---|
| 0 | <!--v:dr.up71s192.import.u1+full67-22+69.0.warm.turbopack-->5.9s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+71.0.warm.turbopack-->4.4s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+69.0.cold.turbopack-->18.2s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+71.0.cold.turbopack-->18.7s<!--/v--> |
| 1 | <!--v:dr.up71s192.import.u1+full67-22+69.1.warm.turbopack-->14.4s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+71.1.warm.turbopack-->10.9s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+69.1.cold.turbopack-->18.0s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+71.1.cold.turbopack-->18.3s<!--/v--> |
| 10 | <!--v:dr.up71s192.import.u1+full67-22+69.10.warm.turbopack-->16.8s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+71.10.warm.turbopack-->12.2s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+69.10.cold.turbopack-->18.6s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+71.10.cold.turbopack-->18.9s<!--/v--> |
| 1,000 | <!--v:dr.up71s192.import.u1+full67-22+69.1000.warm.turbopack-->17.7s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+71.1000.warm.turbopack-->16.5s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+69.1000.cold.turbopack-->18.8s<!--/v--> | <!--v:dr.up71s192.import.u1+full67-22+71.1000.cold.turbopack-->18.6s<!--/v--> |

24 CPUs:

| new imports | warm, + 69 | + 71 | cold, + 69 | + 71 |
|---|---|---|---|---|
| 0 | <!--v:dr.up71s24.import.u1+full67-22+69.0.warm.turbopack-->4.6s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+71.0.warm.turbopack-->3.7s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+69.0.cold.turbopack-->16.0s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+71.0.cold.turbopack-->16.0s<!--/v--> |
| 1 | <!--v:dr.up71s24.import.u1+full67-22+69.1.warm.turbopack-->12.2s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+71.1.warm.turbopack-->9.3s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+69.1.cold.turbopack-->16.7s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+71.1.cold.turbopack-->16.2s<!--/v--> |
| 10 | <!--v:dr.up71s24.import.u1+full67-22+69.10.warm.turbopack-->14.0s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+71.10.warm.turbopack-->12.1s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+69.10.cold.turbopack-->16.2s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+71.10.cold.turbopack-->16.2s<!--/v--> |
| 1,000 | <!--v:dr.up71s24.import.u1+full67-22+69.1000.warm.turbopack-->15.9s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+71.1000.warm.turbopack-->14.0s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+69.1000.cold.turbopack-->16.3s<!--/v--> | <!--v:dr.up71s24.import.u1+full67-22+71.1000.cold.turbopack-->16.9s<!--/v--> |

- Warm builds: 71 is shorter at every point, the builds not overlapping. On 24 CPUs by 0.9s
  with nothing changed and 1.9 to 2.9s with new imports; on 192 CPUs by 1.5s with nothing
  changed and 1.2 to 4.6s with new imports. After one new import a warm build's `run-turbopack`
  goes from 12.2 to 9.3s on 24 CPUs and from 14.4 to 10.9s on 192.
- Cold builds: within 0.6s, overlapping at every point but two on 24 CPUs: one new import, where
  71 is 0.5s shorter, and 1,000, where it was 0.6s longer. That point again, 5 reps
  (`bench/turbopack-graph-drift-up71c-24.json`): <!--v:dr.up71cs24.import.u1+full67-22+69.1000.cold.turbopack-->16.4s<!--/v--> and
  <!--v:dr.up71cs24.import.u1+full67-22+71.1000.cold.turbopack-->16.5s<!--/v-->, overlapping. 71 is taken.

## A warm build's writes: the content restored with the write task

A warm build applies every write again: which writes have been applied is kept in memory
only, so after a restart each one is captured and compared with the file on disk.
`WriteEffect::capture` reads the file's persisted content untracked. Before 72 that content
was the cell of a task of its own (`FileContent::persist()`). Nothing tracked it, so no
prefetch restored it, and `capture` restored each one as it read it: a database read and a
decode per written file, in turn, on the one task that takes the effects.

- **72 `write-content-own-cell`** (on 71): `DiskFileSystem::write` cells the persisted
  content in the write task itself. The task that takes the effects reads each write task's
  effect cell, so its prefetch restores the write tasks with their cells, content included,
  in 71's parallel batch. Test: two sessions on one persistent database, 20 files; between
  the sessions 10 of them are deleted from disk; the second session restores the write
  operation without running it again, applies its effects, and every file has its content.

`bench/turbopack-graph-drift-up72-24.json` and `-up72-192.json` (3 reps, same output at every
point; the 24-CPU sweep resumed across two boots). `run-turbopack`, 24 CPUs:

| new imports | warm, + 71 | + 72 | cold, + 71 | + 72 |
|---|---|---|---|---|
| 0 | <!--v:dr.up72s24.import.u1+full67-22+71.0.warm.turbopack-->3.6s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71+72.0.warm.turbopack-->2.4s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71.0.cold.turbopack-->16.2s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71+72.0.cold.turbopack-->16.0s<!--/v--> |
| 1 | <!--v:dr.up72s24.import.u1+full67-22+71.1.warm.turbopack-->9.2s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71+72.1.warm.turbopack-->8.9s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71.1.cold.turbopack-->16.8s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71+72.1.cold.turbopack-->16.0s<!--/v--> |
| 10 | <!--v:dr.up72s24.import.u1+full67-22+71.10.warm.turbopack-->11.7s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71+72.10.warm.turbopack-->11.0s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71.10.cold.turbopack-->16.2s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71+72.10.cold.turbopack-->16.2s<!--/v--> |
| 1,000 | <!--v:dr.up72s24.import.u1+full67-22+71.1000.warm.turbopack-->14.3s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71+72.1000.warm.turbopack-->13.9s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71.1000.cold.turbopack-->16.4s<!--/v--> | <!--v:dr.up72s24.import.u1+full67-22+71+72.1000.cold.turbopack-->17.0s<!--/v--> |

192 CPUs:

| new imports | warm, + 71 | + 72 | cold, + 71 | + 72 |
|---|---|---|---|---|
| 0 | <!--v:dr.up72s192.import.u1+full67-22+71.0.warm.turbopack-->4.4s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71+72.0.warm.turbopack-->3.1s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71.0.cold.turbopack-->18.4s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71+72.0.cold.turbopack-->18.3s<!--/v--> |
| 1 | <!--v:dr.up72s192.import.u1+full67-22+71.1.warm.turbopack-->11.9s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71+72.1.warm.turbopack-->9.7s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71.1.cold.turbopack-->18.8s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71+72.1.cold.turbopack-->18.7s<!--/v--> |
| 10 | <!--v:dr.up72s192.import.u1+full67-22+71.10.warm.turbopack-->12.9s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71+72.10.warm.turbopack-->12.4s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71.10.cold.turbopack-->18.8s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71+72.10.cold.turbopack-->18.7s<!--/v--> |
| 1,000 | <!--v:dr.up72s192.import.u1+full67-22+71.1000.warm.turbopack-->15.6s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71+72.1000.warm.turbopack-->15.5s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71.1000.cold.turbopack-->18.7s<!--/v--> | <!--v:dr.up72s192.import.u1+full67-22+71+72.1000.cold.turbopack-->18.9s<!--/v--> |

The warm points with 0 to 10 new imports again, 6 reps (`-up72r-24.json`, `-up72r-192.json`):

| new imports | 24 CPUs, + 71 | + 72 | 192 CPUs, + 71 | + 72 |
|---|---|---|---|---|
| 0 | <!--v:dr.up72rs24.import.u1+full67-22+71.0.warm.turbopack-->3.6s<!--/v--> | <!--v:dr.up72rs24.import.u1+full67-22+71+72.0.warm.turbopack-->2.4s<!--/v--> | <!--v:dr.up72rs192.import.u1+full67-22+71.0.warm.turbopack-->4.3s<!--/v--> | <!--v:dr.up72rs192.import.u1+full67-22+71+72.0.warm.turbopack-->3.1s<!--/v--> |
| 1 | <!--v:dr.up72rs24.import.u1+full67-22+71.1.warm.turbopack-->9.8s<!--/v--> | <!--v:dr.up72rs24.import.u1+full67-22+71+72.1.warm.turbopack-->8.7s<!--/v--> | <!--v:dr.up72rs192.import.u1+full67-22+71.1.warm.turbopack-->11.2s<!--/v--> | <!--v:dr.up72rs192.import.u1+full67-22+71+72.1.warm.turbopack-->9.6s<!--/v--> |
| 10 | <!--v:dr.up72rs24.import.u1+full67-22+71.10.warm.turbopack-->11.4s<!--/v--> | <!--v:dr.up72rs24.import.u1+full67-22+71+72.10.warm.turbopack-->11.5s<!--/v--> | <!--v:dr.up72rs192.import.u1+full67-22+71.10.warm.turbopack-->13.3s<!--/v--> | <!--v:dr.up72rs192.import.u1+full67-22+71+72.10.warm.turbopack-->12.0s<!--/v--> |

- Warm with nothing changed: emit goes from <!--v:dr.up72rs24.import.u1+full67-22+71.0.warm.emit-->1.3s<!--/v--> to <!--v:dr.up72rs24.import.u1+full67-22+71+72.0.warm.emit-->0.1s<!--/v--> on 24 CPUs, and
  `run-turbopack` is 1.3s shorter on 24 and 192 CPUs, the builds not overlapping in either
  sweep.
- Warm with new imports: shorter at every point in the 3-rep sweep, by 0.1 to 2.2s, the
  builds not overlapping on 24 CPUs at 10 new imports and on 192 CPUs at one. In the 6-rep
  sweep shorter by up to 1.6s, the builds not overlapping only on 192 CPUs at 10 new
  imports; on 24 CPUs at 10 the two are the same (<!--v:dr.up72rs24.import.u1+full67-22+71.10.warm.turbopack-->11.4s<!--/v--> and <!--v:dr.up72rs24.import.u1+full67-22+71+72.10.warm.turbopack-->11.5s<!--/v-->).
- Cold builds: the same within 0.3s, except on 24 CPUs: after one new import 72 was 0.8s
  shorter, and at 1,000 new imports 0.7s longer, the builds overlapping at neither point.
  The 1,000-import point again, 6 reps (`-up72c-24.json`, resumed across two boots):
  <!--v:dr.up72cs24.import.u1+full67-22+71.1000.cold.turbopack-->16.5s<!--/v--> and <!--v:dr.up72cs24.import.u1+full67-22+71+72.1000.cold.turbopack-->16.5s<!--/v-->, overlapping.
- After `run-turbopack`, warm with nothing changed, 72's builds take longer. On 24 CPUs, 6
  reps: <!--v:dr.up72rs24.import.u1+full67-22+71.0.warm.afterCompile-->8.7s<!--/v--> against <!--v:dr.up72rs24.import.u1+full67-22+71+72.0.warm.afterCompile-->9.7s<!--/v-->, not overlapping. On 192 CPUs five of 72's six
  builds are in the slow mode (about 21 to 24s), and none of 71's: <!--v:dr.up72rs192.import.u1+full67-22+71.0.warm.afterCompile-->12.7s<!--/v--> against
  <!--v:dr.up72rs192.import.u1+full67-22+71+72.0.warm.afterCompile-->22.2s<!--/v-->, and the whole build <!--v:dr.up72rs192.import.u1+full67-22+71.0.warm.wall-->18.7s<!--/v--> against <!--v:dr.up72rs192.import.u1+full67-22+71+72.0.warm.wall-->26.9s<!--/v-->. The sweep rotates the
  order the bindings build in with every build, so each binding builds first in half of a
  point's reps; the longer times are not tied to the order. The slow mode is not 72's
  alone: after one new import on 192 CPUs it is 71's time that is longer
  (<!--v:dr.up72rs192.import.u1+full67-22+71.1.warm.afterCompile-->24.2s<!--/v--> against <!--v:dr.up72rs192.import.u1+full67-22+71+72.1.warm.afterCompile-->19.8s<!--/v-->).
- The machine's peak memory in a warm build with nothing changed, 24 CPUs, 6 reps:
  <!--v:dr.up72rs24.import.u1+full67-22+71.0.warm.memPeak-->3.93 GiB<!--/v--> with 71 and <!--v:dr.up72rs24.import.u1+full67-22+71+72.0.warm.memPeak-->4.88 GiB<!--/v--> with 72. All six of 72's builds are near 4.9 GiB, and one of
  71's. About 1 GiB is the size of the output that the writes hold (the `server` and
  `static` directories). A probe of the main process's anonymous resident memory, on a
  32-CPU slice of another machine (not a record), finds the same two modes: 1.84 GiB in both
  of 71's builds, and with 72 1.9 GiB in five builds out of seven and 2.3 and 3.0 GiB in the
  other two (in the one of those two whose memory was sampled over time, it was taken late in
  the build). Starting the page-data workers costs
  more the more memory the main process has mapped (see the next section), so 72's longer
  time after `run-turbopack` is most likely this memory: with 72 the write tasks, which the
  task taking the effects reads, keep each written file's content, and before 72 that
  content was in tasks of its own that nothing tracked.
- 72 is not taken. The 1.2 to 1.3s it saves in `run-turbopack` is mostly spent again after
  it on 24 CPUs (the whole build <!--v:dr.up72rs24.import.u1+full67-22+71.0.warm.wall-->14.0s<!--/v--> against <!--v:dr.up72rs24.import.u1+full67-22+71+72.0.warm.wall-->13.7s<!--/v-->, and <!--v:dr.up72s24.import.u1+full67-22+71.0.warm.wall-->13.9s<!--/v--> against <!--v:dr.up72s24.import.u1+full67-22+71+72.0.warm.wall-->14.4s<!--/v--> in the
  3-rep sweep) and more than spent on 192, and it adds 1 GiB to a warm build. Restoring the
  content tasks in parallel while keeping them separate from the write tasks is not tried.

One new import against one string edit. `bench/turbopack-graph-drift-lab72-24.json` (72, the
`label` edit, 24 CPUs, 3 reps): `run-turbopack` <!--v:dr.lab72s24.label.u1+full67-22+71+72.0.warm.turbopack-->2.4s<!--/v--> with nothing changed,
<!--v:dr.lab72s24.label.u1+full67-22+71+72.1.warm.turbopack-->2.9s<!--/v--> after one edit and <!--v:dr.lab72s24.label.u1+full67-22+71+72.10.warm.turbopack-->4.1s<!--/v--> after 10, against <!--v:dr.up72rs24.import.u1+full67-22+71+72.1.warm.turbopack-->8.7s<!--/v--> and
<!--v:dr.up72rs24.import.u1+full67-22+71+72.10.warm.turbopack-->11.5s<!--/v--> after 1 and 10 new imports. A string edit changes the module's code and the
chunks that hold it; a new import also changes the module graph, and the whole-app analyses
over it, every chunk group's content, the output asset lists, and each changed page's client
reference manifest and trace file run again.

## Per-endpoint graph queries gated on a reachable-subgraph hash

After a new import every whole-app graph layer is a new cell, and every per-endpoint query
over it traverses again: next/dynamic imports, server actions and client references, about
990 endpoints each. In a 24-CPU profile of a warm build with one new import these traversals
took 9.6 CPU-s of the build's 104, at 15 to 23 busy cores, beside `chunk_group_info`.

- **73 `reachable-subgraph-gate`** (on 71): `ModuleGraphLayer::reachable_subgraph_hashes`
  maps each module of a layer to a 128-bit hash of what a traversal from it can see: the
  module, whether it is an entry, and every edge reachable from it in order, with its
  `RefData` and whether binding usage marks it unused. It is one pass over the strongly
  connected components in reverse topological order. The three queries read their entry's
  hash (a keyed read) and the layer untracked, so only the endpoints that reach the changed
  subgraph traverse again. Test: with entries a and b, a new import under b leaves a's hash
  and traversal alone, while a new import under a, and an edge under a becoming traced, run
  a's traversal again with the new result; the same test fails with the layer read tracked.

`bench/turbopack-graph-drift-up73-{24,8,192}.json` (6 reps; the 24- and 8-CPU sweeps resumed
across two boots) and `-up73c-{24,8,192}.json` (cold, 3 reps), the same output for both
bindings at every point. `run-turbopack`, warm:

| new imports | 24 CPUs, + 71 | + 73 | 8 CPUs, + 71 | + 73 | 192 CPUs, + 71 | + 73 |
|---|---|---|---|---|---|---|
| 0 | <!--v:dr.up73s24.import.u1+full67-22+71.0.warm.turbopack-->3.8s<!--/v--> | <!--v:dr.up73s24.import.u1+full67-22+71+73.0.warm.turbopack-->3.8s<!--/v--> | <!--v:dr.up73s8.import.u1+full67-22+71.0.warm.turbopack-->3.6s<!--/v--> | <!--v:dr.up73s8.import.u1+full67-22+71+73.0.warm.turbopack-->3.6s<!--/v--> | <!--v:dr.up73s192.import.u1+full67-22+71.0.warm.turbopack-->4.5s<!--/v--> | <!--v:dr.up73s192.import.u1+full67-22+71+73.0.warm.turbopack-->4.5s<!--/v--> |
| 1 | <!--v:dr.up73s24.import.u1+full67-22+71.1.warm.turbopack-->9.4s<!--/v--> | <!--v:dr.up73s24.import.u1+full67-22+71+73.1.warm.turbopack-->10.0s<!--/v--> | <!--v:dr.up73s8.import.u1+full67-22+71.1.warm.turbopack-->13.2s<!--/v--> | <!--v:dr.up73s8.import.u1+full67-22+71+73.1.warm.turbopack-->13.8s<!--/v--> | <!--v:dr.up73s192.import.u1+full67-22+71.1.warm.turbopack-->11.2s<!--/v--> | <!--v:dr.up73s192.import.u1+full67-22+71+73.1.warm.turbopack-->11.3s<!--/v--> |
| 10 | <!--v:dr.up73s24.import.u1+full67-22+71.10.warm.turbopack-->11.8s<!--/v--> | <!--v:dr.up73s24.import.u1+full67-22+71+73.10.warm.turbopack-->12.8s<!--/v--> | <!--v:dr.up73s8.import.u1+full67-22+71.10.warm.turbopack-->20.2s<!--/v--> | <!--v:dr.up73s8.import.u1+full67-22+71+73.10.warm.turbopack-->20.2s<!--/v--> | <!--v:dr.up73s192.import.u1+full67-22+71.10.warm.turbopack-->13.0s<!--/v--> | <!--v:dr.up73s192.import.u1+full67-22+71+73.10.warm.turbopack-->12.9s<!--/v--> |

Cold:

| new imports | 24 CPUs, + 71 | + 73 | 8 CPUs, + 71 | + 73 | 192 CPUs, + 71 | + 73 |
|---|---|---|---|---|---|---|
| 0 | <!--v:dr.up73cs24.import.u1+full67-22+71.0.cold.turbopack-->16.3s<!--/v--> | <!--v:dr.up73cs24.import.u1+full67-22+71+73.0.cold.turbopack-->16.1s<!--/v--> | <!--v:dr.up73cs8.import.u1+full67-22+71.0.cold.turbopack-->29.8s<!--/v--> | <!--v:dr.up73cs8.import.u1+full67-22+71+73.0.cold.turbopack-->29.9s<!--/v--> | <!--v:dr.up73cs192.import.u1+full67-22+71.0.cold.turbopack-->18.7s<!--/v--> | <!--v:dr.up73cs192.import.u1+full67-22+71+73.0.cold.turbopack-->18.5s<!--/v--> |
| 1 | <!--v:dr.up73cs24.import.u1+full67-22+71.1.cold.turbopack-->16.2s<!--/v--> | <!--v:dr.up73cs24.import.u1+full67-22+71+73.1.cold.turbopack-->16.5s<!--/v--> | <!--v:dr.up73cs8.import.u1+full67-22+71.1.cold.turbopack-->29.8s<!--/v--> | <!--v:dr.up73cs8.import.u1+full67-22+71+73.1.cold.turbopack-->29.8s<!--/v--> | <!--v:dr.up73cs192.import.u1+full67-22+71.1.cold.turbopack-->18.8s<!--/v--> | <!--v:dr.up73cs192.import.u1+full67-22+71+73.1.cold.turbopack-->19.0s<!--/v--> |

- With new imports on 24 CPUs 73 is longer: after one, <!--v:dr.up73s24.import.u1+full67-22+71.1.warm.turbopack-->9.4s<!--/v--> against <!--v:dr.up73s24.import.u1+full67-22+71+73.1.warm.turbopack-->10.0s<!--/v-->, the builds not
  overlapping; after 10, <!--v:dr.up73s24.import.u1+full67-22+71.10.warm.turbopack-->11.8s<!--/v--> against <!--v:dr.up73s24.import.u1+full67-22+71+73.10.warm.turbopack-->12.8s<!--/v-->, overlapping in one build each. Most of it is
  before emit (<!--v:dr.up73s24.import.u1+full67-22+71.1.warm.preEmit-->6.3s<!--/v--> against <!--v:dr.up73s24.import.u1+full67-22+71+73.1.warm.preEmit-->6.9s<!--/v--> after one new import).
- On 8 CPUs, where the CPU time the gate saves should matter most, 73 is no shorter (after
  one new import <!--v:dr.up73s8.import.u1+full67-22+71.1.warm.turbopack-->13.2s<!--/v--> against <!--v:dr.up73s8.import.u1+full67-22+71+73.1.warm.turbopack-->13.8s<!--/v-->, overlapping; after 10 the same). On 192
  CPUs it is the same within 0.1s with new imports, as expected for traversals that run
  beside the serial chain there.
- Cold builds and warm builds with nothing changed: the same within 0.3s.
- 73 is not taken. Most likely the hash pass, one thread over the whole layer, sits in front
  of every gated query, and the endpoints that reach a changed feature module are most of
  them, so the traversals run again anyway. Not profiled: how many endpoints a new import
  reruns, and how long the hash pass takes.

## After `run-turbopack`: starting the page-data workers

After the compile, `next build` starts its page-data workers (`jest-worker`, one
`child_process.fork` each). Node's libuv (1.51 in Node 22) starts a child on Linux with
`fork()` and then `exec()`, and the parent waits until the child has called `exec()`: the
kernel copies the parent's page tables into the child and the child tears them down again,
all before the next worker can start. The parent here holds Turbopack's heap, so each start
costs time in proportion to that heap, on the main thread, once per worker.

`cache-drift-probes.json` (`processStart`; `scripts/turbopack-gym/process-start-cost.{py,mjs}`,
a dedicated c8gd.48xlarge): starting `/bin/true` from a process holding 0, 1, 4, 8 and 16 GiB
of touched memory takes 1.1, 25, 108, 176 and 295 ms with fork + exec, and 0.3 ms at every size
with `posix_spawn` (glibc's uses `clone(CLONE_VM | CLONE_VFORK)`, no page-table copy). Node's
own `spawnSync` follows fork + exec: 1.0, 24.5, 104, 172 and 291 ms.

Next.js sizes the pool from `os.cpus()` (`experimental.cpus`, the machine's CPUs minus one),
so a build limited to some of the machine's CPUs still starts one worker per machine CPU:
191 here, whatever the build's own CPUs.

- **62 `available-parallelism`** (next, JavaScript): the default is
  `os.availableParallelism() - 1`, the CPUs in the process's affinity mask. Where the
  process may use every CPU the value is unchanged; `CIRCLE_NODE_TOTAL` still wins.
- `bench/turbopack-gym/next-ab-62.json` (`scripts/turbopack-gym/next-ab.mjs`, stock binding,
  drift-monolith on 24 CPUs, 3 reps, warm builds with nothing changed): the worker count is
  part of the config the build writes, so the candidate's output is compared with base given
  `CIRCLE_NODE_TOTAL=24` (the same count by setting): the same. Cold builds:
  <!--v:na.c62.cold.base.wall-->83.7s<!--/v--> → <!--v:na.c62.cold.candidate.wall-->64.2s<!--/v--> (×<!--v:na.c62.cold.ratio-->0.767<!--/v-->), the time after
  `run-turbopack` <!--v:na.c62.cold.base.after-->39.6s<!--/v--> → <!--v:na.c62.cold.candidate.after-->18.9s<!--/v-->; base's after-compile
  time was 28.9s in one rep and 39.7s and 39.6s in the others, the candidate's 17.6 to 19.0s.
  Warm builds: <!--v:na.c62.warm.base.wall-->50.2s<!--/v--> → <!--v:na.c62.warm.candidate.wall-->49.4s<!--/v--> (×<!--v:na.c62.warm.ratio-->0.984<!--/v-->), after
  `run-turbopack` <!--v:na.c62.warm.base.after-->12.1s<!--/v--> → <!--v:na.c62.warm.candidate.after-->11.1s<!--/v-->. A warm build's peak memory (its cgroup, workers included) was
  3.5 to 4.9 GiB against 11.6 to 12.9 GiB for a cold one, so each worker start copies less.

- **Node with libuv's `posix_spawn`.** libuv 1.53.0 starts children on Linux with
  `posix_spawn` (libuv commits 40d45efebf and 49b1c06471); no Node release ships it yet (Node
  22 and 25 have libuv 1.51, 24 and 26 have 1.52.1). Node 22.23.3 built from source twice with
  the same `./configure`, stock and with those two commits applied to its `deps/uv` (the
  binaries' hashes are in the records), measured with `next-ab.mjs --candidate-node` on
  15 + 22 + 55 + 56 + 57 + 59 + 61, drift-monolith, 3 reps (a c9gd.48xlarge), same output:
  - all 192 CPUs, Next.js's default pool (191 workers; `bench/turbopack-gym/next-ab-node-192.json`):
    cold builds <!--v:na.node192.cold.base.wall-->49.8s<!--/v--> → <!--v:na.node192.cold.candidate.wall-->35.1s<!--/v--> (×<!--v:na.node192.cold.ratio-->0.706<!--/v-->), the time after `run-turbopack`
    <!--v:na.node192.cold.base.after-->23.2s<!--/v--> → <!--v:na.node192.cold.candidate.after-->7.2s<!--/v-->; warm builds with nothing changed <!--v:na.node192.warm.base.wall-->13.6s<!--/v--> → <!--v:na.node192.warm.candidate.wall-->11.2s<!--/v-->;
  - 24 CPUs and 23 workers (`next-ab-node-24.json`): cold <!--v:na.node24.cold.base.wall-->35.6s<!--/v--> → <!--v:na.node24.cold.candidate.wall-->29.6s<!--/v--> (×<!--v:na.node24.cold.ratio-->0.834<!--/v-->),
    after `run-turbopack` <!--v:na.node24.cold.base.after-->12.9s<!--/v--> → <!--v:na.node24.cold.candidate.after-->6.8s<!--/v-->; warm <!--v:na.node24.warm.base.wall-->11.4s<!--/v--> → <!--v:na.node24.warm.candidate.wall-->10.8s<!--/v-->.

## Everything together

Base against every binding change that kept the output and won: 15 + 22 + 41 + 42 + 52 + 55 +
56 + 57 + 59 + 61 (`bench/turbopack-graph-drift-full-24.json`, drift-monolith, 24 CPUs, `import`
edits, 2 reps, page-data pool matched to the CPUs, a dedicated c8gd.48xlarge). 60 and 62 change
Next.js's JavaScript and are measured on their own (above), so they are not in these builds.

| new imports | cold wall | warm wall | cold `run-turbopack` | warm `run-turbopack` |
|---|---|---|---|---|
| 0 | <!--v:dr.full24.import.base.0.cold.wall-->63.1s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.0.cold.wall-->35.8s<!--/v--> | <!--v:dr.full24.import.base.0.warm.wall-->48.8s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.0.warm.wall-->17.0s<!--/v--> | <!--v:dr.full24.import.base.0.cold.turbopack-->44.4s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.0.cold.turbopack-->19.1s<!--/v--> | <!--v:dr.full24.import.base.0.warm.turbopack-->37.9s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.0.warm.turbopack-->5.1s<!--/v--> |
| 1 | <!--v:dr.full24.import.base.1.cold.wall-->65.7s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.1.cold.wall-->36.3s<!--/v--> | <!--v:dr.full24.import.base.1.warm.wall-->74.5s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.1.warm.wall-->28.6s<!--/v--> | <!--v:dr.full24.import.base.1.cold.turbopack-->47.9s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.1.cold.turbopack-->18.9s<!--/v--> | <!--v:dr.full24.import.base.1.warm.turbopack-->61.4s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.1.warm.turbopack-->16.6s<!--/v--> |
| 10 | <!--v:dr.full24.import.base.10.cold.wall-->62.4s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.10.cold.wall-->35.8s<!--/v--> | <!--v:dr.full24.import.base.10.warm.wall-->89.0s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.10.warm.wall-->33.3s<!--/v--> | <!--v:dr.full24.import.base.10.cold.turbopack-->44.8s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.10.cold.turbopack-->19.0s<!--/v--> | <!--v:dr.full24.import.base.10.warm.turbopack-->74.2s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.10.warm.turbopack-->19.0s<!--/v--> |
| 1,000 | <!--v:dr.full24.import.base.1000.cold.wall-->64.0s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.1000.cold.wall-->37.2s<!--/v--> | <!--v:dr.full24.import.base.1000.warm.wall-->115.9s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.1000.warm.wall-->37.9s<!--/v--> | <!--v:dr.full24.import.base.1000.cold.turbopack-->45.6s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.1000.cold.turbopack-->19.8s<!--/v--> | <!--v:dr.full24.import.base.1000.warm.turbopack-->100.4s<!--/v--> → <!--v:dr.full24.import.15+22+41+42+52+55+56+57+59+61.1000.warm.turbopack-->21.2s<!--/v--> |

Same output in every build. A warm build is faster than a cold one at 0, 1 and 10 new imports;
at 1,000 its wall time is within a second of the cold build's.

On all 192 CPUs of the same machine type (`bench/turbopack-graph-drift-full-192.json`, 2 reps):

| new imports | cold wall | warm wall | cold `run-turbopack` | warm `run-turbopack` |
|---|---|---|---|---|
| 0 | <!--v:dr.full192.import.base.0.cold.wall-->121.5s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.0.cold.wall-->55.5s<!--/v--> | <!--v:dr.full192.import.base.0.warm.wall-->55.4s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.0.warm.wall-->19.1s<!--/v--> | <!--v:dr.full192.import.base.0.cold.turbopack-->91.6s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.0.cold.turbopack-->24.8s<!--/v--> | <!--v:dr.full192.import.base.0.warm.turbopack-->40.6s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.0.warm.turbopack-->5.5s<!--/v--> |
| 1 | <!--v:dr.full192.import.base.1.cold.wall-->121.9s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.1.cold.wall-->54.1s<!--/v--> | <!--v:dr.full192.import.base.1.warm.wall-->94.3s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.1.warm.wall-->45.0s<!--/v--> | <!--v:dr.full192.import.base.1.cold.turbopack-->92.3s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.1.cold.turbopack-->25.5s<!--/v--> | <!--v:dr.full192.import.base.1.warm.turbopack-->74.3s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.1.warm.turbopack-->22.8s<!--/v--> |
| 10 | <!--v:dr.full192.import.base.10.cold.wall-->122.8s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.10.cold.wall-->53.0s<!--/v--> | <!--v:dr.full192.import.base.10.warm.wall-->116.3s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.10.warm.wall-->49.1s<!--/v--> | <!--v:dr.full192.import.base.10.cold.turbopack-->93.0s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.10.cold.turbopack-->25.3s<!--/v--> | <!--v:dr.full192.import.base.10.warm.turbopack-->89.0s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.10.warm.turbopack-->25.4s<!--/v--> |
| 1,000 | <!--v:dr.full192.import.base.1000.cold.wall-->120.5s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.1000.cold.wall-->51.6s<!--/v--> | <!--v:dr.full192.import.base.1000.warm.wall-->156.2s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.1000.warm.wall-->58.0s<!--/v--> | <!--v:dr.full192.import.base.1000.cold.turbopack-->92.7s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.1000.cold.turbopack-->26.0s<!--/v--> | <!--v:dr.full192.import.base.1000.warm.turbopack-->128.8s<!--/v--> → <!--v:dr.full192.import.15+22+41+42+52+55+56+57+59+61.1000.warm.turbopack-->30.0s<!--/v--> |

Same output in every build. Base's cold `run-turbopack` doubles from 24 to 192 CPUs; with the
changes it grows by about 30%.

## More cores

The same comparison at four CPU counts on one machine: stock v16.4.0 (`base`) against
15 + 22 + 55 + 56 + 57 + 59 + 61, `import` edits, warm and cold, 2 reps, the page-data pool
matched to the CPUs (`bench/turbopack-graph-drift-cores-{24,48,96,192}.json`, a dedicated
c8gd.48xlarge; 192 CPUs is both NUMA nodes). Wall time of the whole build, base → stack:

| CPUs | cold | warm, nothing changed | warm, 1 new import | warm, 1,000 new imports |
|---|---|---|---|---|
| 24 | <!--v:dr.cores24.import.base.0.cold.wall-->63.3s<!--/v--> → <!--v:dr.cores24.import.15+22+55+56+57+59+61.0.cold.wall-->43.2s<!--/v--> | <!--v:dr.cores24.import.base.0.warm.wall-->48.2s<!--/v--> → <!--v:dr.cores24.import.15+22+55+56+57+59+61.0.warm.wall-->15.3s<!--/v--> | <!--v:dr.cores24.import.base.1.warm.wall-->73.2s<!--/v--> → <!--v:dr.cores24.import.15+22+55+56+57+59+61.1.warm.wall-->33.9s<!--/v--> | <!--v:dr.cores24.import.base.1000.warm.wall-->115.4s<!--/v--> → <!--v:dr.cores24.import.15+22+55+56+57+59+61.1000.warm.wall-->43.5s<!--/v--> |
| 48 | <!--v:dr.cores48.import.base.0.cold.wall-->71.6s<!--/v--> → <!--v:dr.cores48.import.15+22+55+56+57+59+61.0.cold.wall-->49.2s<!--/v--> | <!--v:dr.cores48.import.base.0.warm.wall-->50.4s<!--/v--> → <!--v:dr.cores48.import.15+22+55+56+57+59+61.0.warm.wall-->15.9s<!--/v--> | <!--v:dr.cores48.import.base.1.warm.wall-->78.7s<!--/v--> → <!--v:dr.cores48.import.15+22+55+56+57+59+61.1.warm.wall-->34.5s<!--/v--> | <!--v:dr.cores48.import.base.1000.warm.wall-->114.4s<!--/v--> → <!--v:dr.cores48.import.15+22+55+56+57+59+61.1000.warm.wall-->50.1s<!--/v--> |
| 96 | <!--v:dr.cores96.import.base.0.cold.wall-->74.8s<!--/v--> → <!--v:dr.cores96.import.15+22+55+56+57+59+61.0.cold.wall-->52.7s<!--/v--> | <!--v:dr.cores96.import.base.0.warm.wall-->52.0s<!--/v--> → <!--v:dr.cores96.import.15+22+55+56+57+59+61.0.warm.wall-->17.2s<!--/v--> | <!--v:dr.cores96.import.base.1.warm.wall-->78.5s<!--/v--> → <!--v:dr.cores96.import.15+22+55+56+57+59+61.1.warm.wall-->42.3s<!--/v--> | <!--v:dr.cores96.import.base.1000.warm.wall-->120.9s<!--/v--> → <!--v:dr.cores96.import.15+22+55+56+57+59+61.1000.warm.wall-->48.9s<!--/v--> |
| 192 | <!--v:dr.cores192.import.base.0.cold.wall-->124.6s<!--/v--> → <!--v:dr.cores192.import.15+22+55+56+57+59+61.0.cold.wall-->62.6s<!--/v--> | <!--v:dr.cores192.import.base.0.warm.wall-->54.5s<!--/v--> → <!--v:dr.cores192.import.15+22+55+56+57+59+61.0.warm.wall-->19.3s<!--/v--> | <!--v:dr.cores192.import.base.1.warm.wall-->96.5s<!--/v--> → <!--v:dr.cores192.import.15+22+55+56+57+59+61.1.warm.wall-->58.0s<!--/v--> | <!--v:dr.cores192.import.base.1000.warm.wall-->156.4s<!--/v--> → <!--v:dr.cores192.import.15+22+55+56+57+59+61.1000.warm.wall-->64.9s<!--/v--> |

- Cold `run-turbopack`, base → stack: 24: <!--v:dr.cores24.import.base.0.cold.turbopack-->44.8s<!--/v--> → <!--v:dr.cores24.import.15+22+55+56+57+59+61.0.cold.turbopack-->26.4s<!--/v-->; 48: <!--v:dr.cores48.import.base.0.cold.turbopack-->46.6s<!--/v--> → <!--v:dr.cores48.import.15+22+55+56+57+59+61.0.cold.turbopack-->25.1s<!--/v-->; 96: <!--v:dr.cores96.import.base.0.cold.turbopack-->48.9s<!--/v--> → <!--v:dr.cores96.import.15+22+55+56+57+59+61.0.cold.turbopack-->25.7s<!--/v-->; 192: <!--v:dr.cores192.import.base.0.cold.turbopack-->93.0s<!--/v--> → <!--v:dr.cores192.import.15+22+55+56+57+59+61.0.cold.turbopack-->34.1s<!--/v-->.
- Neither gets faster with more CPUs: every column is fastest at 24 or 48 CPUs and slowest
  at 192. Base slows most: at 192 CPUs its graph phase alone takes <!--v:dr.cores192.import.base.0.cold.graph-->39.0s<!--/v--> (cold), against
  <!--v:dr.cores192.import.15+22+55+56+57+59+61.0.cold.graph-->5.6s<!--/v--> with the stack, so the stack's gain grows with the CPU count. The stack's
  own warm build after one new import goes from <!--v:dr.cores24.import.15+22+55+56+57+59+61.1.warm.wall-->33.9s<!--/v--> at 24 CPUs to <!--v:dr.cores192.import.15+22+55+56+57+59+61.1.warm.wall-->58.0s<!--/v--> at 192
  (Open, below).
- Same output in every sweep (each record's outputs match across bindings and modes).

## A larger app

The same comparison on a monolith with twice the routes, features, UI components and utils
(`monolith-gen.mjs --routes 4140 --features 840 --ui 1400 --utils 1000`: 4,141 routes, 31,941
files), 2 reps, page-data pool matched to the CPUs (`bench/turbopack-graph-drift-2x-24.json`,
a dedicated c8gd.48xlarge). Wall time, base → stack:

| CPUs | cold | warm, nothing changed | warm, 1 new import | warm, 1,000 new imports |
|---|---|---|---|---|
| 24 | <!--v:dr.big24.import.base.0.cold.wall-->230.5s<!--/v--> → <!--v:dr.big24.import.15+22+55+56+57+59+61.0.cold.wall-->134.0s<!--/v--> | <!--v:dr.big24.import.base.0.warm.wall-->115.5s<!--/v--> → <!--v:dr.big24.import.15+22+55+56+57+59+61.0.warm.wall-->47.2s<!--/v--> | <!--v:dr.big24.import.base.1.warm.wall-->248.8s<!--/v--> → <!--v:dr.big24.import.15+22+55+56+57+59+61.1.warm.wall-->126.2s<!--/v--> | <!--v:dr.big24.import.base.1000.warm.wall-->350.7s<!--/v--> → <!--v:dr.big24.import.15+22+55+56+57+59+61.1000.warm.wall-->150.2s<!--/v--> |

- Cold `run-turbopack`: <!--v:dr.big24.import.base.0.cold.turbopack-->176.3s<!--/v--> → <!--v:dr.big24.import.15+22+55+56+57+59+61.0.cold.turbopack-->85.3s<!--/v-->, against <!--v:dr.cores24.import.base.0.cold.turbopack-->44.8s<!--/v--> → <!--v:dr.cores24.import.15+22+55+56+57+59+61.0.cold.turbopack-->26.4s<!--/v--> for
  the monolith on the same machine type: twice the app takes about four times as long with
  base and a bit over three times with the stack. The profile below shows where.
- With the stack, a warm build after 1,000 new imports takes longer than a cold one
  (<!--v:dr.big24.import.15+22+55+56+57+59+61.1000.warm.wall-->150.2s<!--/v--> against <!--v:dr.big24.import.15+22+55+56+57+59+61.1000.cold.wall-->134.6s<!--/v-->).

## 52 at 192 CPUs

At 24 CPUs, before 57, 59 and 61, 52 did not change warm builds (above). On all 192 CPUs of the machine, stacked on
15 + 22 + 55 + 56 + 57 + 59 + 61 (`bench/turbopack-graph-drift-52s-192.json`, `import` edits,
2 reps, page-data pool matched to the CPUs), cold and warm `run-turbopack`, stack → stack + 52:

| new imports | cold | warm |
|---|---|---|
| 0 | <!--v:dr.c52s192.import.15+22+55+56+57+59+61.0.cold.turbopack-->33.5s<!--/v--> → <!--v:dr.c52s192.import.15+22+52+55+56+57+59+61.0.cold.turbopack-->28.8s<!--/v--> | <!--v:dr.c52s192.import.15+22+55+56+57+59+61.0.warm.turbopack-->5.6s<!--/v--> → <!--v:dr.c52s192.import.15+22+52+55+56+57+59+61.0.warm.turbopack-->5.4s<!--/v--> |
| 1 | <!--v:dr.c52s192.import.15+22+55+56+57+59+61.1.cold.turbopack-->34.9s<!--/v--> → <!--v:dr.c52s192.import.15+22+52+55+56+57+59+61.1.cold.turbopack-->28.5s<!--/v--> | <!--v:dr.c52s192.import.15+22+55+56+57+59+61.1.warm.turbopack-->31.7s<!--/v--> → <!--v:dr.c52s192.import.15+22+52+55+56+57+59+61.1.warm.turbopack-->26.7s<!--/v--> |
| 10 | <!--v:dr.c52s192.import.15+22+55+56+57+59+61.10.cold.turbopack-->34.6s<!--/v--> → <!--v:dr.c52s192.import.15+22+52+55+56+57+59+61.10.cold.turbopack-->28.5s<!--/v--> | <!--v:dr.c52s192.import.15+22+55+56+57+59+61.10.warm.turbopack-->33.2s<!--/v--> → <!--v:dr.c52s192.import.15+22+52+55+56+57+59+61.10.warm.turbopack-->28.0s<!--/v--> |
| 1,000 | <!--v:dr.c52s192.import.15+22+55+56+57+59+61.1000.cold.turbopack-->34.3s<!--/v--> → <!--v:dr.c52s192.import.15+22+52+55+56+57+59+61.1000.cold.turbopack-->29.3s<!--/v--> | <!--v:dr.c52s192.import.15+22+55+56+57+59+61.1000.warm.turbopack-->37.2s<!--/v--> → <!--v:dr.c52s192.import.15+22+52+55+56+57+59+61.1000.warm.turbopack-->30.7s<!--/v--> |

Same output in every build. Shorter with 52 everywhere except the warm build with nothing
changed, which does almost no work.

A probe on the same machine (`cache-drift-probes.json`, `numaBalancing192`, 3 reps, not a
record) turned the kernel's automatic NUMA balancing off and on around the same builds. Off,
the stack's `run-turbopack` was 2.9s shorter cold and 2.8s shorter warm after one new import
(medians); with 52 in, 0.9s and 0.6s. Same output in every build.

Again at 24 CPUs, now on top of 57, 59 and 61 (`bench/turbopack-graph-drift-52s-24.json`, 3 reps;
this run landed on a c9gd.48xlarge, so its times are not comparable with the c8gd records):
cold `run-turbopack` <!--v:dr.c52s24.import.15+22+55+56+57+59+61.1.cold.turbopack-->21.4s<!--/v--> → <!--v:dr.c52s24.import.15+22+52+55+56+57+59+61.1.cold.turbopack-->18.4s<!--/v--> at one new import; warm
<!--v:dr.c52s24.import.15+22+55+56+57+59+61.1.warm.turbopack-->17.9s<!--/v--> → <!--v:dr.c52s24.import.15+22+52+55+56+57+59+61.1.warm.turbopack-->16.0s<!--/v--> at 1, <!--v:dr.c52s24.import.15+22+55+56+57+59+61.10.warm.turbopack-->20.5s<!--/v--> → <!--v:dr.c52s24.import.15+22+52+55+56+57+59+61.10.warm.turbopack-->17.8s<!--/v--> at 10 and <!--v:dr.c52s24.import.15+22+55+56+57+59+61.1000.warm.turbopack-->23.3s<!--/v--> → <!--v:dr.c52s24.import.15+22+52+55+56+57+59+61.1000.warm.turbopack-->20.7s<!--/v--> at 1,000;
the same with nothing changed. Same output.

## Profiles: 192 CPUs and a larger app

Whole-build profiles of 15 + 22 + 55 + 56 + 57 + 59 + 61 built with frame pointers (`perf`
cpu-clock and `sched_switch`, the build's CPUs, a dedicated c8gd.48xlarge). The perf data is
not kept, so they locate the costs below and no figure here comes from them; the effects are
measured in the records named.

**A warm build after one new import, on all 192 CPUs:**

- Emit runs on most of the machine's cores, and most of that CPU is under
  `client_reference_manifest::build_manifest`. The largest leaf is one atomic add
  (`__aarch64_ldadd8_acq_rel`), the shared operation counter that 52 stripes (52 at 192
  CPUs, above). The next is `TaskStatisticsApi::get`, a load of a field written once, which
  suggests it shares a cache line with that counter.
- The kernel spends CPU migrating pages between the two NUMA nodes (`do_numa_page` →
  `migrate_misplaced_folio`: automatic NUMA balancing; the probe in the 52 section measures
  it), and on write-protect faults (`do_wp_page`) on pages of the build's own heap in emit
  and in the persistence step: the forks of the page-data workers write-protect the parent's
  pages while Turbopack's persistence still writes.
- After `run-turbopack`, the main thread copies and tears down page tables for the worker
  forks (`copy_page_range`, `zap_pte_range` from `exec_mmap`; measured with Node's
  `posix_spawn` above) and compiles the client reference manifests with `require()` for the
  route bundle stats (candidate 60's step).

**A cold build of drift-monolith-2x on 24 CPUs** (the larger app above): much of
`turbopack-write-entrypoints` runs on one core, in `compute_chunk_group_info` (roaring bitmap
`is_subset` and unions) and in the merged-modules reconciliation in `compute_merged_modules`,
the two algorithms `next-limit.md` found single-core on the monolith. They are what 41 and 42
change; 41 + 42 are not in the stack measured above.

## 41 + 42 on the larger app

41 (chunk groups interned) and 42 (merged-module exposure without "before") change the two
single-core algorithms the profile above names (`next-limit.md` describes them; on the monolith
they shortened `run-turbopack` by 11 to 12% on top of 15 + 22). Stacked on 15 + 22 + 55 + 56 + 57 + 59 + 61, on
drift-monolith-2x at 24 CPUs (`bench/turbopack-graph-drift-4142-2x.json`, `import` edits, 2 reps),
`run-turbopack`, stack → stack + 41 + 42:

| new imports | cold | warm |
|---|---|---|
| 0 | <!--v:dr.c4142big.import.15+22+55+56+57+59+61.0.cold.turbopack-->84.1s<!--/v--> → <!--v:dr.c4142big.import.15+22+41+42+55+56+57+59+61.0.cold.turbopack-->66.0s<!--/v--> | <!--v:dr.c4142big.import.15+22+55+56+57+59+61.0.warm.turbopack-->11.6s<!--/v--> → <!--v:dr.c4142big.import.15+22+41+42+55+56+57+59+61.0.warm.turbopack-->11.8s<!--/v--> |
| 1 | <!--v:dr.c4142big.import.15+22+55+56+57+59+61.1.cold.turbopack-->85.9s<!--/v--> → <!--v:dr.c4142big.import.15+22+41+42+55+56+57+59+61.1.cold.turbopack-->65.0s<!--/v--> | <!--v:dr.c4142big.import.15+22+55+56+57+59+61.1.warm.turbopack-->88.9s<!--/v--> → <!--v:dr.c4142big.import.15+22+41+42+55+56+57+59+61.1.warm.turbopack-->68.3s<!--/v--> |
| 1,000 | <!--v:dr.c4142big.import.15+22+55+56+57+59+61.1000.cold.turbopack-->87.0s<!--/v--> → <!--v:dr.c4142big.import.15+22+41+42+55+56+57+59+61.1000.cold.turbopack-->66.5s<!--/v--> | <!--v:dr.c4142big.import.15+22+55+56+57+59+61.1000.warm.turbopack-->99.5s<!--/v--> → <!--v:dr.c4142big.import.15+22+41+42+55+56+57+59+61.1000.warm.turbopack-->81.5s<!--/v--> |

Whole cold builds <!--v:dr.c4142big.import.15+22+55+56+57+59+61.1.cold.wall-->134.3s<!--/v--> → <!--v:dr.c4142big.import.15+22+41+42+55+56+57+59+61.1.cold.wall-->114.3s<!--/v--> at one new import. Same output in every build.

On the monolith (`bench/turbopack-graph-drift-4142.json`, 24 CPUs, 3 reps; a c9gd.48xlarge, so
not comparable with the c8gd records), where the two algorithms take less of the build:
cold `run-turbopack` <!--v:dr.c4142.import.15+22+55+56+57+59+61.0.cold.turbopack-->23.2s<!--/v--> → <!--v:dr.c4142.import.15+22+41+42+55+56+57+59+61.0.cold.turbopack-->20.6s<!--/v--> with nothing changed and <!--v:dr.c4142.import.15+22+55+56+57+59+61.1000.cold.turbopack-->23.3s<!--/v--> → <!--v:dr.c4142.import.15+22+41+42+55+56+57+59+61.1000.cold.turbopack-->19.0s<!--/v--> at 1,000 new
imports; warm <!--v:dr.c4142.import.15+22+55+56+57+59+61.1.warm.turbopack-->17.7s<!--/v--> → <!--v:dr.c4142.import.15+22+41+42+55+56+57+59+61.1.warm.turbopack-->15.9s<!--/v--> at 1, <!--v:dr.c4142.import.15+22+55+56+57+59+61.10.warm.turbopack-->19.9s<!--/v--> → <!--v:dr.c4142.import.15+22+41+42+55+56+57+59+61.10.warm.turbopack-->19.2s<!--/v--> at 10 and <!--v:dr.c4142.import.15+22+55+56+57+59+61.1000.warm.turbopack-->24.1s<!--/v--> → <!--v:dr.c4142.import.15+22+41+42+55+56+57+59+61.1000.warm.turbopack-->20.0s<!--/v--> at 1,000. Same output.

## Open

- After `run-turbopack`, a warm build's wall time has a second part that varies from run to
  run: on instances C and D (`candidatesC`, `candidatesD`), wall minus `run-turbopack` is
  11.4 to 23.1s, most builds near 12s or near 21s, the same configuration landing on either,
  in every access mode. Not explained yet.
- After 59, a warm build's emit stays near <!--v:dr.c59.import.15+22+55+56+57+59.1000.warm.emit-->1.2s<!--/v--> with 1,000 new imports. What is left of the
  warm build's `run-turbopack` is the recomputation before emit (<!--v:dr.c59.import.15+22+55+56+57+59.1000.warm.preEmit-->30.0s<!--/v--> at 1,000, <!--v:dr.c59.import.15+22+55+56+57+59.1.warm.preEmit-->27.5s<!--/v--> with
  one new import). The write phase builds a second set of `pick_endpoint` roots, over the
  compile; its value goes to JavaScript, and nothing measured so far puts time on it.
- That recomputation was mostly `client_reference_manifest::build_manifest` in a profile of
  a warm build with one new import. One new import renames hundreds of content-hashed chunks,
  and about half of the client reference manifests change, each only by those chunk names (a
  probe comparing two cold builds; the profile's and the probe's counts are not kept). 61
  (above) shares the per-reference parts and 64 (above) the async flags; each changed page's
  manifest is still rebuilt whole.
- The rest of the single-core JavaScript after `run-turbopack` is mostly starting the
  page-data workers: fork + exec from a process holding Turbopack's heap (see "starting the
  page-data workers" above; Node with libuv's `posix_spawn` takes the time after
  `run-turbopack` from 23.2s to 7.2s on 192 CPUs). Until Node ships libuv 1.53, Next.js could
  avoid most of it by starting the pool before Turbopack's heap grows; not tried.
  Letting mimalloc use transparent huge pages (`MIMALLOC_ALLOW_LARGE_OS_PAGES=1`, a probe:
  a paired cold A/B of 15 + 22 + 55 + 56 + 57 + 59 on the monolith, 6 reps, not a record)
  changed neither `run-turbopack` (×1.018) nor the time after it.
- With one new import, a warm build's recomputation outside emit takes most of a cold
  build's `run-turbopack` (above): the whole-app analyses rerun.
- 41 + 42 and 52, measured above on top of 15 + 22 + 55 + 56 + 57 + 59 + 61, are not in the
  canonical run. 52's slower graph phase in its first A/B on the monolith (cold, on 15 + 22
  alone) is not explained yet.
- In the 192-CPU profile (without 52), the leaf after the counter's atomic add is
  `TaskStatisticsApi::get`, a load of a field written once; it may share a cache line with the
  counter that 52 stripes. Not profiled with 52 in.
- On the larger app, a warm build after 1,000 new imports is still slower than a cold one, and
  the whole-app analyses (module graph, chunk groups, merged modules) rerun in full after any
  new import.
- `drift.mjs` restores an interrupted sweep's tree when the next sweep on that app starts; it
  has no restore command of its own.

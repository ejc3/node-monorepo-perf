# Persistent Cache Against Changed Files

The second observation in vercel/next.js#98043: a `next build` that restores Turbopack's
persistent cache gets slower as more source files change since the cached build, until it is
slower than building cold. This note is the method, what the profiles show, and the
candidates that came out of it. Every number here was measured on dedicated 192-core boxes
(no other gym work on them):

- `bench/turbopack-graph-drift.json`: the drift sweeps, base and candidate 55, on a
  c8gd.48xlarge, one build at a time on 24 of its CPUs, the gym root on btrfs over the
  instance's local NVMe drives.
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
  N = 1,000 ran 107.5s, 71s of it after `run-turbopack` and 33s longer than its other rep,
  almost all of that after `run-turbopack`; not explained. The median is the mean of the two.


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

## Open

- After `run-turbopack`, a warm build's wall time has a second part that varies from run to
  run: on instances C and D (`candidatesC`, `candidatesD`), wall minus `run-turbopack` is
  11.4 to 23.1s, most builds near 12s or near 21s, the same configuration landing on either,
  in every access mode. Not explained yet.
- New imports change the module graph, so a warm build reruns the whole-app analyses on
  task state read back from the cache; after many edits an earlier profile (on a shared box,
  discarded) showed a long single-threaded collectibles update. Not re-profiled on a
  dedicated box yet; not a candidate.
- 55 and 52 are not in the canonical run. 52's slower graph phase on the monolith is not
  explained yet.
- `drift.mjs` restores an interrupted sweep's tree when the next sweep on that app starts; it
  has no restore command of its own.

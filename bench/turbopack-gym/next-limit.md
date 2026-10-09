# The Next Serial Limit After 15 + 22

Starting point: v16.4.0 + `15-graph-algos-combined` + `22-sharded-runner-2choice` (next.js
branch `gym/c1522`, the same diff as binding `15+22`). Question: what is still serial in
`turbopack-write-entrypoints` (and the rest of `run-turbopack`), and can it be shortened with
the same output. Two candidates, `41-chunk-groups-interned` and `42-merged-local-exposure`,
both patches against `gym/c1522`.

All numbers below are from runs on the local 96-core box (r8gd.metal-24xl, one NUMA node)
with other tenants on other CPUs; run ids are under `$GYM_ROOT/runs`.

## Attribution with 15 + 22

Profile: `profile.mjs --binding c1522-fp --fp --offcpu --cpus 0-23` (frame-pointer build of
`gym/c1522`), run `muz9esbu-b7bb8d`, perf data `runs/profile-muz9eqtw`. Phases: graph 4.50s,
write-entrypoints 14.64s, emit 15.84s, run-turbopack 32.02s. On-CPU samples bucketed by
0.25s; "serial" = under 2.5 cores busy.

| window (s into write-entrypoints) | cores | what runs |
|---|---|---|
| 5.25–7.75 (2.5s) | 1.0–1.4 | `compute_chunk_group_info` (claimed inline by `compute_module_batches`): 1.85s of the 2.17s in module batches; `roaring::Store::is_subset` alone 1.34s |
| 8.50–10.75 (2.25s) | 1.0 | `compute_merged_modules` "reconciliation" loop: 2.16s; hashbrown set iteration (`Keys::fold`) ~0.8s and set inserts/rehash ~0.5s from building the before/common/after sets per split, `IndexSet<ListOccurrence>` swap_remove/insert ~0.6s |
| 3.5–5.0 (graph phase tail) | 3–11 | not serial: per-endpoint `get_server_actions_for_endpoint` DFS, `additional_entries`, side-effect info |
| emit, last ~4.5s | 6 avg, then ~1 | 27.5 core-s, of which 19.3s in turbo-tasks-backend `connect_children` → `inner_of_upper_has_new_follower` → `AggregatedDataUpdate::apply`; `update_aggregated_collectibles` 8.4s, `AutoMap<CollectibleRef, i32>` insert 6.3s / get 4.3s; then disk writes |

So about 4.75s of the 14.64s write-entrypoints is one core: the chunk-group fixed point and
the merged-modules reconciliation.

Counts from a diagnostic build (counters only, not a candidate; run `muza8p7s-799f46`,
monolith, same output fingerprint `3208a0a74bc57875`):

- `compute_chunk_group_info`: 28,390 module nodes, 15,001 chunk groups, 66,625 node visits,
  892,771 inheriting-edge visits: 20,090 first visits (clone), 528,592 unchanged (of which
  328,905 with an equal bitmap), 344,089 unions. Those 872,681 non-first checks are over only
  34,343 distinct (parent bitmap, child bitmap) pairs; 22,654 distinct bitmaps are created and
  8,282 remain. Parent bitmaps average 932 ids, all array containers.
- merged-modules reconciliation: 21,760 modules in lists, 5,229 splits over 4,466,678 list
  occurrences (about 854 per split). Building the per-occurrence sets visits 36,400,538 list
  entries of "before", 5,399,713 of "common", 3,602,438 of "after": four fifths of the work is
  the "before" parts, which a split does not change.

## 41-chunk-groups-interned

`compute_chunk_group_info` keeps each module's chunk groups as the id of an interned bitmap
(`FxIndexSet<RoaringBitmapWrapper>`), and memoizes `merge(from, into) -> Option<union id>`
per id pair: the subset test (`is_proper_superset`, on contents) and the union run once per
distinct pair, a repeat is a hash lookup, and `from == into` is answered without one. The
traversal makes the same Continue/Skip decision on every edge, priorities read the same
lengths, and the final `ModuleToChunkGroups` holds the same bitmaps, so visit order,
chunk-group ids and everything after are unchanged. The interner's equality on the bitmap
representation only affects sharing, never a decision.

## 42-merged-local-exposure

In the reconciliation, a split of a list into before/common/after exposes every module with
an intra-group reference crossing two parts. 42 computes the same set without collecting
"before":

- a reference crossing a split has an end in "common" or "after", so only the references and
  referrers (`intra_group_references` reversed once) of those modules are looked at;
- where the other end sits is read from its occurrences, now keyed `(chunk group, list) ->
  entry` (`FxIndexMap`, same insertion and swap_remove order as the `IndexSet<ListOccurrence>`
  it replaces), or, for a module already popped, from its settled position (a popped module
  never moves again: the original loop errors if it would);
- for "common", a reference to a module outside it crosses in every list holding both, so
  it is one intersection test of the module's occurrences with the split's, once per split
  instead of once per occurrence; "after" is checked per occurrence against the list;
- a module already exposed is not looked up again.

The lists, their order and the exposed set are the same as before.

## A/B (A = 15+22)

Smoke, quick app, lanes 24-47:48-71, 2 reps:

```
[ab] smoke-41: turbopack 5.2325s -> 5.1135s (x0.9772), cores 11.355 -> 11.385, turbopack x0.9772, output same => no
[ab] smoke-42: turbopack 5.49s -> 5.343s (x0.9732), cores 11.17 -> 10.975, turbopack x0.9732, output same => no
```

Monolith, 6 reps, `--metric turbopack`, lanes 24-43:44-63 (two 20-core lanes: CPUs 0-23 and
64-95 were held by other runs' locks for the whole period). Phase ratios are the geometric
mean of B/A over the reps from the runs' `run.json`.

| B | run-turbopack | swap pairs | graph | write-entrypoints | emit | output |
|---|---|---|---|---|---|---|
| 41 | 33.08s → 31.89s, **0.962** | 0.961, 0.953, 0.972 | 1.002 | 0.896 (15.28s → 13.70s) | 1.024 | same |
| 42 | 32.50s → 31.60s, **0.965** | 0.964, 0.984, 0.946 | 1.012 | 0.895 (15.17s → 13.62s) | 1.030 | same |
| 41 + 42 | 33.07s → 29.52s, **0.883** | 0.866, 0.895, 0.888 | 0.998 | 0.770 (15.22s → 11.73s) | 0.981 | same |
| 41 + 42, final patches | 33.02s → 29.32s, **0.892** | 0.913, 0.866, 0.897 | 0.996 | 0.773 (15.29s → 11.79s) | 0.996 | same |

```
[ab] verdict-41: turbopack 33.0845s -> 31.887s (x0.9622), cores 12.719999999999999 -> 13.45, turbopack x0.9622, output same => no
[ab] verdict-42: turbopack 32.498000000000005s -> 31.599s (x0.9648), cores 12.68 -> 13.465, turbopack x0.9648, output same => no
[ab] verdict-41+42-r2: turbopack 33.073s -> 29.524s (x0.8829), cores 12.695 -> 14.11, turbopack x0.8829, output same => WIN
[ab] verdict-41+42-final: turbopack 33.022999999999996s -> 29.314999999999998s (x0.8918), cores 12.735 -> 14.105, turbopack x0.8918, output same => WIN
```

Each alone moves write-entrypoints by about a tenth, under the 6% bar on run-turbopack; the
two serial stretches are sequential, so the pair is what shortens the compile.

The first 41 + 42 A/B (`verdict-41+42`, x0.9153) reported "output DIFFERENT" in one of six
reps (B run `muzbvp60-837aaa` vs A `muzbvp70-502a3f`, both kept). With the gym's normalizer,
17 route-handler chunks differ, all at one spot: a minified local inside a template literal,
`` `Unexpected root span type '${r.get(...)}'...` `` vs `${a.get(...)}`. The normalizer
replaces one- and two-character identifiers outside string literals, and treats the
`'...'` inside the template as a string, so this name survives normalization. Replacing
identifiers inside `${...}` as well, the two outputs match in all 41,857 files. The mangled
names in that chunk also vary between builds of the unchanged `base` binding (kept base
outputs `muzbmz5z-410140` and `muzbrm0g-aa1f3d` differ by local-name permutations in
`server/chunks/_00bxcj7gsbtg1._.js`), i.e. this is the minifier's existing per-build naming
hitting a normalizer gap, not a change in the build. The rerun (`verdict-41+42-r2`) matched
in all six reps. Tooling follow-up: normalize identifiers inside template-literal
substitutions in `bench.mjs`'s `normalizer`.

The 42 binding and the binding of the first two 41 + 42 A/Bs were built before rustfmt and
an added `#[allow(clippy::type_complexity)]`; the 42 patch differs from them only in
whitespace, trailing commas and that attribute (checked by comparing the sources with
comments, whitespace and trailing commas removed). The 41 binding and the "final patches"
41 + 42 binding (module hash `98a6e930851bb994`) are built from the committed patches. One
earlier attempt at the final A/B stopped with a build error (run `muzdmrsx-b7067a`, a
missing directory under the app's `node_modules`) at a time the app directory's files were
being rewritten (their mtimes); the rerun's app tree hash is the same as every other row's.

## What is left after 41 + 42

Profile of the 41 + 42 stack (frame-pointer build, run `muzbk3m4-9ce099`, `--cpus 72-95`,
perf data `runs/profile-muzbk24p`; same output fingerprint): write-entrypoints 11.80s,
run-turbopack 30.23s. The single-core stretches are now:

- 1.0s: `compute_module_batches` 0.66s (its own pre-batching, diffuse hash-map work, plus
  `compute_chunk_group_info` 0.25s; `is_subset` is 0.30s of the window), alongside
  per-endpoint `next_api` graph queries on another core or two;
- 0.5s: the reconciliation's occurrence bookkeeping (`IndexMap` swap_remove/insert 0.21s,
  `split_off`), which moves every "after" entry on every split;
- the emit tail is unchanged: 24.3 core-s over 3.7s, 17.8s of it in turbo-tasks-backend
  `connect_children` aggregation (`update_aggregated_collectibles` 7.6s, `AutoMap` insert
  6.0s / get 4.0s). That is the next target, in turbo-tasks-backend rather than the graph
  algorithms.

## Tests

On the 41 + 42 stack and on 41 and 42 separately (`--profile release-with-assertions`, so the
new `debug_assert_eq!`s on occurrence removal run; JS deps installed with `pnpm install` for
the execution tests):

- `cargo test -p turbopack-core`: 165 passed, 2 ignored.
- `cargo test -p turbopack-tests`: execution 315 passed, snapshot 132 passed, react_compiler
  3 passed.
- `cargo clippy -p turbopack-core --all-targets -- -D warnings -A deprecated` on base + 15 +
  41 + 42: clean. (On `gym/c1522` clippy stops earlier, at `type_complexity` in 22's
  `priority_runner.rs`.)
- nightly rustfmt `--check` on both files: clean.

## Recommendation

Stack both: 41 + 42 on top of 15 + 22 (run-turbopack 0.883 and 0.892 in two A/Bs,
write-entrypoints 0.770 and 0.773, graph phase unchanged, same output). They touch different files and are independent; neither alone clears the 6% bar.

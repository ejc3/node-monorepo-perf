# Upstream Readiness: Patches 11 and 22

Patches 11 (`compute_binding_usage_info` in topological order) and 22 (sharded
`PriorityRunner` queue) pass next.js's own Rust checks and match v16.4.0 case by case on a
113-run Turbopack integration subset (v16.4.0 itself fails 2 of those cases). Patch 11 is
ready as benchmarked. Patch 22 failed `cargo fmt --check` and clippy as benchmarked; two
follow-up commits fix that without changing behavior. The tie-break in
`traverse_edges_fixed_point_with_priority` does not do what its comment says, but flipping it
changes the build output, so it is not a drop-in one-line fix (see
[The Heap Tie-Break](#the-heap-tie-break)). Reading the code for this review also turned up
an order-dependent case in `compute_binding_usage_info` on v16.4.0
([Partial Namespace Provenance](#partial-namespace-provenance)). Data:
`bench/turbopack-gym/upstream-readiness.json` (this review), `bench/turbopack-graph-ab.json`
(the canonical A/B record).

## Patches

| | commits on v16.4.0 | file |
|---|---|---|
| 11 | 1 (the benchmarked patch, unchanged) | `candidates/11-binding-usage-topo.patch` |
| 22 | 3: the benchmarked patch, `rustfmt`, clippy fixes | `upstream/22-sharded-runner-2choice.patch` |
| heap tie-break (experiment) | 1: comparator flip, test update, new test | `upstream/heap-order-tie-break.patch` |

Paths are relative to `bench/turbopack-gym/`; PR drafts are `upstream/pr-11-binding-usage-topo.md`
and `upstream/pr-22-sharded-runner.md`. The JSON's `bindings` field ties each measured binding
to its source: module id and the hash of its diff against v16.4.0. For 11 and the heap
tie-break those diff hashes equal the patch files' (`patches`); for 22 the measured binding is
the benchmarked revision (the diff hash in `bench/turbopack-gym/bindings.json`), and the two
follow-up commits change formatting, a type alias and test code only. All three branches
merge onto `canary` of 2026-10-07 without conflicts, and no commit since v16.4.0 touches the
three patched files (`canaryMerge`).

## Rust Checks

The repo's commands from `packages/next-swc/package.json` (`rust-check-fmt`,
`rust-check-clippy`, `rust-check-napi`, `test-cargo-unit`), with clippy and the tests limited
to the touched crates and the crates that depend on them:

```bash
cargo fmt -- --check
cargo clippy -p turbo-tasks -p turbopack-core --all-targets -- -D warnings -A deprecated
cargo clippy -p turbo-tasks --all-targets --features inline_execution_stats -- -D warnings -A deprecated
cargo check -p next-napi-bindings
cargo nextest run -p turbo-tasks -p turbo-tasks-backend -p turbopack-core -p turbopack \
  -p turbopack-ecmascript -p turbopack-tests -p next-core -p next-api \
  --cargo-profile release-with-assertions --no-fail-fast
cargo test <same -p list> --doc --profile=release-with-assertions --no-fail-fast
```

`turbo-tasks-backend`'s dev-dependency enables `inline_execution_stats` on `turbo-tasks`, so
the second clippy line covers the feature-gated code patch 22 touches. `turbopack-tests`
holds the snapshot tests (fixtures such as `basic-tree-shake`, `export-alls`,
`remove-unused-imports`, `scope-hoisting`) and the execution tests.

| | fmt | clippy | clippy + stats | check napi | nextest | doctests |
|---|---|---|---|---|---|---|
| base | pass | pass | pass | pass | 1713/1713 | 8 pass, 0 fail |
| 11 | pass | pass | pass | pass | 1713/1713 | 8 pass, 0 fail |
| 22 as benchmarked | **fail** | **fail** | **fail** | pass | 1718/1718 | 8 pass, 0 fail |
| 22 final | pass | pass | pass | not rerun | 394/394, `turbo-tasks` + `turbo-tasks-backend` only | not rerun |

Base and 11 ran every row; the final revision of 22 reran the checks its follow-up commits
can affect. Patch 22's clippy errors were `type_complexity` on the `shards` field (fixed with a
`Shard<P, T>` alias) and `manual_is_multiple_of` at two sites in its new test; its formatting
diff was in `priority_runner.rs` only. Its five extra nextest tests are the ones it adds. No
check failed on base.

## Integration Tests

The JS packages of v16.4.0 were built once (`pnpm install`, `pnpm build`). For each binding
the module was placed in `packages/next-swc/native`, where the test harness points
`NEXT_TEST_NATIVE_DIR` for every isolated test app. Every file ran as its own jest process,
8 files at a time, no retries:

```bash
IS_TURBOPACK_TEST=1 NEXT_TEST_MODE=<start|dev> HEADLESS=true \
  node_modules/.bin/jest --runInBand --forceExit --no-cache --json <test file>
```

The subset (`integration.list` in the JSON, 113 file runs: 55 `start`, 58 `dev`):

- **Tree shaking, side effects, barrels (patch 11), `start`:** `test/production/`
  `remove-unused-imports`, `app-dir/actions-tree-shaking` (11 files), `barrel-optimization`,
  `client-components-tree-shaking`, `optimize-package-imports-side-effects`,
  `reference-tree-shaking`, `re-export-all-exports-from-page-disallowed`,
  `standalone-mode/tracing-side-effects-false`, `typescript-checked-side-effect-imports`,
  `optimize-server-react`, and the Turbopack chunking and module-graph tests
  (`turbopack-chunking`, `turbopack-chunking-removed-config`,
  `turbopack-collect-multiple-entries`, `turbopack-module-graph-cycle`,
  `turbopack-non-placeable-import`, `turbopack-shared-runtime-async-module`,
  `turbopack-chunk-loading-global`).
- **e2e in both `start` and `dev`:** `app-dir/app` (5 files), `app-dir/actions` (server
  actions, 8 files), `rsc-basic`, `css-order`, `treeshake-mw`, `dynamic-import-tree-shaking`,
  `client-reference-reexport-unused`, `client-reference-side-effects`,
  `reexport-client-component-metadata`, `turbopack-tree-shaking-chunkgroup`,
  `actions-unused-args`, `turbopack-tree-shaking-pages`, `turbopack-emit-collect`,
  `import-attributes`.
- **Dev HMR and concurrency (patch 22), `dev`:** `test/development/basic/hmr` (16 files),
  `app-hmr`, `app-dir/turbopack-reexport-hmr`, `hmr-move-file`, `hmr-deleted-page`,
  `hmr-shared-css`, `server-hmr`, `hmr-refetch-coalescing`, `hmr-rsc-cancellation`,
  `hmr-dep-accept`, `layout-dynamic-import-hmr`, `basic/barrel-optimization`.

| binding | passed | failed | skipped | todo |
|---|---|---|---|---|
| base | 1568 | 2 | 43 | 126 |
| 11 | 1568 | 2 | 43 | 126 |
| 22 (as benchmarked) | 1568 | 2 | 43 | 126 |

Of 1,724 distinct test cases, none has a different status under 11 or 22 than under base. The
two failures are the same on all three bindings and failed again in two serial reruns of each
file on each binding (`integration.serialReruns`), so they are failures of v16.4.0 in this
setup, not of the patches:

- `test/development/app-hmr/hmr.test.ts`: "can navigate cleanly to a page that requires a
  change in the Webpack runtime" (the expected `[Fast Refresh] done in` log never arrives).
- `test/development/app-dir/server-hmr/server-hmr.test.ts`: "only evaluates the last visited
  page when a shared module changes" (the set of re-evaluated pages is empty instead of
  page 2).

## Dev Mode, Patch 22

`next dev` on a copy of the generated 401-route `quick` app, 3 rounds alternating base and 22,
on 32 CPUs (`devCheck22` in the JSON). Each round cold-compiles 5 routes, compiles 80 more
with 16 requests in flight, runs 6 edit cycles on three layers that page `p76` depends on (the
page, the server feature component `f76/m29`, the client component `C023` behind the `@/ui`
`export *` barrel) polling until each edit is visible, and then reverts the edits.

- **Correctness.** All 744 responses across the 6 rounds were 200, and every page's visible
  text (HTML with scripts, styles and tags stripped) hashed the same as base's, step by step
  and route by route. Neither server logged an error line.
- **Timing** (per round, base → 22): 5 cold routes 4.51–4.69 s → 3.92–4.03 s; 80-route burst
  10.62–11.42 s → 9.42–9.90 s. Median edit-to-visible latency over 18 edits per layer: page
  253 → 247 ms, server component 204 → 202 ms, barrel'd client component 253 → 259 ms.

## The Heap Tie-Break

`traverse_edges_fixed_point_with_priority` (`turbopack/crates/turbopack-core/src/module_graph/mod.rs`)
orders its `BinaryHeap` by priority, then `self.visit_order.cmp(&other.visit_order)`. A
max-heap pops the greatest element, so among equal priorities the most recently discovered
node is taken first: with all priorities equal the traversal is depth-first. The comment next
to it, and the commit that introduced it (vercel/next.js#87252, "if priorities are ambiguous
we revert to a BFS order"), describe the reverse. The test added in that commit,
`test_traverse_edges_fixed_point_no_priority_is_bfs`, pins the sibling order the comparator
produces, but its graph has only two levels below the entry, too shallow to show whether a
deeper node can come before a shallower one.

The experiment branch flips the comparator to `other.visit_order.cmp(&self.visit_order)`,
updates that test's expected order, and adds
`test_traverse_edges_fixed_point_no_priority_is_bfs_deep` (a graph where depth-first and
breadth-first orders differ). With only the comparator reverted, both tests fail; with the
flip, `turbopack-core`, `turbopack`, `turbopack-tests` and `next-core` pass 710/710 with no
snapshot updates (`rust.heap-order`). Its four callers are `compute_binding_usage_info`,
`compute_chunk_group_info`, `merged_modules.rs` and `collect.rs`.

The flip alone, A/B against base on two 16-core lanes (`heapOrder` in the JSON; binding
`heap-order`, whose diff hash equals `upstream/heap-order-tie-break.patch`):

| B (A = base) | app | reps | graph phase | ratio | swap pairs | run-turbopack | same fingerprint |
|---|---|---|---|---|---|---|---|
| tie-break flip | monolith | 6 | 10.14 s → 6.03 s | 0.602 | 0.604, 0.602, 0.599 | 0.903 | **no** |
| 11 | monolith | 6 | 10.20 s → 6.02 s | 0.586 | 0.593, 0.583, 0.582 | 0.910 | yes |
| tie-break flip | quick | 2 | 1.98 s → 1.86 s | 0.942 | 0.942 | 0.992 | **no** |

- **Performance.** On the monolith the flip shortens the graph phase about as much as patch 11
  on the same lanes. `compute_binding_usage_info` passes the same priority for every module,
  so its order is decided entirely by the tie-break; patch 11 replaces that with explicit
  priorities.
- **Output.** The flip changes the build output on both apps: on the monolith 112 of 41,857
  emitted files are chunks whose normalized content differs, plus 7 source maps. Every
  differing chunk holds the same module ids as a chunk of base; what changes is the member
  order of scope-hoisted merged module groups and the order of their hoisted imports, which
  is the order those imports run in when the group's code runs. The lists inside merged
  groups are built by a separate DFS per chunk group, and the order in which chunk groups are
  reconciled follows the chunk-group numbering, which `compute_chunk_group_info` assigns in
  its fixed-point visit order and so through this comparator. That is the likely path from
  the comparator to the output; it was not traced further. In one inspected case on the `quick` app, base imports the JSX
  runtime and `react` before `u147`, as `C017`'s source imports them; with the flip `u147` and
  its imports come first.

Verdict: the comparator, its comment and its test disagree, but the one-line flip is not
output-neutral; it changes the emitted import order inside scope-hoisted groups, which is for
the Turbopack maintainers to decide. Patch 11 obtains the same graph-phase reduction with an
unchanged fingerprint and does not depend on the tie-break. Upstream, either correct the comment
and the test name to describe the depth-first order (no behavior change), or propose the flip
as its own change together with the merged-modules ordering question; it should not ride along
with patch 11.

## Partial Namespace Provenance

In `compute_binding_usage_info` the used-export sets only grow (`add` and `add_usage_info` are
joins), so they reach the same fixed point in any visit order. `partial_namespace_modules`
does not take part in that: a `PartialNamespaceObject` edge inserts its target there, but the
insertion is not counted in `changed`. If the target was already popped and the edge adds no
new export name, the visitor returns `Skip`, and the target's `export *` (passthrough)
children do not receive the marker, which `BindingUsageInfo::used_exports` reports as
`namespace_object_may_escape`, unless a later change revisits the target. Whether that
happens depends on the visit order. Under patch 11 a module outside a cycle is popped only
after all of its importers have reached it, which makes the case less likely, but an update
arriving late from a cycle can still reach an already-popped module. This was found by reading the
code; no reproducer was built. The fix is to count the insertion in `changed`, as a separate
change with its own test.

## Reproduce

The scripts that drove the test runs and the dev check are not part of the gym. The gym parts:

```bash
node scripts/turbopack-gym/build.mjs upstream-heap            # binding from the experiment worktree
node scripts/turbopack-gym/ab.mjs --a base --b upstream-heap --lanes <a>:<b> --app monolith --reps 6
node scripts/turbopack-gym/ab.mjs --a base --b 11 --lanes <a>:<b> --app monolith --reps 6
```

# turbopack: visit modules in topological order in compute_binding_usage_info

## What

`compute_binding_usage_info`
(`turbopack/crates/turbopack-core/src/module_graph/binding_usage_info.rs`) walks the
whole-app module graph in one sequential fixed-point loop,
`traverse_edges_fixed_point_with_priority`, with the same priority (`0`) for every module. This
change first runs one DFS from the chunk group entries and records each module's post-order
index, then passes that index as the module's priority. The traversal pops the highest
priority first, so outside of cycles a module is popped after the modules that import it.

## Why

With equal priorities the visit order is the heap's tie-break, which takes the most recently
discovered module first. In that order a module is often popped before all of its importers
have contributed their used exports, and it is queued and popped again, its outgoing edges
visited again, after later importers add more. For a widely imported barrel with many `export *` re-exports, each
such pass copies the barrel's export set along every `export *` edge again. In topological
order a module's importers outside cycles have all reached it before it is popped.

The used-export sets only grow (`add` / `add_usage_info` are unions), so they reach the same
fixed point in any order. One piece of state does not: a `PartialNamespaceObject` edge marks
its target in `partial_namespace_modules`, but that insertion is not counted in `changed`. If
the target was already popped and its used exports do not change, its `export *` children do
not receive the marker unless a later change revisits the target. That is order-dependent on
v16.4.0 as well. With this change a module outside a cycle is popped after its importers have
reached it, which makes the case less likely, but an update arriving late from a cycle can
still reach an already-popped module. It is better fixed on its own (count the insertion in
`changed`).

## Measured effect

On a generated App Router app shaped like #98043 (2,071 routes, 16,068 TypeScript files, a
700-component UI kit and a 500-module util layer behind `export *` barrels), `next build
--experimental-build-mode=compile`, A and B built side by side on two 24-core lanes, 6 reps
(`bench/turbopack-graph-ab.json` in the node-monorepo-perf bench repo, label `11`):

- `turbopack-module-graph` phase: 13.05 s → 8.98 s, **0.683×** (swap pairs 0.693, 0.687,
  0.669); cores busy in the phase 9.6 → 13.8.
- `run-turbopack`: 45.43 s → 40.91 s, 0.894×.
- Output: the same fingerprint as v16.4.0 (every emitted file except cache and trace files and
  `server/preview-props.json`, compared after normalizing per-build hashes, chunk file names and
  minified identifiers).

On two 16-core lanes the same comparison gives 0.586× (10.20 s → 6.02 s) on the graph phase and
0.910× on `run-turbopack`, same fingerprint (`bench/turbopack-gym/upstream-readiness.json`,
`heapOrder.ab11SameLanesMonolith`). Visit counts were not recorded.

## Testing

On v16.4.0 with and without this change (`bench/turbopack-gym/upstream-readiness.md`):

- `cargo fmt -- --check`; `cargo clippy -p turbo-tasks -p turbopack-core --all-targets -- -D
  warnings -A deprecated`; `cargo check -p next-napi-bindings`: pass.
- `cargo nextest run` over `turbo-tasks`, `turbo-tasks-backend`, `turbopack-core`, `turbopack`,
  `turbopack-ecmascript`, `turbopack-tests`, `next-core`, `next-api`
  (`release-with-assertions`): 1713/1713, the same as without the change. This includes the
  `turbopack-tests` snapshot tests (among them `basic-tree-shake`, `export-alls`,
  `remove-unused-imports`, `scope-hoisting`), which pass without snapshot updates.
- 113 Turbopack integration test runs (tree shaking, side effects, barrel optimization,
  server actions, `app-dir/app`, HMR; `start` and `dev`): 1568 passed, 2 failed, identical
  case by case to v16.4.0, which fails the same 2 cases.

## Risks

- Ordering: the `partial_namespace_modules` case above; this change makes it less likely but
  does not fix it.
- Memory: one `FxHashMap<module, u32>` over all reachable modules for the duration of the
  call, plus one extra DFS over the graph.
- A module reached through a `VisitedModule` node in a later graph layer keeps the first
  post-order index it got, which is already after all of its DFS descendants.

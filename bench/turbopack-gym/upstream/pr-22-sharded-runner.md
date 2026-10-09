# turbo-tasks: shard the PriorityRunner queue

## What

`PriorityRunner` (`turbopack/crates/turbo-tasks/src/priority_runner.rs`) keeps every task that
is not running yet in one `parking_lot::Mutex<Queue>`. Every `schedule`, every `claim` (a
reader taking a queued task to run inline) and every worker picking up its next task takes
that lock.

This change splits the queue into shards:

- **Shard count:** one shard below 8 workers (exact priority order, as before); otherwise
  `(workers / 4).next_power_of_two()`, at most 64 (8–11 workers: 2 shards, 32: 8, 96: 32).
  Each shard is a `CachePadded<Mutex<Queue>>` (128-byte alignment).
- **Placement:** an item with a claim key goes to the shard its key hashes to, so `claim` locks
  exactly one shard. Items without a key rotate over the shards with a per-thread cursor.
- **Pop:** an `AtomicU64` bitmask records which shards are non-empty; a bit changes only under
  its shard's lock, when the shard goes from empty to non-empty or back. A worker starts at a
  rotating offset, locks the first non-empty shard, `try_lock`s the next non-empty one, and
  takes the higher-priority head of the two; if the `try_lock` fails it takes the first
  shard's head. It never waits for a second lock. Priority order is exact within a shard and
  approximate across shards.
- **No lost work:** after a push, the shard's bit is set (by this push or an earlier one), and
  the pusher then reads the active worker count; a worker that stops decrements the count
  and then checks for capacity and queued work. All of these are `SeqCst`, so a push and a
  decrement that frees capacity cannot both miss each other: at least one of them sees queued
  work with a free slot and spawns a worker (`spawn_worker_for_queued_work`).
- **Queue internals:** `Queue` keeps a live-item count, so emptiness no longer depends on
  tombstones; a drained shard resets its heap and slots.

## Why

On v16.4.0 the whole-app module graph phase takes longer at 24 to 96 cores than at 16, and
28.8–43.7% of its CPU time there is kernel time (`bench/turbopack-graph-scaling.json`). Capping
turbo-tasks at 16 worker threads on a 24-core lane makes the phase shorter, 0.764×
(`bench/turbopack-graph-ab.json`, label `workers-16`). Both are consistent with contention on
the single queue lock, which every scheduling operation takes; lock wait time itself was not
measured.

## Measured effect

Same app and method as the record (`bench/turbopack-graph-ab.json` in the node-monorepo-perf
bench repo, label `22`; a generated App Router app shaped like #98043, `next build
--experimental-build-mode=compile`, A and B side by side on two 24-core lanes, 6 reps):

- `turbopack-module-graph` phase: 12.72 s → 8.66 s, **0.677×** (swap pairs 0.664, 0.697,
  0.669).
- `run-turbopack`: 45.48 s → 40.23 s, 0.880×.
- Output: the same normalized fingerprint as v16.4.0.

`next dev` on the generated 401-route app on 32 CPUs, 3 rounds alternating with v16.4.0
(`bench/turbopack-gym/upstream-readiness.json`, `devCheck22`): all 744 responses 200 with the
same visible page text as v16.4.0, step by step and route by route. Per round, 5 cold routes
took 4.51–4.69 s on v16.4.0 and 3.92–4.03 s with the change, and 80 routes with 16 requests
in flight 10.62–11.42 s and 9.42–9.90 s. Median edit-to-visible latency over 18 edits per
layer: page 253 → 247 ms, server component 204 → 202 ms, client component behind an `export *`
barrel 253 → 259 ms.

The measurements used the change as first written; the version here adds a `rustfmt` pass and
two clippy fixes (a type alias, `is_multiple_of` in the test), with no change in behavior.

## Testing

- New unit tests: shard count; claims and drain across 8 shards with every shard reset;
  exact order within a shard with tombstones; two shards popping in exact order from a single
  thread; 8 threads scheduling and claiming 40,000 tasks against 16 workers on 4 shards, every
  task run exactly once and no work left queued.
- `cargo fmt -- --check`; `cargo clippy -p turbo-tasks --all-targets -- -D warnings -A
  deprecated`, also with `--features inline_execution_stats`: pass.
- `cargo nextest run -p turbo-tasks -p turbo-tasks-backend` (`release-with-assertions`):
  394/394.
- As first written: `cargo nextest run` over `turbo-tasks`, `turbo-tasks-backend`,
  `turbopack-core`, `turbopack`, `turbopack-ecmascript`, `turbopack-tests`, `next-core`,
  `next-api`: 1718/1718 (1713 without the change, plus the 5 new tests); `cargo check -p
  next-napi-bindings`: pass; 113 Turbopack integration test runs (HMR, server actions,
  `app-dir/app`, tree shaking; `start` and `dev`): 1568 passed, 2 failed, identical case by
  case to v16.4.0, which fails the same 2 cases.

## Risks

- **Approximate priority across shards.** A worker can run a lower-priority task while a
  higher-priority one waits in a shard it did not look at, or whose lock was busy. Below 8
  workers there is one shard and the order is exact. The integration subset and the output
  fingerprint show no difference.
- **One shared atomic.** The non-empty bitmask is a single cache line written on every shard
  transition between empty and non-empty; with many workers and short tasks it can become a
  contention point of its own.
- **Memory orderings.** The `active_workers` read-modify-writes and the bitmask accesses are
  `SeqCst`; the no-lost-work argument relies on that. Two `Relaxed` loads of `active_workers`
  remain where the old code had them, as capacity hints.

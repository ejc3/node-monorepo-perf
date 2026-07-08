# Faster type-checking

Each package runs `tsc --noEmit`, fanned out and cached by Turborepo. Whole-repo type-checking is O(repo), so the first lever is checking less (`turbo --affected`); the second is making each check cheaper.

## Measured: tsc vs tsgo

`scripts/typecheck-bench.mjs` generates N cross-referencing modules in one program and times `--noEmit` for tsc and for tsgo (the TypeScript native Go port, shipped as `@typescript/native-preview`); each number is the median of 5 timed runs after a discarded warmup.

| modules | tsc | tsgo | speedup |
|---|---|---|---|
| 3,000 | 3,101ms | 255ms | 12.2x |

Consistent with Microsoft's ~10x claim. tsgo runs as `tsgo --noEmit` and fits the existing per-package Turborepo task; it is drop-in for modern configs — those not relying on the options TS 7 drops (below).

tsgo is beta as of 2026-06 — only `7.0.0-dev.*` nightlies, no GA. The native port drops some legacy configuration (it discourages bare `baseUrl` resolution and drops `moduleResolution: node10` and older `target`s such as `es5`) and has no compiler/LSP plugin API yet; confirm the specifics against the TS 7 release notes (linked below) before adopting. Pin a nightly and keep tsc as the CI fallback.

## Behavior at a million files: tsgo vs tsc vs Flow (`scripts/tsgo-scale-bench.mjs`)

The scaling question the table above cannot answer: what happens as ONE program keeps
growing — 10k, 100k, 250k, 500k, 1,000,000 modules? This bench sweeps that range for
three checkers: **tsgo** (the subject), **tsc** (the baseline, anchored at 10k and 100k —
a cost cutoff, not a capacity result), and **Flow** (Meta's checker, built for exactly
this scale — swept until its server wedged at 500k, the crash subsection below). Data: `bench/tsgo-scale-bench.json`; 64-core arm64 box, corpus
on the btrfs NVMe mount (recorded in the JSON).

The corpus is layered with **fixed depth**: modules sit in 100 layers, each importing up to 3
from the layer below (layer 0 imports nothing), so depth stays constant while width grows to 1M — the wide-not-deep
geometry real monorepos have. The shape is load-bearing: a chain whose depth grows with N
(typecheck-bench's shape) **stack-overflows tsc's incremental change propagation at
~5,000 modules** (`RangeError: Maximum call stack size exceeded`, reproduced — recorded
as `chainShapeNote`), so a depth-growing corpus would measure recursion depth, not
program size. The Flow corpus mirrors the TS one module-for-module in Flow's dialect.

Six rows per checker, each answering for a person: **cold** (page caches dropped before
every sample + no saved state — the fresh CI runner), **full** (caches warm, no saved
state — the recurring pre-merge gate), **incrNoChange** (warm incremental state, nothing
edited — the no-op floor), **incrOneEdit** (one private-const edit to a mid-corpus
module — the typecheck-after-save loop, at its minimal-invalidation floor), and the two
red paths: **fullWithLeafErrors** (the same full check over a corpus carrying 3 type
errors in leaf modules — the failing gate; the run must go red and report exactly the
seeded errors) and **incrOneEditError** (one leaf edit that introduces a type error —
the after-save loop when the change is wrong; each sample re-greens untimed first, so
the timed run measures error discovery, never diagnostic replay from saved state). Each checker
runs its own best mechanic: tsgo as the directly-resolved native binary, tsc under a
64GB node heap ceiling (parity-restoring vs the Go/OCaml runtimes' unbounded heaps),
Flow's batch rows via one-shot `flow check` and its incremental rows via its persistent
server (`serverInitMs` is the recorded boot; the ts checkers' recorded `incrPrimeMs` is
the equivalent entry cost). The incremental rows therefore pit Flow's primary mechanic
(a live server RPC) against the ts checkers' CLI mechanic (process relaunch +
tsbuildinfo) — different questions, labeled as such in the JSON; the ts daemons themselves
(`tsgo --lsp`) are measured in LIMITS.md's editor section — project-open and the
keystroke loop on one app's closure, not an edit-recheck at these scales.

Every timed number sits behind gates: a seeded type error must turn each checker red,
and the program must count exactly N source files (`--listFiles` / `flow ls`) — a
checker that no-ops or skips files cannot post a fast time. A crash signal or timeout anywhere
(including the gates) records a capacity boundary and stops that checker's sweep while
the others continue — that machinery fired once: Flow's 500k one-edit recheck timed out
(the recorded wedge, below); tsgo and tsc completed every row they ran.

### Full check (the pre-merge gate), median wall time

| modules | tsgo full | tsgo cold | tsc full | flow full | flow cold |
|---|---|---|---|---|---|
| 10,000 | 0.61s | 0.91s | 7.3s | 0.92s | 1.02s |
| 100,000 | 6.0s | 7.4s | 66.2s | 8.6s | 8.6s |
| 250,000 | 15.8s | 19.9s | anchor cutoff | 21.0s | 21.0s |
| 500,000 | 33.0s | 42.5s | — | 41.1s | 41.2s |
| 1,000,000 | 68.6s | 88.8s | — | wedged at 500k | — |

tsgo checks the million-module program in **68.6s warm, 88.8s truly cold** — and its
scaling is near-linear across the 100× range: 61ms per thousand modules at 10k grows
only to 69ms at 1M (~13% superlinear drift). Flow's one-shot check closes on tsgo as
the program grows — +51% at 10k narrowing to +25% at 500k (41.1s vs 33.0s), its last
measured scale (its server wedged in the incremental rows there; the subsection below) —
while the tsc anchor at 100k (66.2s vs tsgo's 6.0s, 11×) shows why it stops there. The
cold tax — reading a million source files off NVMe with empty caches — is +29% for tsgo
and within noise for Flow (its server-spawn-plus-init dominates the one-shot either
way). One boundary: tsgo's CPU utilization spans ~500–880% across every row
and scale — 5–9 of the 64 cores, so a bigger box buys nothing past that; the scaling
curve above is what its parallelism delivers.

### The red paths: checking a program that has type errors

The rows above run green. The red rows seed real type errors into leaf (top-layer,
zero-dependents) modules — the developer's own broken new code — and require the run to
exit red reporting exactly the seeded errors:

| modules | tsgo full red / green | tsc full red / green | flow full red / green |
|---|---|---|---|
| 10,000 | 0.61s / 0.61s | 7.3s / 7.3s | 0.93s / 0.92s |
| 100,000 | 6.0s / 6.0s | 66.6s / 66.2s | 8.5s / 8.6s |
| 1,000,000 | 69.0s / 68.6s | — | — |

**The failing gate costs the same as the passing one, for every checker at every
measured scale** — at a million modules tsgo's red full check is 69.0s against the
green 68.6s, and the error-discovery edit (below) costs about the same as the clean
edit for the ts checkers (tsgo 55.5s vs 53.7s at 1M; tsc 23.1s vs 23.0s at 100k).
Diagnostic construction is not a cost axis at this corpus's error counts; budget for
the check, not for the failure.

### Memory

| modules | tsgo peak RSS (full) | tsc peak RSS (full) | flow server tree peak |
|---|---|---|---|
| 10,000 | 583MB | 826MB | 878MB |
| 100,000 | 5.4GB | 6.7GB | 2.4GB |
| 500,000 | 27.7GB | — | 9.0GB |
| 1,000,000 | 53.7GB | — | — |

Memory is the axis where the checkers differ most: tsgo holds ~54KB per module (53.7GB
at 1M — 40% of this 135GB box, `bench/env.json`), Flow ~18KB per module (9.0GB at 500k,
its last completed scale; a process-tree VmHWM sum — an upper bound), and tsc ~67KB per
module at its 100k anchor (measured under the 64GB heap ceiling, where V8 collects
lazily — an upper bound, not minimum footprint; the JSON's `tscNote`). No checker hit a
memory cliff: nothing was OOM-killed at any point on this box; the one recorded
boundary in the dataset is Flow's cancellation-race wedge at 500k (below), not resource
exhaustion.

### The developer loops

| modules | tsgo incr no-change / one-edit | tsc incr no-change / one-edit | flow status / edit round-trip |
|---|---|---|---|
| 10,000 | 0.31s / 0.45s | 2.9s / 3.1s | 30ms / 66ms |
| 100,000 | 3.1s / 4.3s | 21.7s / 23.0s | 40ms / 205ms |
| 250,000 | 8.8s / 12.0s | — | 40ms / 939ms |
| 500,000 | 18.1s / 25.2s | — | 50ms / **wedged** |
| 1,000,000 | 38.0s / 53.7s | — | — |

The save-loop verdict splits by mechanic, exactly as the row labels warn. tsgo's CLI
incremental — relaunch and re-validate saved state against a million-file program —
costs 38.0s even when NOTHING changed, and 53.7s for one edit: at this scale the
process-relaunch mechanic is a CI tool, not a save loop (its daemon counterpart,
`tsgo --lsp`, is the editor-loop bench's subject). Flow's persistent server answers a
no-change status in 30–50ms flat at every scale it survived, and its one-edit
round-trip grows with N (66ms → 205ms → 939ms at 10k/100k/250k) while staying
interactive — until 500k, where the first one-edit recheck wedged the server (the
subsection below) and ended Flow's sweep. When the edit is WRONG, discovery costs about the
same: tsgo 55.5s vs 53.7s clean at 1M, tsc 23.1s vs 23.0s at 100k, flow 199ms vs 205ms
at 100k (flow's sub-second windows carry more run-to-run variance — 499ms vs 939ms at
250k). The entry costs are symmetric and recorded: tsgo's incremental prime is 95.5s
at 1M, Flow's server init 41.7s at 500k (its init IS a full check). The tsc anchor adds
one observation: its one-edit re-check costs barely more than its no-change floor
(23.0s vs 21.7s at 100k — a third of the 66.2s full run), so the relaunch + buildinfo
floor dominates, not the edit — and its incremental engine is also the component that
stack-overflows on depth-growing graphs (the chainShapeNote above).

### Flow's server crash-wedge at 500k — recorded in the canonical dataset

At 500,000 modules the canonical run's first one-edit recheck hit the bench's 1h
ceiling and was recorded as the row's outcome
(`points.500000.flow.incrOneEdit: timedOut`), with the server's own log captured in the
JSON's `serverLogTail`:

```
thread '<unnamed>' (444264) panicked at crates/flow_typing_utils/src/type_operation_utils.rs:295:10:
called `Result::unwrap()` on an `Err` value: WorkerCanceled(WorkerCanceled)
```

The same race fired at the same 500k point in two other full-scale sweeps of this bench
(one at a second site, `flow_typing_statement/src/statement.rs:7054` — evidence in
`bench/flow-0321-wedge-evidence.md`), and two sweeps passed it clean: a cancellation
race, roughly a coin flip per run at this scale, not a deterministic wall. The anatomy:
a recheck cancellation mid-check sends `WorkerCanceled` down an error channel whose
consumers assume only speculation errors can arrive; a worker thread panics on the
unwrap; the pool absorbs the panic, the files-completed counter never reaches its
total, and the master parks every thread wedged (~9GB RSS, 131 sleeping threads, frozen
CPU counters, healthy RPC socket in the gdb/proc forensics). The operational symptom is
the finding: a Flow server crash at this scale presents as a **silently hung client** —
`flow status` sits forever, and only process-level inspection distinguishes "still
checking" from "dead". Reported upstream as
[facebook/flow#9454](https://github.com/facebook/flow/issues/9454); the panic sites are
already fixed on Flow's main branch (three commits, unreleased as of 0.321) — the fix
boundary is the check scheduler, which must treat `WorkerCanceled` as a cancellation
instead of letting a worker panic starve the completion counter.

Per persona: the **fresh CI runner** pays 88.8s (tsgo, 1M) for the first check — Flow's
equivalent is 41.2s at its 500k ceiling; the **gate owner** pays 68.6s (tsgo, 1M) or
41.1s (Flow, 500k) per whole-program run, red or green, and should budget 53.7GB or
9.0GB of RAM respectively; the **developer on save** is served only by a persistent
process — Flow's server model stays interactive through 250k (939ms per edit) and is
the right mechanic, but its 0.321 implementation is the component that wedged, while
tsgo's CLI incremental never crashes and never gets interactive (53.7s per edit at 1M);
its daemon (`tsgo --lsp`) is the mechanic-matched counterpart (LIMITS.md's editor
section). tsgo's practical limits at 1M are memory (53.7GB) and entry cost (95.5s
incremental prime), not a crash; Flow's is the recorded 500k wedge, fixed upstream but
unreleased.

## Ranked levers

1. tsgo (`@typescript/native-preview`): ~10x per check, drop-in. Beta, so pin a nightly and keep a fallback.
2. Cheap, stable config: `skipLibCheck: true`; `incremental: true` with an explicit `tsBuildInfoFile` added to Turborepo `outputs`; `"types": []` then list only what each package needs; `turbo --affected` so CI checks changed packages only.
3. Do not adopt TypeScript project references with Turborepo. Turborepo recommends against them (a second config plus a second cache layer), and `composite` forces `.d.ts` emit on every package, making each task heavier than `--noEmit`.

Honorable mention: `isolatedDeclarations` (TS 5.5) enables parallel `.d.ts` emit. Relevant only where declarations are emitted (the library builds here do; the app `--noEmit` checks do not).

Not type checkers: swc, esbuild, oxc, and Biome transpile or lint; they do not do semantic type-checking. stc is archived; ezno is experimental. tsc and tsgo are the complete options.

Sources: [TypeScript native port](https://devblogs.microsoft.com/typescript/typescript-native-port/), [TS 7 beta](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-beta/), [Turborepo TS guide](https://turborepo.dev/docs/guides/tools/typescript), [Performance wiki](https://github.com/microsoft/TypeScript/wiki/Performance).

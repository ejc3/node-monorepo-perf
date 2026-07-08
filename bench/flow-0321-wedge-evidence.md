# Flow 0.321.0 server crash-wedge at 500,000 modules — archived evidence

Three sweep runs of `scripts/tsgo-scale-bench.mjs` hit a Flow 0.321.0 server crash at
the 500k point on the linux-arm64 flow-bin binary — the third of them the recorded
canonical dataset itself (`bench/tsgo-scale-bench.json`, Crash 3 below); two other
sweeps passed the same point clean. A cancellation race, roughly a coin flip per run
at this scale, not a deterministic wall. This file archives the primary evidence the
TYPECHECKERS.md crash section cites.

## Crash 1 — panic in `flow_typing_utils`

Timeline from the server log (`/tmp/flow/…flow-corpus.log`, 2026-07-07, read live
while the process was wedged):

    [2026-07-07 22:19:20.483] Creating a new Flow server
    [2026-07-07 22:19:20.484] File watcher type: dfind
    [2026-07-07 22:19:20.506] Spawned server #1 (pid=79871)
    [2026-07-07 22:20:02.437] File watcher reported 1 file changed
    [2026-07-07 22:20:05.441] File watcher reported 1 file changed
    [2026-07-07 22:20:05.873] Check prep
    [2026-07-07 22:20:05.874] new or changed signatures: 0
    [2026-07-07 22:20:05.874] Check will skip 3 of 4 files
    [2026-07-07 22:20:05.874] Checking files

    thread '<unnamed>' (79939) panicked at crates/flow_typing_utils/src/type_operation_utils.rs:295:10:
    called `Result::unwrap()` on an `Err` value: WorkerCanceled(WorkerCanceled)

Aftermath, from `/proc` before any intervention:

- server master pid 79871: alive, VmRSS 9,171,740 kB (~9.0GB), **131 threads**, CPU
  counters frozen (utime 159149 across repeated 4–5s samples) — wedged, not working;
  a gdb thread dump showed every thread parked in futex wait
- the bench's `flow status` client blocked 18m38s and counting with no error output —
  the server's RPC socket stayed healthy, so the client saw a working server that
  never answered

## Crash 2 — same trigger, different panic site

A later non-canonical sweep hit the same pattern at the same 500k point
(watcher-triggered recheck during the post-init check, worker panic, master wedged at
8.7GB with the status client hanging), at a **different** site:

    thread '<unnamed>' (112997) panicked at crates/flow_typing_statement/src/statement.rs:7054:30:
    should not fail outside speculation: WorkerCanceled(WorkerCanceled)

Two runs, two distinct panic sites (`flow_typing_utils/src/type_operation_utils.rs:295`
and `flow_typing_statement/src/statement.rs:7054`) — the hazard is the error-channel
contract (`WorkerCanceled` travels the same channel as speculation errors, and
multiple consumers `unwrap`/`expect` assuming only the latter), not one buggy line.

## Crash 3 — the canonical dataset's recorded occurrence

The recorded canonical sweep (`bench/tsgo-scale-bench.json`, tsgo 7.0.0-dev.20260707.2
toolchain) hit the race at the same 500k point on the first one-edit recheck: the row
is recorded as `points.500000.flow.incrOneEdit: { killed: true, timedOut: true }` and
the JSON's `serverLogTail` carries the panic —
`crates/flow_typing_utils/src/type_operation_utils.rs:295`, the same site as crash 1.
Three occurrences in five full-scale sweeps; two sweeps passed the point clean.

## Mechanism

The file watcher reports changes while the initial post-init check is running; Flow
cancels the in-flight check; the cancellation surfaces as `WorkerCanceled` inside a
worker mid-typecheck; the consuming code panics; the worker pool absorbs the panic, so
the shared files-completed counter never reaches its total and the scheduler's
completion wait blocks forever. The observable symptom is a silently hung `flow
check`/`flow status` client — no error, no crash report from the client's side.

Reported upstream as
[facebook/flow#9454](https://github.com/facebook/flow/issues/9454). The panic sites
are already fixed on Flow's main branch — commits `dc725ff9`, `74fc09a8`, `49511978` —
unreleased as of 0.321.0, so every released binary through 0.321 carries the wedge. A
backport against the v0.321.0 source (scheduler `catch_unwind` containment +
propagating the two observed sites' errors) lives on the `fix-workercanceled-wedge`
branch of the ejc3/flow fork.

## Retest: the trigger isolated, the upstream fix verified

A directed retest harness (`scripts/flow-wedge-retest.mjs`) makes the race reproducible
on demand and verifies the fix; the recorded runs are `bench/flow-wedge-retest.json`.
Setup: a fresh 500k-module corpus of the same layered shape per binary; `flow start
--wait`; then edit-recheck cycles. Binaries: released flow-bin 0.321.0, and flow main
at `cdb4f637` (contains the three fix commits) built from source. Two pressure modes:

- **Sequential** (edit → force-recheck → status, settled between cycles): released
  0.321.0 survived 10 cycles clean. The race needs an in-flight check to cancel.
- **Overlapping** (edit A → notify → 120–480ms later, while the recheck runs, edit B →
  notify → status): released 0.321.0 **wedged at cycle 13** with the identical panic
  (`type_operation_utils.rs:295`, WorkerCanceled unwrap) and the identical symptom — a
  status client hung past the 8-minute ceiling against a healthy socket. The build of
  Flow main containing the three fix commits **survived 20 overlapping cycles** under
  the same pressure, no panic.

The mid-check edit is the trigger: the watcher's change report cancels the in-flight
check, and 0.321 panics on the resulting `WorkerCanceled`. Recheck round-trips on the
same corpus: released 0.321 2.0–3.5s per cycle; the main build 0.3–0.7s.

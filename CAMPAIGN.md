# Campaign: TypeScript 7 refresh (opened 2026-09-30)

Operational driver for the toolchain refresh. Living doc: statuses update as items
land; the file is removed when the campaign closes. Numbers cited here are targets or
prior records; new numbers land in `bench/*.json` through the normal PR loop.

## Goals

1. **PR A — TS7 migration.** `typescript@7.0.2` (native, exact pin) replaces the
   frozen `@typescript/native-preview` nightly; `typescript6` (npm alias, the last JS
   release) stays as the parity oracle and tsserver anchor. All binary resolution
   through `scripts/_ts.mjs`, direct paths only, version-asserted (never `.bin/tsc` —
   the two packages' bins collide). Task name `typecheck:tsgo` is retained.
2. **PR B — pnpm 12 (Rust) benchmarks.** pnpm 12 is the Rust rewrite (stable
   2026-08-26). Head-to-head: pinned 10.29.1 (the JS baseline in `_pins.mjs`) vs
   12.8.1 (npm latest) vs a tip-of-main build (sha-recorded provenance), install rows
   with the shared completeness verifier. Then a decision point: bump `PNPM_VERSION`.
3. **PR C — diagram system + report refresh.** Deterministic SVG figure generators
   (byte-gated like the charts) replacing word-heavy doc sections; every report
   refreshed against the new records.
4. **Full re-measurement** of every bench the toolchain change invalidates, on
   pbox 2, with the cross-box contrast benches also rerun on the 64-core box.

## Machines

- **pbox 2**: c8g.48xlarge, 192 cores, us-west-2d, spot ($2.41/hr), persistent work
  volume. Runs the queue. Bring up/down with `pbox up 2` / `pbox down 2`.
- **Local 64-core box**: PR work, reviews, and the 64-core side of the cross-box
  contrast benches (fleet-gate, sliced-gate, fleet-flow).

## Prerequisites

- [x] pbox 2 launched (i-0fa178ee41e409e7e).
- [x] pbox 2 provisioned: node 22 / bun 1.4.2 / pnpm 10.29.1 / GNU time /
      drop_caches sudo verified; repo clone at `/mnt/work/node-monorepo-perf`
      (main @ d839ef5). Work volume is ext4, 67G free — see the yarn-fleet note.
- [x] flow-main binary at pbox2 `~/bin/flow`, smoke-tested: 0.321.0 @ cdb4f637
      (`FLOW_BIN` + `FLOW_SOURCE` for tsgo-scale / fleet-flow).
- [x] patched PnP tsgo at pbox2 `~/bin/tsgo-pnp`, smoke-tested: 7.1.0-dev
      @ e1457093 (`TSGO_PNP_BIN` for yarn-fleet / tsgo-pnp; its upstream base repo
      is archived, so this fork binary remains the PnP-capable checker).
- [ ] pnpm tip binary built (in progress on the local box).
- [ ] PR A merged (queue runs from main; review-before-expensive-run).

## Phase 2 — pbox 2 queue (serial; each bench is load-guarded and refuses a busy box)

Cheap first, long poles last. Destructive benches run in a linked worktree on
pbox 2's clone. One record-batch PR per group, normal review loop.

- [ ] relay-codegen-bench (+30k fleet anchor)
- [ ] typecheck-parity-bench, typecheck-bench, decl-emit-caveat, env — done on the
      local box inside PR A (listed for completeness)
- [ ] tsgo-scale-table (4 scales)
- [ ] optimal-gate-bench 4000:400 (canonical layered record)
- [ ] dev-loop-bench 4000:400
- [ ] lib-rev-bench 4000:400
- [ ] dev-sim
- [ ] editor-loop-bench (both sweeps)
- [ ] real-app-bench (tsgo GA may change the adaptation-friction rows; that is data)
- [ ] pnp-compat-bench, tsgo-pnp-bench (needs TSGO_PNP_BIN)
- [ ] vite-task-bench, vite-plus-tools-bench
- [ ] lint-bench (type-aware row rides the checker substrate)
- [ ] measure.mjs sweep — the README core scaling table (its build/typecheck columns
      are tsc-driven, now native)
- [ ] axis-bench
- [ ] ci-cache-bench, ci-cache-network-bench (typecheck task family; tc + sudo)
- [ ] optimal-gate-bench fleet:30000 (192-core side)
- [ ] sliced-gate-bench fleet (192-core side)
- [ ] fleet-flow-bench (192-core side; FLOW_BIN)
- [ ] yarn-fleet-bench — runs LOCAL (pbox2's work volume is ext4/67G free; the nm
      linker at fleet scale needs CoW or ~1.5TB, so this one runs on the local
      btrfs volume)
- [ ] lsp-scale-bench (1M; hours)
- [ ] tsgo-scale-bench (1M; hours; needs root drop_caches; runs solo)
- [ ] FINAL step, after every record above has re-measured: refresh the canonical
      `bench/env.json` (`node scripts/env.mjs`) and regenerate the chart/summary
      outputs — env.json is the machine/toolchain provenance for ALL committed
      records, so it may only change once the records match it.

Out of scope (substrate unchanged): test-axis (zero checker involvement — its tasks
are `node:test`), build-bench + the turbopack/rspack pair (generated Next apps set
`typescript: { ignoreBuildErrors: true }`, so `next build` never type-checks),
fs-bench, fs-iops, wave-rollout, bun-safety, yarn-rollout, container-install (moves
to Phase 3 if the pnpm pin bumps), install family (Phase 3 decision). Note: pbox2
carries bun 1.4.2, which wave-rollout/bun-safety would refuse (they assert 1.3.14) —
irrelevant unless those enter scope.

## Phase 2b — local 64-core companions (after the local box frees up)

- [ ] optimal-gate-bench fleet:30000 → canonical `bench/fleet-gate-bench.json`
- [ ] sliced-gate-bench fleet → canonical + the pbox2 run becomes `.pbox.json`
- [ ] fleet-flow-bench → canonical + `.pbox.json`

The cross-box contrast (one-program gate flat across cores; sliced gate transforming
the big box) is a headline finding; both sides re-measure on the new toolchain.

## Phase 3 — pnpm 12

- [ ] pnpm12 bench lands (PR B) with 10-vs-12-vs-tip numbers
- [ ] DECISION (owner): bump `PNPM_VERSION` in `_pins.mjs` to 12.x?
      If yes: install-bench, container-install-bench, lockfile-bench,
      install-modes, focus-install, lockfile-merge, perf-matrix rerun, and the
      ROLLOUT/TOOLING install claims (incl. the bun 62–357× line) re-derive.

## Phase 4 — diagrams + report refresh (PR C)

- [ ] Figure generators per the distilled cmux-page style (rounded tinted boxes,
      arrowed edges, dashed=soft, dark-mode attribute-selector recolors, in-figure
      provenance footers), deterministic from bench JSONs, wired into the
      `charts.yml` byte-gate + PNG commit-back, registered in AGENTS.md.
- [ ] Word-heavy sections replaced by figures: O(repo)-vs-O(closure), sliced-gate
      fan-out + union check, fleet blast-radius grid, save-loop timeline lanes,
      types-first vs inference closure, linker layouts, freshness-gate loop,
      remote-cache economics.
- [ ] Every report re-read against the new records; machine lines and toolchain
      descriptions updated; doc-sync pass (all four lenses) before the final merge.

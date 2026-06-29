# CLAUDE.md — nextjs-monorepo-scale-demo

Project-specific context for this repo. General git/PR/commit/testing conventions
live in the global `~/.claude/CLAUDE.md`; this file is only what's specific here.

## What this repo is

A measurement lab for a large pnpm + Turborepo monorepo. It generates a synthetic
workspace (N Next.js apps + M shared libs, each package holding `MODULES` generated
TS modules re-exported through an `index.ts`), with inter-package imports forming a
layered dependency graph (apps import libs; libs import lower libs). It then
benchmarks every workflow as the workspace scales (200 → 4,000 apps) and reports
the results in the docs.

**Thesis:** whole-workspace operations are **O(repo)** — they scale ~linearly with
package count (install, cold/warm typecheck, lockfile, graph-load, prune). Focused
operations (`turbo --filter=<app>...` / `--affected`) are **O(closure)** — they
track one app's dependency closure and grow with that closure, not the repo. The
takeaway is to scope work, not to optimize unscoped commands.

The apps/ and packages/ trees are **generated and gitignored** — they are build
inputs, not source. Tracked files are `scripts/`, the docs, `bench/*.json`,
`bench/charts/*.svg`, `bench/summary.md`, and config.

## Workflows

Scale knobs are Makefile vars: `APPS`, `LIBS`, `MODULES`, `APP` (focus target),
`SCALES` (e.g. `"300:100 1500:300"`). Override on the CLI: `make bench APPS=2000 LIBS=300`.

### Scaffold
- `make gen` — generate the workspace (`generate.mjs --apps --libs --modules --clean`).
- `make gen-versioned` — same, but with semver versions + `workspace:^x.y.z` specifiers.
- `generate.mjs --universal K` — make the lowest K libs a pure-sink foundation tier that
  every app and every other lib depends on (the `@acme/core` everyone imports); revving
  one has a whole-repo blast radius. Used by `lib-rev-bench.mjs`. 0 = none (default).
- `generate.mjs --test-task` — emit a per-package `node:test` smoke test + a `test` script
  in every package (the root `turbo.json` `test` task has no task deps, so a `turbo run test`
  isolates the test axis from build). Off by default. Used by `test-axis-bench.mjs`.
- `make clean` — remove generated apps/packages, `out`, `.turbo`, `node_modules/.cache/turbo`, diamond example.

### Core operations (the O(repo)-vs-O(closure) thesis, one command each)
- `make install` — `pnpm install` the whole workspace.
- `make build` / `make typecheck` — build / typecheck the whole workspace (O(repo));
  `make typecheck-warm` runs typecheck twice so the second run is a warm-cache hit.
  These raw targets don't clear the cache — the bench scripts are what enforce a true
  cold run.
- `make graph` — print the turbo task-graph size.
- `make focus` — `turbo run build --filter=$(APP)...`: build one app + its closure (O(closure)).
- `make prune` — `turbo prune $(APP) --docker`: the minimal subtree for one app. Bare
  prune respects `.gitignore`, so on the generated (gitignored) workspace use the bench
  path (`deploy-vercel.mjs`, or `--use-gitignore=false`) to actually include source.

### Core scaling benchmark
- `make bench` — one full per-phase record (gen, install, graph-load, cold+warm
  typecheck, focus build, prune) appended to `bench/results.json` (`measure.mjs`).
- `make sweep` — run `measure.mjs` across the scale matrix; `--from <label>` resumes (`sweep.mjs`).
- `make chart` — render `bench/charts/*.svg` + `bench/summary.md` from `results.json` (`chart.mjs`).

### Decomposition / axes
- `node scripts/axis-bench.mjs` — separate the apps axis from the libs axis
  (install scales with apps; focus tracks libs/closure) → `bench/axis-bench.json`.
- `node scripts/test-axis-bench.mjs` (`TEST_AXIS_SCALES`/`BLAST_SCALE`/`GATE_SAMPLES` knobs;
  default scales `300:100 1000:200`, blast `1000:200`) — the missing TEST-execution axis,
  built with `generate.mjs --test-task`. Whole-repo `turbo run test` (O(repo), one task per
  package) vs a focused `--filter=<app>...` (O(closure)), cold then warm; the edit-location
  blast radius (universal foundation vs leaf, via `--filter=...<lib>` as a git-free `--affected`
  stand-in, with a mid-layer point); and the structural sharding benefit (`ceil(total/N)`).
  The `test` task has no deps, so it isolates test-task selection + per-task runner cost from
  the build axis; the per-package body is a trivial `node:test` smoke test, so cold/warm ms are
  Turbo-orchestration + `node --test`-startup bound (the test-task COUNT and its scaling is the
  finding, not suite runtime). Cold clears every cache + stops any ambient turbo daemon and
  asserts 0 cached; warm asserts all cached; the O(closure) contrasts are STRUCTURALLY asserted
  (focus < whole; universal foundation === every package; leaf < foundation); core-bound, records
  `cores`/`preRunLoadAvg1`, refuses on a loaded box unless `TEST_AXIS_ALLOW_BUSY=1`. Run in a git
  worktree (regenerates the tree) → `bench/test-axis-bench.json`, folded into LIMITS.md + the
  README "Findings by area".
- `make lockfile-bench` — split install into resolve (`--lockfile-only`) vs verify
  vs full, per `SCALES` → `bench/lockfile-bench.json`.
- `node scripts/install-modes-bench.mjs <apps>:<libs>` (default `1000:200`) —
  install by situation: cold-resolve (no lockfile) vs +1 dependency vs catalog bump
  vs frozen (warm/cold store) → `bench/install-modes-bench.json`.
- `node scripts/focus-install-bench.mjs <apps>:<libs>` (default `80:25`) — focused
  install: `pnpm install --filter app...` materialization scope and `turbo prune`
  completeness + pruned-lockfile size → `bench/focus-install-bench.json`.
- `node scripts/lockfile-merge-bench.mjs <apps>:<libs>` (default `200:50`) — lockfile
  churn: catalog bump vs per-app pin (`package.json` files changed + lockfile lines)
  and a two-branch merge conflict auto-resolved by `pnpm install` →
  `bench/lockfile-merge-bench.json`.

### Tool comparisons
- `make install-bench` — pnpm (isolated + hoisted) vs bun, cold/warm/truly-cold → `bench/install-bench.json`.
- `make build-bench` — full Next vs Vite build at `APPS`/`LIBS` → `bench/build-bench.json`.
- `node scripts/typecheck-bench.mjs <N>` — tsc vs tsgo on one N-module program;
  `TC_SAMPLES` timed runs, median reported → `bench/typecheck-bench.json`.
- `node scripts/perf-matrix.mjs --apps <n> --libs <n>` — how `workspace:` spec form
  and node-linker choice move install time / footprint → `bench/perf-matrix.json`.
- `node scripts/turbopack-bench.mjs` — `next build` vs `next build --turbopack` on
  Next 16 (identical output size + same bundler) → `bench/turbopack-bench.json`.
- `node scripts/fs-bench.mjs <apps>:<libs>` (default `300:100`) —
  `package-import-method` on a CoW filesystem (btrfs reflink) vs hardlink (ext4):
  relink time + exclusive disk → `bench/fs-bench.json`.
- `node scripts/fs-iops-bench.mjs` (`FS_TARGETS="label:root ..."`, default working
  tree vs `/mnt/fcvm-btrfs`) — the device layer under fs-bench: 4K random read/write
  IOPS + p99 at `O_DIRECT` (no page cache) and a small-file burst (buffered create-only
  vs per-file `fsync`), per mount with fstype/device. Shows the btrfs NVMe faster in
  every regime — ~35× random-read IOPS and ~16× per-file-fsync throughput of the
  working-tree NVMe — while a buffered create burst is within ~1.3× (page-cache-bound,
  matching fs-bench's equal relink). Asserts engine/qd parity across targets (else marks
  `likeForLike:false`, omits ratios); refuses on a loaded box (`FS_IOPS_ALLOW_BUSY=1`)
  → `bench/fs-iops-bench.json`, folded into OPTIMIZATIONS.md §1.2.1. Requires `fio` +
  `findmnt`; self-contained, cleans up on exit.

### Developer experience
- `node scripts/dev-sim.mjs --devs <D> --apps <n> --libs <n>` — simulate D devs each
  owning a feature area (2 apps + 1 lib): onboarding, typecheck-on-save,
  build-before-push, lib-edit, independence, blast radius → `bench/dev-sim.json`.
- `node scripts/lib-rev-bench.mjs <apps>:<libs>` (default `4000:400`; `make lib-rev-bench`)
  — cost of revving a universal foundation lib (`generate --universal 1 --tsgo-task`, so
  `@demo/lib-001` is imported by every app and every package has a `typecheck:tsgo` twin
  task). Workspace-dep rev: lockfile byte-identical (no install/publish); the lib-owner
  gate `turbo run typecheck --filter=...foundation` re-checks every dependent (O(repo)
  because it's universal) vs a leaf lib (O(closure)), each timed under tsc and tsgo from a
  cold cache. Breaking-change catch: a breaking foundation signature makes the gate go red
  and name the dependent apps/libs that no longer typecheck (TS2554), under both checkers.
  tsc vs tsgo on the real lib source as one big program (pure-checker speedup). npm-dep
  version-bump fanout (catalog 1 line vs per-consumer pin) → `bench/lib-rev-bench.json`.
  The gate wall-clock ratio is build-diluted (both gates share the tsc `^build`) and
  labeled as such; the npm-dep re-resolve/lockfile churn and registry publish are measured
  by install-modes-bench, lockfile-merge-bench, and registry-resolution-demo.
- `node scripts/optimal-gate-bench.mjs <apps>:<libs>` (default `4000:400`) — the
  foundation-rev scenario on the single optimal toolchain only (no slower baseline): bun
  install, tsgo typecheck, oxlint, turbo. Generates `--universal 1 --tsgo-task`, decatalogs
  (bun ignores pnpm `catalog:`), writes a bun workspace root (`packageManager: bun@…` +
  toolchain devDeps), then measures: bun warm-store install; the **optimal type-error gate**
  for a universal rev — a single tsgo process over the whole workspace from source
  (`tsgo --noEmit -p tsconfig.whole.json`, `@demo/*`→`packages/*/src`, so it parses each
  lib once and shares it across all apps, skipping the tsc dist builds; typecheck-only,
  peak RSS recorded); a breaking foundation signature caught as **every** dependent app
  turning red (the `caught` flag requires `appsWithErrors === APPS` + a `TS2554` sample,
  not just a non-zero exit); for context the turbo build+tsgo gate (`--filter=...@demo/lib-001`,
  O(repo), 4,800 tasks cold — **not** like-for-like, it also emits dist); a leaf rev via
  `turbo --filter` (O(closure), asserted smaller); oxlint across the tree →
  `bench/optimal-gate-bench.json`, writeup in OPTIMAL-STACK.md. The whole-program gate runs
  a throwaway warmup first (excludes binary load / first-touch fs) and asserts RSS was
  captured; the turbo gate runs after a daemon warmup and is asserted cold (zero cached).
  **Destructive** (overwrites the root `package.json`, regenerates the tree) so it refuses
  to run outside a linked git worktree, and restores everything it mutates (package.json,
  revved source, `tsconfig.whole.json`) on exit via an idempotent `process.on("exit")`
  handler. Lib `dist` is tsc-emitted via `^build` in the turbo path; the whole-program gate
  sidesteps it — labeled in the doc.
- `node scripts/typecheck-parity-bench.mjs <apps>:<libs>:<modules>` (default `300:80:8`) —
  vets the two properties the optimal gate depends on, on **real** type complexity (not the
  16-line re-exports the optimal-gate tree uses): the libs carry recursive conditional +
  mapped types, 48-member unions, recursive path-flattening, and cross-lib intersections.
  **Self-contained and non-destructive** — it scaffolds a throwaway workspace under the OS
  temp dir (never the repo tree, so no worktree needed), bun-installs typescript + tsgo,
  runs both checkers over one `tsconfig.whole.json` (`@demo/*`→lib source), and removes the
  workspace on exit. Measures (1) **cost** — the one tsgo program over the type-heavy tree
  (time + peak RSS), each checker run as the median of `PARITY_SAMPLES` (default 3) timed
  runs after a warmup; (2) **parity vs tsc** (the oracle) — clean baseline both 0, then 5
  apps × 5 injected error sites; reports locations missed by tsgo, tsgo-only locations, and
  same-location-different-code (with a sample of the differing codes). **Hard-fails** if the
  clean baseline isn't 0/0 (the generated heavy types must be valid), if tsgo misses or adds
  any location vs tsc (location parity is enforced both ways), if the tsc injected count
  drifts from 25, or if a checker is killed by a signal. The speed ratio is core-bound (tsgo
  is parallel), so it **refuses to run on a loaded box** (1-min load > half the cores) unless
  `PARITY_ALLOW_BUSY=1`, and records `cores`/`preRunLoadAvg1`/per-run `sampleMs` so a
  contended run is visible → `bench/typecheck-parity-bench.json`, results folded into
  OPTIMAL-STACK.md.
- `node scripts/dev-loop-bench.mjs <apps>:<libs>` (default `4000:400`; `APP_LOOP_TARGET` /
  `LIB_LOOP_TARGET` pick the targets) — the **developer inner loops** on the optimal stack,
  the O(closure) counterpart to the optimal-gate O(repo) lib-owner gate, for the two day-to-day
  roles (**app developer**: one app + the libs it imports; **lib developer**: one leaf lib +
  the libs it imports), each reported **fresh (first time) vs subsequent (repeat)**. Per role:
  (A) **typecheck-on-save** — tsgo over the package + its closure from source; (B)
  **lint-on-save** — oxlint over the one package dir; (C) **focused gate** — `turbo
  typecheck:tsgo` over the closure (app: `app...`) or dependents (lib: `...lib`), COLD then
  WARM, under `enterSourceVisible` so input hashing is representative, asserted cold (0 cached)
  / warm (all cached). Plus the one-time onboarding `bun install`, fresh (cold `node_modules`)
  vs subsequent (warm). Direct-tool steps run `APP_LOOP_SAMPLES`+1 times (run #1 = fresh, median
  of the rest = subsequent) and hard-fail unless the package exits clean (a valid package must
  typecheck and lint 0). **Destructive** (regenerates the tree, overwrites the root
  `package.json`) so it refuses to run outside a git worktree and on exit restores the tracked
  files it overwrites (`package.json`, `.gitignore`, temp tsconfigs, lockfiles) — the
  regenerated tree is left as gitignored scratch; **core-bound**, so it refuses on a loaded box
  unless `APP_LOOP_ALLOW_BUSY=1` and records
  `cores`/`preRunLoadAvg1` → `bench/dev-loop-bench.json`, results folded into OPTIMAL-STACK.md.
  The workspace-author core-package (universal) gate is the O(repo) case and lives in
  `optimal-gate-bench.mjs`.
- `node scripts/real-app-bench.mjs` (`REAL_APP_ONLY=<name>` to run one) — the **real-app vet**:
  does the per-app inner loop hold on real, larger product code, not just the synthetic tiny apps?
  Clones real open-source Next.js App Router apps at pinned commits (vercel/commerce ~3.9k LOC,
  shadcn/taxonomy ~7.5k LOC) and runs this repo's pinned toolchain on each: bun install (cold
  node_modules, warm store), tsgo `--noEmit`, oxlint, and the two checks orchestrated by turbo
  (cold then warm cache hit). Records the **finagle friction** — tsgo (TS7 preview) rejects a real
  tsconfig's removed options (`baseUrl`/`moduleResolution:node`/`target:es5`/`downlevelIteration`)
  before type-checking, so the bench modernizes the config and adds an ambient `*.css` decl, then
  measures the real typecheck (time/RSS/error count + code histogram). A checker exiting non-zero on
  TYPE errors is **data, not a bench failure** (real apps surface missing codegen + dependency
  drift); only a signal/panic is a crash (detected numerically — a 128+signo exit, not the shell's
  wording — across `run()`, the sampled tool runs, and the turbo runner alike). The finagled program
  checks hand-written source only (not the app's `next build`-generated `.next/types`/`next-env.d.ts`
  or contentlayer codegen), so it is the inner-loop source check, not the app's full `tsc` surface.
  The cold turbo run is asserted cold (0 cached); a kept clone is reused only if it is exactly at the
  pinned sha with a clean tree, else re-cloned, and the **measured** HEAD is recorded; the finagle's
  config-reject time, a per-code diagnostic sample, and the inherited `skipLibCheck` are recorded so
  the doc attributions trace to data. A partial run (`REAL_APP_ONLY` or a non-default
  `REAL_APP_SAMPLES`) writes `bench/real-app-bench.partial.json` and never overwrites the canonical
  two-app dataset. **Self-contained and non-destructive to the repo** — clones to a btrfs work dir
  (`REAL_APP_WORK`, default `/mnt/fcvm-btrfs/real-app-bench`) and removes each clone on exit unless
  `REAL_APP_KEEP=1`, so it needs no worktree; core-bound, refuses on a loaded box unless
  `REAL_APP_ALLOW_BUSY=1` → `bench/real-app-bench.json`, folded into OPTIMAL-STACK.md + SUMMARY.md.
- `node scripts/decl-emit-caveat.mjs` — the **declaration-emit caveat vet**: demonstrates the
  declaration-emit coverage gap, one place the fast type-error gate is not equivalent to the build.
  The optimal gate runs `declaration:false` (to avoid TS2883 noise on JSX return types), so it
  validates the code but not the published `.d.ts`. Scaffolds a throwaway workspace (an app importing
  a `@demo/foundation` package whose source re-exports a value whose inferred type comes from a
  transitive dep nested under another package's `node_modules` — the pnpm geometry that trips the
  "inferred type cannot be named" portability error) and runs it through: the gate (`declaration:false`,
  `--noEmit`) stays clean under both tsgo and tsc; a `declaration:true` `--noEmit` check (NO emit)
  flags it (tsc `TS2742` / tsgo `TS2883`); the dist-emitting build (`tsc --declaration`) flags it;
  promoting the transitive type to a directly-resolvable dependency clears it; and the explicit
  annotation `TS2742` suggests is shown insufficient alone (without promoting the dep it can't even
  resolve the nested type — `TS2307`). The boundary is `declaration` off-vs-on, not check-vs-emit.
  **Hard-fails** if the divergence doesn't reproduce — it asserts the exact per-tool code, so a
  toolchain change that closes the gap (or moves tsgo to TS2742) turns the bench red. **Self-contained
  and non-destructive** — scaffolds under the OS temp dir (never the repo tree), removes it on exit,
  needs no worktree → `bench/decl-emit-caveat.json`, folded into OPTIMAL-STACK.md.
- `node scripts/wave-rollout-bench.mjs` — the **rollout-mechanics vet**: the load-bearing facts for
  advancing an internal core lib through a hermetic, wave-based rollout, measured as a **bun-vs-pnpm
  head-to-head** (writeup in ROLLOUT.md, which recommends bun: it does all of it natively and cold-installs
  58–440× faster than pnpm, `bench/install-bench.json`). Five rungs on self-contained temp scaffolds, each
  HARD-ASSERTING a stable fact; the bun behaviors are cross-checked against bun's source at `bun-v1.3.14`
  (and the script asserts it is running 1.3.14). (1) **Determinism** — the lockfile, not the range, is the
  boundary: bun with a committed `bunfig.toml [install] frozenLockfile=true` FAILS CLOSED on drift (bare
  `bun install` exit 1, lock unchanged) — bun does not auto-enable frozen in CI (only pnpm does), so that
  one committed line is how you get it; pnpm `--frozen-lockfile` is byte-identical across runs and fails
  closed (`ERR_PNPM_OUTDATED_LOCKFILE`). (2) **Named-catalog lanes** — `catalog:stable`/`catalog:next`
  route two cohorts to two versions in one lockfile and a repoint edits 0 consumer manifests, natively on
  both (bun in `package.json` `workspaces.catalogs`, pnpm in `pnpm-workspace.yaml`). (3) **workspace: as a
  catalog value** — bun ACCEPTS it and links the local package; pnpm REJECTS every form
  (`ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC`). (4) **Publish bakes a CONCRETE range** —
  `bun pm pack` / `pnpm pack` rewrite a lib's internal `workspace:^`→`^2.5.0`, so a lib every other lib
  re-exports advances by republishing its dependents, not a one-line flip. (5) **Cross-tool gotcha** — bun
  does not read catalogs from `pnpm-workspace.yaml`, so author them in `package.json`. **Self-contained and
  non-destructive** — scaffolds throwaway workspaces under the OS temp dir, pins each to public npm for one
  tiny real dep, removes them on exit, needs no worktree → `bench/wave-rollout-bench.json`, writeup in
  ROLLOUT.md.
- `node scripts/bun-safety-bench.mjs` (`BUN_SAFETY_NO_CA=1` to skip the CodeArtifact rung) — the
  **bun-adoption-safety vet**: de-risks ROLLOUT.md's bun recommendation by measuring whether a bun install
  is as SAFE as pnpm's (not as fast — speed stays in `install-bench.json`), as a **bun-1.3.14-vs-pnpm-10
  head-to-head** built to surface where bun is WORSE. Behaviors are MEASURED and recorded (booleans / exit
  codes / signal strings); only measurement-validity invariants are asserted (the tool ran without a crash,
  the install resolved), so an unplanned bun problem becomes data, not a red bench. Four rungs on
  self-contained temp scaffolds (no worktree): (A) **lifecycle scripts** — a local `file:` dep's postinstall
  is BLOCKED by default on both (mainProbe: the generated file is absent), each printing a remediation hint;
  the asymmetry is bun's built-in trusted ALLOWLIST, which runs esbuild's postinstall (each tool's own
  self-report — pnpm "Ignored build scripts", bun `bun pm untrusted` — since esbuild ships its binary via a
  platform optionalDependency, so a binary-presence proof can't tell run from blocked) where pnpm 10 blocks
  it. (C) **peer resolution** — both warn on a version mismatch (bun on stderr; `run()` merges `2>&1` so the
  stderr-only warning is captured) and both auto-install a missing peer at their defaults (pnpm
  `auto-install-peers` defaults to true), probed via whether the PLUGIN resolves its peer, not root
  visibility (which is the hoist-vs-isolation layout, = rung D) — parity; the one gap is the fail-closed
  knob: pnpm `strict-peer-dependencies=true` exits 1, none of bun's three knobs (env / `.npmrc` /
  `bunfig.toml`) flips its exit. (D) **phantom dependency** — an undeclared transitive import resolves under
  bun's hoist, fails under pnpm's isolation (pnpm's edge). (B) **CodeArtifact auth** — a publish + install
  round-trip against the real `@ejc3` registry, host-verified (absent package → 404 from the CA host, not
  401); the install is bun vs pnpm, the publish is bun vs npm (pnpm has no native publisher, disclosed via
  `publishCmd`); `sameAuthPathAsPnpm` requires both round-trips + host-verify + the 404 proof; self-cleaning
  (deletes only this run's FIXED version, re-listed to confirm — tri-state so a list failure never reads as
  clean); skips to `bun-safety-bench.partial.json` without AWS creds. Net: 2 genuine bun gaps, 1 pnpm
  advantage, the rest parity → `bench/bun-safety-bench.json`, folded into ROLLOUT.md ("Adoption safety,
  vetted") + SUMMARY.md.

### Deploy / publish
- `make deploy-vercel` — prune one `APP` to a minimal subtree, deploy to Vercel, time it.
- `make diamond` — publish to AWS CodeArtifact; show diamond deps + `workspace:` override collapse.
- `make per-app` — the per-app-workspace model (each app its own workspace + lockfile,
  libs consumed from the registry). Live on CodeArtifact: a transitive lib resolving
  local in one app and from the registry in another (which one shared root cannot do
  per-app), plus the `workspace:^` → `^x.y.z` publish rewrite. Writeup in
  WORKSPACE-VS-SEMVER.md §7.

### Environment
- `node scripts/env.mjs` — capture CPU/RAM/OS/tool versions → `bench/env.json` (report with every result).

### Shared internals (not run directly)
- `scripts/_source-visible.mjs` — `enterSourceVisible(root)`: makes generated source
  visible to Turbo's hashing for a run (see lessons). Imported by `measure.mjs`,
  `axis-bench.mjs`, `dev-sim.mjs` (`sweep.mjs` shells out to `measure.mjs`).
- `scripts/generate.mjs`, `scripts/rewrite-protocols.mjs` — workspace scaffolding.
- `scripts/diamond-demo.sh` (the `make diamond` driver) → `scripts/diamond-scaffold.mjs` —
  CodeArtifact publish + diamond-deps / `workspace:`-override demo.
- `scripts/per-app-workspace-demo.sh` (the `make per-app` driver) — scaffolds two
  sibling app workspaces + a libs workspace into `examples/per-app-workspace`
  (gitignored) and asserts (hard fail on mismatch) transitive per-app divergence
  via a per-app root override, plus the `workspace:^`→`^1.0.0` rewrite (proven
  locally with `pnpm pack`). For its own resolution proof it publishes
  `@ejc3/util`+`@ejc3/ui` at a fixed version, fresh each run, and deletes them on
  exit (self-cleaning). Removes the local example tree on exit; touches no `bench/*.json`.
- `scripts/registry-resolution-demo.sh` (the `make registry-resolution` driver) —
  the sibling demo for the three direct-spec cases (a registry / b override /
  c `workspace:*`); publishes `@ejc3/reslib` fresh and deletes it on exit.
- **CodeArtifact:** the dev-server role can publish AND delete versions
  (`codeartifact:DeletePackageVersions` granted), so the publishing demos
  (`make diamond`, `make registry-resolution`, `make per-app`) self-clean — they
  publish a fixed version fresh (pre-deleting any leftover) and delete it on exit.

## Data of record

`bench/*.json` is the source of truth; the docs must not contain a number that
isn't backed by one of these. `bench/env.json` records the machine. `chart.mjs`
(re)generates `bench/charts/*.svg` and `bench/summary.md` from `results.json`
(deterministically for a given dataset); it keeps and warns about a doc-linked chart
it can't regenerate this run rather than deleting it (it exempts charts owned by another
generator from that warning + cleanup). `comparison-chart.mjs` renders the
`bench/charts/tool-comparison.svg` tool head-to-head heatmap (install, typecheck, build,
pnpm install-situations) from the comparison benches, embedded in the README. Docs: `README.md` (overview +
scaling table + dev-sim), `TOOLING.md`
(install / build / typechecker comparisons), `LIMITS.md` (what stays O(repo),
incl. the TEST-execution axis O(repo)-vs-O(closure) + foundation test blast radius,
`bench/test-axis-bench.json`), `OPTIMIZATIONS.md`, `GROUNDING.md` (industry-best-practice sourcing),
`OPTIMAL-STACK.md` (the bun + tsgo + oxlint + turbo gate at 4,000:400, with the
tsgo-vs-tsc parity vet on real types, the app + lib developer O(closure) inner loops, a
real-app vet running the stack on vercel/commerce + shadcn/taxonomy, and the
declaration-emit caveat where the gate's `declaration:false` misses a `.d.ts` portability error),
`SUMMARY.md` (the shareable cross-role synthesis — the app and lib personas' fresh-vs-subsequent
inner loops plus the workspace-author core-package gate and the real-app results, every figure
traced to a `bench/*.json`), `ROLLOUT.md` (advancing an internal core lib through a hermetic,
wave-based rollout, driven with bun — the lockfile-not-the-range determinism boundary with frozen vs
not-frozen, the bun-native recipe (committed `bunfig` frozen, `package.json` named-catalog cohorts, the
`workspace:` HEAD-tracking partition, the concrete-range publish rewrite) measured against pnpm as a
head-to-head with bun cold-installing 58–440× faster, the direct-clean vs universal-republish-fanout
distinction, expand/migrate/contract for breaking changes, gating the artifact not just the source,
the "Adoption safety, vetted" subsection — bun is adoptable but not a strict safety superset (two real
gaps: the built-in lifecycle-script allowlist, no fail-closed strict-peer knob; plus pnpm's
phantom-isolation edge; the rest parity), and pnpm as the fallback; backed by
`bench/wave-rollout-bench.json` + `bench/bun-safety-bench.json` + `bench/install-bench.json`).

## Measurement methodology (how the numbers stay honest)

These rules keep the measurements from cheating. Each is implemented per-script
where it applies — not all are universal (noted inline):

- **Never let a failure read as success.** The tool-comparison benches
  (`install-bench`, `lockfile-bench`, `axis-bench`, `perf-matrix`, `build-bench`)
  throw on any failed step. `measure.mjs` instead records `ok: false` per phase and
  skips dependent phases. Either way a failed step never silently becomes a `0` or a
  clean time. Stat helpers run under `set -o pipefail` and reject non-numeric output.
- **Cold is actually cold.** Before a measured cold turbo run (typecheck/build):
  clear `.turbo` + the pinned `TURBO_CACHE_DIR` (and `node_modules/.cache/turbo`).
  Before a measured cold *install*: wipe `node_modules` (full-tree where the
  workspace isn't regenerated between runs; via `generate --clean` where it is).
  `measure.mjs` records a daemon/graph warmup (`warmupOk`) so the cold typecheck
  excludes turbo daemon spin-up.
- **Warm-store, comparable installs.** The install-comparison benches
  (`install-bench`, `lockfile-bench`, `axis-bench`, `perf-matrix`) pre-warm the
  package store before measuring, so "warm" means warm-store; `install-bench`'s
  "truly-cold" pass uses a fresh store + network.
- **Source must be visible to Turbo.** The generated apps/packages are gitignored,
  and Turbo respects `.gitignore` for input hashing — so without intervention it
  hashes nothing, making warm-cache and edit-rebuild numbers false cache hits and
  understating hashing cost (a cache-cleared cold run still executes, but its input
  hashing is unrepresentative). `enterSourceVisible()` (used by `measure`,
  `axis-bench`, `dev-sim`) drops the
  source-ignore lines for the run and restores them after; it **asserts** via
  `git check-ignore` that source actually became visible and throws otherwise.
- **Verify completeness where it matters.** A `pnpm install` that exits 0 can still
  be partial. `install-bench` and `axis-bench` verify every package resolves all its
  deps (incl. devDependencies) *after the timed install* (so the check isn't counted)
  and abort if any are missing, so a silently-partial install can't be recorded as an
  artificially low number.
- **Report honestly.** True median (not min); lockfile size as `wc -l`; apparent
  size labeled as apparent; charts plot measured counts, not estimates; confounded
  datapoints are skipped/marked, not presented as clean.
- **Every doc number traces to a bench JSON.** Extrapolations beyond the measured
  ceiling are labeled as extrapolations.

## Lessons (gotchas found the hard way)

- **Turbo caches in the PRIMARY worktree.** In a git worktree, Turbo writes its
  cache to the *primary* worktree's `.turbo`, so a worktree-local `rm .turbo` does
  **not** clear it and "cold" runs become stale cache hits. Pin
  `TURBO_CACHE_DIR=<tree>/.turbo/cache` in every turbo-running bench. This was the
  central correctness bug — a "cold" typecheck read 1.4s when the real cold was ~19s.
- **`turbo --force` can't combine with `--cache`.** To force local-only execution
  use `--cache=local:rw` (disables remote cache) and clear `.turbo` first.
- **`turbo prune` respects `.gitignore`,** so it skips generated source. Either pass
  `--use-gitignore=false` (and strip build outputs first, since that also un-ignores
  `.next`/`dist`/`.turbo`/`*.tsbuildinfo`) or run under `enterSourceVisible`.
- **Don't run benches concurrently in the same working tree.** They share `.turbo`,
  `.gitignore`, and `node_modules` and corrupt each other's measurements — use
  separate git worktrees for parallel runs.
- **`generate.mjs --clean` deletes per-package `node_modules`,** so a root-only
  cleanup is enough when you regenerate each iteration; benches that don't
  regenerate between cold/warm must wipe the full tree explicitly.
- **A single synthetic probe can't detect every `.gitignore` form.** Check a real
  generated `apps/<name>/package.json` path (matches `/apps/`, `apps/**`,
  `/apps/app-*/`, …), and use `execFileSync` (no shell) so a probe path is never
  interpreted as a command or flag.

## Writing style (docs, comments, commit messages, replies)

Plain technical prose. This is the house style — match it in new docs, comments,
commit messages, and replies.

- **No marketing or promotional language.** No "blazing fast", "powerful",
  "seamless", "effortless", "game-changing". (Plain technical uses are fine —
  e.g. "robust to X" meaning resilient.) Describe what something does and what it costs.
- **State results plainly; do not hedge.** Report what was measured and what it
  means. A real limitation is stated as a fact, not softened into an apologetic
  caveat. Avoid filler ("it's worth noting", "of course", "simply", "just").
- **Every claim is backed by data.** A number must trace to a `bench/*.json`;
  extrapolations beyond the measured range are labeled as extrapolations. No
  unbacked superlatives.
- **Lead with the result,** then the detail. Be terse.

## Reviewing each commit

Every commit goes through this loop before it lands — no exceptions, docs included:

1. **Gather the diff** (`git diff` / the change under review).
2. **Run the `/code-review` skill** on it (multi-angle finders → verify → gap sweep).
   It is self-runnable here; the cloud `ultra` variant is the separate
   user-triggered/billed one.
3. **Run a `codex` adversarial pass** (`codex exec -s read-only`) as an independent
   second reviewer — both this and `/code-review`, not one or the other. For docs,
   have codex fact-check every claim against the scripts and `bench/*.json`.
4. **For substantive code changes,** add an adversarial verification pass: skeptic
   agents (or codex) that try to *refute* each fix, plus a regression check that no
   published number moved.
5. **Fix the root cause of every finding** and re-review until it comes back clean.
   Never skip, suppress, or rationalize a finding.
6. **`prettier --check` clean,** then commit. The message describes what's actually
   in the diff (see the global `~/.claude/CLAUDE.md` commit conventions).

## Mandatory doc-sync pass

Whenever a doc lands or a `bench/*.json` it cites changes, run a doc-sync pass before the
work is "done" — no exceptions. It is the doc analogue of the per-commit review, and it is
**mandatory**, not a nicety: docs drift out of sync with the benches and with each other,
and the AI failure mode is leaving process-vs-result sloppiness in the prose. Fan the pass
out across the affected docs (parallel agents / a workflow, per the worktree guidance below),
each doc getting all four lenses, then verify every finding and fix the root cause:

1. **Fairness / no-bias.** Every tool-vs-tool comparison is like-for-like (same scale, same
   regime). Flag any contrast that pits one tool's best case against another's worst, any
   claim stronger than the data, any superlative not backed by a `bench/*.json`. State both
   sides; a real advantage of the non-recommended option is reported, not buried.
2. **No process archeology / hedging.** State results, not the path to them. No "assumed vs
   verified", "measured vs not measured", "honest limitations", apologetic caveats, or
   internal-iteration narration. A plain sourced limitation stated as a fact is fine.
3. **Number-tracing.** Every figure traces to a `bench/*.json` field; extrapolations beyond
   the measured ceiling are labeled as such. Read the cited JSON and confirm, don't trust.
4. **Loose ends + cross-doc sync.** No dangling/stale references; no internal contradictions.
   Keep the cross-doc spine in sync: the **README "Findings by area" front-door index** links
   every current companion doc, the new finding is folded into `SUMMARY.md`/`OPTIMAL-STACK.md`
   where it belongs, and the **`## Data of record`** doc list above names the new doc + bench.

Run `codex exec -s read-only` as the independent second reviewer on each doc (fact-check every
claim against the scripts and `bench/*.json`), same as the per-commit loop. Gather any
genuinely open questions (decisions only the owner can make, or unmeasured extensions) into a
short list and surface them rather than silently resolving them.

## Working in this repo

- **Under `/effort` ultracode, parallelize with git worktrees.** Fan independent
  benches or edit streams out into separate worktrees (e.g. `~/src/<name>`, per the
  global `~/.claude/CLAUDE.md` layout) and run them concurrently. This is required,
  not just an optimization: benches in the *same* tree share `.turbo`, `.gitignore`,
  and `node_modules` and corrupt each other (see the concurrency lesson). Pin
  `TURBO_CACHE_DIR` per worktree, and remove each worktree once its work merges.
- **`.prettierignore`** skips `*.md`, `pnpm-workspace.yaml`, `bench/`. Keep a large
  formatting sweep as its own mechanical commit, separate from logic changes.
- **Re-running benches is expensive;** get the code reviewed and correct first, then
  run once.

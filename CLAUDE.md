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
  Next 16 (byte-identical output) → `bench/turbopack-bench.json`.
- `node scripts/fs-bench.mjs <apps>:<libs>` (default `300:100`) —
  `package-import-method` on a CoW filesystem (btrfs reflink) vs hardlink (ext4):
  relink time + exclusive disk → `bench/fs-bench.json`.

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
it can't regenerate this run rather than deleting it. Docs: `README.md` (overview +
scaling table + dev-sim), `TOOLING.md`
(install / build / typechecker comparisons), `LIMITS.md` (what stays O(repo)),
`OPTIMIZATIONS.md`, `GROUNDING.md` (industry-best-practice sourcing),
`OPTIMAL-STACK.md` (the bun + tsgo + oxlint + turbo gate at 4,000:400).

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

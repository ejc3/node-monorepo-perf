# Next.js Monorepo Scale Lab

Benchmark rig for a pnpm + Turborepo workspace of N Next.js apps and M shared libraries, with a layered dependency graph, measured to 4,000 apps / 300 libs (test-execution axis to 1,000 apps / 200 libs).

Whole-workspace operations (install, typecheck, warm `turbo run`, `turbo prune`'s graph load) scale with package count. A focused build (`turbo run --filter=<app>...`) executes one app's dependency closure and grows with that closure (×1.8 here), not app count. Avoid unscoped whole-repo execution. Numbers in [Results](#results-scaling-behavior).

Three layers of focus: install-time (`pnpm deploy` / `turbo prune @demo/app-2000 --docker`), task-time (`turbo run build --filter=@demo/app-2000...`), artifact-time (`turbo prune ... --docker` → `out/`). Measured by `scripts/measure.mjs` → [`bench/results.json`](bench/results.json).

## The Workspace Under Test

The workspace-scaling numbers in these docs are measured on one generated workspace shape, scaled by `APPS`/`LIBS`:

- **N Next.js apps** (`apps/app-*`): App Router, one layout + one page each — deliberately tiny, so app *count* is the variable under test, not app size.
- **M shared TypeScript libs** (`packages/lib-*`): each holds 16 generated modules re-exported through `src/index.ts`, and builds to `dist/` with tsc (`dependsOn: ["^build"]`).
- **A layered lib graph**: libs split into 6 layers; each lib imports up to 3 libs from the layer directly below it, and layer-0 libs import nothing. The graph is a DAG — closure depth is bounded by the layer count, and closures overlap heavily (many features share the same low-layer libs).
- **Each app imports 4 libs** spread across the lib range; with transitive deps an app's closure is 75–124 packages at the measured scales.
- **An optional universal foundation tier** (`--universal K`): libs 1..K become pure sinks imported by every app and every other lib — the `@acme/core` everyone imports. Off in the scaling table below; the blast-radius benches (lib-rev, optimal-gate, test-axis, the remote-cache partial-invalidation rung) turn it on.
- **Internal deps** are `workspace:*` links; one pnpm catalog pins the Next/React/TS versions (`--versioned` switches to `workspace:^x.y.z`, see [WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md)).

At 100 libs / 6 layers the shape is:

```
apps     app-001 … app-N            each app imports 4 libs, from any layer
           │
           ▼
libs     layer 5   lib-086 … lib-100  ─┐
         layer 4   lib-069 … lib-085   │  each lib imports ≤3 libs
         layer 3   lib-052 … lib-068   │  from the layer directly
         layer 2   lib-035 … lib-051   │  below it
         layer 1   lib-018 … lib-034   │
         layer 0   lib-001 … lib-017  ─┘  imports nothing (sinks)

         --universal K:  libs 1..K imported by every app and every other lib
```

A few benches measure a different corpus and say so where they report: the million-module checker sweeps (one program, not a workspace), the lint corpus, the type-parity scaffold, and the real-app vet.

### Quick start

```bash
# 1. generate a workspace (start at 200–2,000 apps)
pnpm install
pnpm gen -- --apps 200 --libs 100 --modules 16 --clean
pnpm install

# 2. exercise the three focus layers
turbo run build --filter=@demo/app-00100...   # focus build (one app's closure)
turbo run typecheck                            # whole-workspace typecheck
turbo prune @demo/app-00100 --docker           # minimal deploy subtree
```

`generate.mjs` flags (defaults): `--apps` 50, `--libs` 50, `--modules` 16, `--app-deps` 4, `--lib-deps` 3, `--layers` 6.

## Results: Scaling Behavior

Environment details are in `bench/env.json` (Neoverse-V1, 64 cores, 135 GB, arm64; Node 22, pnpm 10.29, Turbo 2.9, tsc 5.9.3). Four scale points, 200 → 4,000 apps (20× apps, ~14× packages); larger scales extrapolate. The tsc/prune/focus columns via `scripts/measure.mjs` → `bench/results.json`; the `tsgo whole` column via `scripts/tsgo-scale-table-bench.mjs` → `bench/tsgo-scale-table.json` (same trees, same scales).

| apps (libs) | tsc cold¹ | tsc warm¹ | tsgo whole² | focus build³ | prune | build tasks | focus closure |
|---|---|---|---|---|---|---|---|
| 200 (100) | 19.0s | 1.5s | 0.26s | 11.5s | 0.9s | 300 | 75 |
| 1,000 (200) | 68.9s | 5.0s | 0.51s | 14.2s | 2.7s | 1,200 | 124 |
| 2,000 (300) | 127.2s | 7.6s | 0.81s | 15.5s | 5.3s | 2,300 | 100 |
| 4,000 (300) | 233.4s | 20.5s | 1.18s | 21.1s | 7.6s | 4,300 | 121 |

¹ `turbo run typecheck`: turbo-orchestrated tsc (a `tsc --noEmit` per package behind a tsc `^build`), cold then warm-cache hit.
² `tsgo whole` — the recommended checker: one `tsgo --noEmit` over the whole workspace from source (`@demo/*`→`packages/*/src`), median of 3, peak RSS 235→857 MB (`bench/tsgo-scale-table.json`). tsgo keeps no incremental cache, so this cold number is its steady state — faster than even the tsc *warm* hit (17× at 4,000 apps). Different mechanism than the tsc columns (one process, no dist build); the per-package turbo+tsgo path is priced in [OPTIMAL-STACK.md](OPTIMAL-STACK.md).
³ `turbo run build --filter=<one app>...` (app + library closure); generated source made visible to Turbo for the run so warm/graph-load numbers reflect real per-package hashing. Install measured separately in [TOOLING.md](TOOLING.md#install-bun-vs-pnpm-vs-yarn-4).

Scaling factor, 200 → 4,000 apps:

| operation | factor | class |
|---|---|---|
| tsc cold | ×12.3 | O(repo); ~linear in package count (×14) |
| tsc warm | ×13.3 | O(repo); Turbo hashes every package on a full hit |
| tsgo whole | ×4.5 | O(repo), but sub-linear — program size grew ×7.4, startup amortizes |
| prune | ×8.3 | O(repo); reads the whole graph |
| focus build | ×1.8 | O(closure); closure grew 75→121 while apps grew 20× |

Two things stay cheap as the repo grows. The focus build tracks one app's closure (75–124 packages), not app count. And the whole-workspace type-error gate is cheap on the recommended checker: tsgo checks all 4,000 apps from source in **1.18s** — 198× the turbo-orchestrated tsc column (which also builds each lib's dist, work tsgo skips), and faster than even its warm-cache hit — so it stays O(repo) but in seconds, not minutes. Extrapolating to 20,000 apps: the tsc build+typecheck path reaches tens of minutes, the tsgo whole-program gate stays in low single-digit seconds, the focused build in tens of seconds. What stays irreducibly O(repo) is in [LIMITS.md](LIMITS.md). To avoid the tsc-path O(repo) cost, scope with `--filter=<app>...` / `--affected`; an unscoped `turbo run` enumerates the whole graph even on cache hits. Past ~20,000 apps, loading one graph is itself O(repo), so shard.

### Charts
![whole-workspace typecheck via turbo-orchestrated tsc, cold vs warm](bench/charts/typecheck-cold-vs-warm.svg)
![focus vs full](bench/charts/focus-vs-full.svg)
![lockfile size vs scale](bench/charts/lockfile-vs-scale.svg)

## Day-to-Day Developer Simulation

`scripts/dev-sim.mjs`, D developers each owning two apps + one lib in a 1,000-app / 200-lib workspace (1,200 packages), `--devs 4 --apps 1000 --libs 200`:

| operation | cost |
|---|---|
| onboarding: build a feature area (apps + lib closure) | median 10.8s |
| typecheck-on-save: edit an app, typecheck it | median 4.3s |
| build-before-push: edit an app, build it + closure | median 5.8s |
| lib-edit: rebuild your lib + dependents (21 packages) | median 11.6s |
| independence: a teammate's unrelated edit | adds 0 rebuilds |
| edit foundation lib (`lib-003`, low layer) | 1,080 of 1,200 packages rebuild |
| edit high-layer lib (`lib-197`) | 21 packages rebuild |

The inner loop is O(closure); a teammate's unrelated app adds zero rebuilds; a low-layer foundation lib rebuilds ~90% — why foundation edits lean on the remote cache and CI `--affected`. Optimization playbook in [`OPTIMIZATIONS.md`](OPTIMIZATIONS.md).

## Artifacts

- One app [deployed to Vercel](https://nextjs-monorepo-scale-demo.vercel.app) (pruned subtree, cloud build; 22s wall; `bench/deploy.json`).
- Four packages published to AWS CodeArtifact for the diamond demo (`scripts/diamond-demo.sh`).

## Findings by Area

Each companion doc measures one cost, with the bench JSON behind it.

**When a shared workspace is worth it.** It fits apps that share code and versions: the daily loop is O(closure) and the heavy O(repo) costs land on rare events, amortized by the committed lockfile and remote cache. Wrong fit for independent apps. Decision table in [FEASIBILITY.md](FEASIBILITY.md).

### Tooling Head-to-Head

Fastest install depends on what is cached and on workspace size; tsgo runs ~8.8–12× faster than tsc. Regenerate with `node scripts/comparison-chart.mjs`.

![tooling head-to-head: install (bun vs pnpm vs yarn), CI-runner frozen install (bun vs pnpm vs yarn vs npm, containers), typecheck (tsc vs tsgo), build (Next vs Vite), pnpm install situations, and lint (ESLint vs oxlint)](bench/charts/tool-comparison.svg)

> High-resolution PNG of the chart above: [`bench/charts/tool-comparison.png`](bench/charts/tool-comparison.png).

The chart below uses the same heat-table style for a different question: how tsgo, tsc, and Flow behave as one TypeScript program grows to a million modules (full analysis in [TYPECHECKERS.md](TYPECHECKERS.md)):

![type checkers at scale: whole-program check, red vs green, the save loop by mechanic, completion, and the flow wedge A/B](bench/charts/checker-scale.svg)

> High-resolution PNG of the chart above: [`bench/charts/checker-scale.png`](bench/charts/checker-scale.png). Regenerate with `make scale-chart`.

- **Install cost.** pnpm cold install resolve-bound, ~linear: 47.8s → 471.2s (200 → 2,000 apps); bun 62–357× faster; yarn 4 scales flatter, overtaking bun at 2,000 apps. Cold resolve is rare with a committed lockfile: frozen install 7–9s at 1,000 apps; a missing lockfile pays ~16 min at 4,000 apps. ([FEASIBILITY.md](FEASIBILITY.md), [TOOLING.md](TOOLING.md))
- **CI-runner install (frozen, containers).** Five-way at 1,000 apps: **bun 0.9s** fresh / **0.4s** cache-restored, yarn-PnP 4.4s/2.2s, yarn-nm 6.5s/4.2s, pnpm 8.9s/7.0s, npm 10.4s/9.7s. All fail closed on lockfile drift. ([TOOLING.md](TOOLING.md))
- **yarn as rollout driver + PnP boundary.** yarn 4 runs every rollout mechanic natively (byte-identical resolves, `--immutable` fail-closed, CI auto-immutable, named catalogs, concrete-range `yarn pack`). Under PnP tsc/turbo/oxlint run; stock tsgo and default Turbopack do not — green paths are the tsgo native PnP resolver ([typescript-go#460](https://github.com/microsoft/typescript-go/issues/460)) and `next build` via webpack or **rspack**. ([ROLLOUT.md](ROLLOUT.md), [TOOLING.md](TOOLING.md#yarn-pnp-toolchain-compatibility))
- **Vite Task (Vite+) vs Turborepo.** turbo wins whole-repo typecheck 2–3.7×; vp wins the focused loop, flat across 3× repo growth (0.85s → 0.86s vs turbo's 1.2s → 3.0s warm), correct on gitignored/cross-package edits but refuses self-mutating tasks (`next build`, `vite build` uncacheable). ([TOOLING.md](TOOLING.md))
- **`node_modules` footprint.** Cold install within ~3% across `isolated`/`hoisted`; hoisted relinks 1.6–3.3× faster warm. `isolated` 86,749 entries / 49,712 symlinks at 4,000 apps; PnP shrinks it to 64 unplugged entries + a 0.8–3.5 MB `.pnp.cjs`. ([OPTIMIZATIONS.md §1](OPTIMIZATIONS.md#1-install-time-pnpm), [TOOLING.md](TOOLING.md))
- **Lockfile.** Irreducibly O(repo): 9,897 → 153,967 lines (200 → 4,000 apps). A `catalog:` bump edits **0** app manifests (vs 25 pinned) but rewrites hundreds of lockfile lines; two concurrent bumps conflict (253 markers), `pnpm install` auto-resolves to 0. ([OPTIMIZATIONS.md §1.5](OPTIMIZATIONS.md#15-lockfile-churn-and-merge-conflicts), [LIMITS.md](LIMITS.md))
- **Type-checking.** Whole-repo typecheck O(repo): cold 19s → 233s, warm 1.5s → 20.5s. tsgo ~12× faster per check, drop-in for modern configs but beta. At a million modules tsgo checks in 68.7s at 53.7GB RSS; Flow completes the sweep at +32% of tsgo on a third the memory and answers one edit in **324ms at 1M** (flow-main build; released 0.321 crashes at scale) vs tsgo's LSP 2.2s. Behind codegen, relay-compiler generates 10k artifacts in ~4s, tsgo then checks in 0.71s / Flow 1.6s. ([TYPECHECKERS.md](TYPECHECKERS.md))
- **Build.** On Next 16, Turbopack is already the default bundler, so `next build` and `next build --turbopack` run the identical build — the flag is redundant and the two measure the same. A Vite SPA builds ~2.3× faster with ~20× less output, but that is a different feature set (a client SPA, not Next's server rendering). ([OPTIMIZATIONS.md §3](OPTIMIZATIONS.md#3-nextjs-build-cost), [TOOLING.md](TOOLING.md))
- **Lint.** oxlint lints an 800-file corpus in **190ms** (full **567**-rule set); ESLint runs the **524**-rule subset in **12.0s** / **1.9s** cached — oxlint **63.3×** / **10.1×** faster. `oxlint --type-aware` flags `no-floating-promises` in **397ms** vs ESLint's **4.5s** (**11.3×**). ([TOOLING.md](TOOLING.md))
- **Test execution.** Whole-repo `turbo run test` is one task per package (400 at 300:100, 1,200 at 1,000:200; cold 5.8s → 15.1s, warm 1.6s → 5.4s). Scoping is O(closure): a focused closure is 124 of 1,200 tasks; a leaf-lib edit re-tests 21 vs a universal-foundation edit's 1,200 (~57× spread). ([LIMITS.md](LIMITS.md))
- **Focus / deploy.** `turbo prune` emits a complete subtree (0 of 15 packages missing) + a pruned lockfile (876 of 3,969 lines) but omits root configs (`tsconfig.base.json`). One app deployed to Vercel in 22s. ([OPTIMIZATIONS.md §4](OPTIMIZATIONS.md#4-ci-and-deploy))
- **Semver vs `workspace:`.** `workspace:` forces local linking; `pnpm publish` rewrites it to a real range. Proven on CodeArtifact: a diamond keeps both majors under the isolated linker, a root override collapses it, and per-app transitive divergence needs a separate workspace + lockfile. The when-do-two-copies-exist rules (workspace-vs-registry edges, range convergence) in [§8](WORKSPACE-VS-SEMVER.md#8-when-two-copies-exist-and-when-they-converge). User stories in [STORIES.md](STORIES.md). ([WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md))
- **Optimal type-error gate (4k:400).** On bun + tsgo + oxlint + turbo: a whole-program gate over 4,000 apps runs in 1.32s; a breaking foundation signature is caught as every app red (4,399 `TS2554`). The fast `declaration:false` gate misses a `.d.ts` portability error the build catches. ([OPTIMAL-STACK.md](OPTIMAL-STACK.md))
- **Developer inner loops.** Per-role O(closure) loops on the optimal stack (app dev, lib dev), fresh vs subsequent: typecheck, lint, focused gate all in seconds. Also run on real apps (vercel/commerce, shadcn/taxonomy). ([SUMMARY.md](SUMMARY.md), [OPTIMAL-STACK.md](OPTIMAL-STACK.md))
- **Core-lib rollout.** The lockfile is the determinism boundary (frozen install makes the range form inert); bun drives it natively and re-resolves ~62–357× faster than pnpm with no usable lockfile. A universal lib is a republish-fanout; breaking changes go expand→migrate→contract. ([ROLLOUT.md](ROLLOUT.md))
- **bun adoption safety.** Adoptable with two real gaps (built-in allowlist runs registry `postinstall` pnpm 10 blocks; no fail-closed strict-peer knob) plus pnpm's phantom-isolation edge in single-package projects. The rest is parity. ([ROLLOUT.md](ROLLOUT.md#adoption-safety), [SUMMARY.md](SUMMARY.md))
- **Remote cache (CI economics).** Turborepo caches each task's outputs (built files, the typecheck result) keyed by a hash of its inputs — the task's source, its dependencies' outputs, and global inputs like `tsconfig.base.json` and the pinned tool versions. A shared cache lets a later CI runner download an unchanged task's stored output instead of recomputing it, turning the O(repo) cold start into a restore: typecheck **23.6s → 1.9s** (12.5×, 300:100) and **67.2s → 5.9s** (11.4×, 1,000:200), build **62.7s → 4.0s** (15.5×, 300:100). It only helps a task whose inputs are unchanged: after a leaf-lib edit **486 of 500** tasks still hit the cache, but a foundation-lib edit rehashes every dependent so **0 of 500** do. Across a 10-runner fleet it amortizes ~5.6×. ([LIMITS.md](LIMITS.md#remote-cache-amortizing-the-orepo-cold-start))
- **Editor / language server.** Opening one app is O(closure): the server loads its closure (65 libs / 1,123 files), flat as the repo grows 8×. tsgo's native LSP opens it in **86ms vs tsserver's 1,620ms** (18.8×) with **275 vs 380MB** RSS; warm, both answer def/hover in ≤2ms. ([LIMITS.md](LIMITS.md#editor-and-language-server))
- **The ceiling.** What focus, cache, and `--affected` cannot remove at ~20,000 apps: the single lockfile, the per-command Turbo graph-load floor, foundation blast radius (~90% of packages), inode/disk pressure, language-server memory, git worktree cost, Vercel's per-project model. Past this, shard or move to a daemon + remote-execution build system. ([LIMITS.md](LIMITS.md))

Methodology and grounding: [GROUNDING.md](GROUNDING.md) maps each practice to its primary source; [REVIEW.md](REVIEW.md) is the quality pipeline every change runs through.

## License

MIT, see [LICENSE](LICENSE).

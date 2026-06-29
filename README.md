# Next.js Monorepo Scale Lab

Benchmark rig for a pnpm + Turborepo workspace of N Next.js apps and M shared libraries. It generates the workspace with a layered dependency graph and measures install, typecheck, build, and the scoped ("focus") operations to 4,000 apps / 300 libs, plus a test-execution axis to 1,000 apps / 200 libs.

Result: whole-workspace operations — install, typecheck, even a warm-cache `turbo run`, and `turbo prune`'s graph load — scale with package count. A focused build (`turbo run --filter=<app>...`) executes only one app's dependency closure and grows with that closure (×1.8 here), not with app count. The workflow avoids unscoped whole-repo execution. Numbers in [Results](#results-scaling-behavior).

---

## The three layers of "focus"

| Layer | Question it answers | Tool | Command |
|---|---|---|---|
| **Install-time** | "Install only *this* app's dependency closure" | `pnpm deploy` / `turbo prune` | `turbo prune @demo/app-2000 --docker` |
| **Task-time** | "Build/typecheck only the affected packages" | Turborepo filters | `turbo run build --filter=@demo/app-2000...` |
| **Artifact-time** | "Ship a minimal subtree to CI/Vercel/Docker" | `turbo prune` | `turbo prune @demo/app-2000 --docker` then build `out/` |

Measured by `scripts/measure.mjs`, recorded in [`bench/results.json`](bench/results.json). See [Results](#results-scaling-behavior).

---

## Architecture

```
pnpm-demo/
├── pnpm-workspace.yaml     # workspace globs + catalog (single source of dep versions)
├── turbo.json              # build/typecheck task graph (dependsOn ^build)
├── tsconfig.base.json      # shared compiler options
├── scripts/
│   ├── generate.mjs        # emit N apps + M libs with a layered DAG (--versioned, --framework vite)
│   ├── measure.mjs         # timed benchmark harness -> bench/results.json
│   ├── sweep.mjs           # run measure across a matrix of sizes
│   ├── perf-matrix.mjs     # install variants: specifier form, node-linker
│   ├── chart.mjs           # render scaling charts (SVG) from results
│   ├── comparison-chart.mjs # render the tool head-to-head heatmap (SVG)
│   ├── deploy-vercel.mjs   # prune one app -> cloud build on Vercel, timed
│   ├── rewrite-protocols.mjs # materialize catalog:/workspace: for non-pnpm tools
│   ├── diamond-scaffold.mjs # generate the semver/diamond example
│   └── diamond-demo.sh     # publish to CodeArtifact + diamond + override collapse
├── apps/        (generated) app-00001 ...   tiny: layout + page importing a few libs
├── packages/    (generated) lib-0001 ...    moderate: index + ~16 modules
└── examples/    (generated) diamond example for the semver/workspace doc
```

Apps are tiny (a layout and a page importing a few libs); the variable under test is their count, not their size. Libraries are moderate (an `index.ts` re-exporting ~16 small modules) and form a layered DAG: a lib in layer L depends on a few libs in layer L-1, and apps depend on libs spread across layers. That gives Turborepo a real graph with non-trivial build closures.

Design choices:

- pnpm catalogs (`catalog:` in `pnpm-workspace.yaml`): every app/lib pins the same Next/React/TS versions. One source of truth, smaller lockfile, deduped store, stable Turborepo cache hashes.
- `workspace:*` for internal deps so local source resolves, never the registry. `--versioned` switches to `workspace:^x.y.z` (see [WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md)).
- Libraries build to `dist/` with declarations; apps consume the built `dist`, so `build` is a real dependency of downstream `build`/`typecheck` (`dependsOn: ["^build"]`).

---

## Quick start

```bash
pnpm install                      # root tooling (turbo, typescript)

# 1. Generate a workspace (start small!)
pnpm gen -- --apps 200 --libs 100 --modules 16 --clean
pnpm install                      # link the generated workspace

# 2. Task-time focus: build ONE app + its lib closure
pnpm exec turbo run build --filter=@demo/app-00100...

# 3. Whole-workspace typecheck (cold), then again (warm cache)
pnpm exec turbo run typecheck
pnpm exec turbo run typecheck     # ← should be ~instant (FULL TURBO)

# 4. Artifact-time focus: minimal deployable subtree
pnpm exec turbo prune @demo/app-00100 --docker   # → ./out
```

### Scale knobs (`scripts/generate.mjs`)

| Flag | Default | Meaning |
|---|---|---|
| `--apps` | 50 | number of Next.js apps |
| `--libs` | 50 | number of libraries |
| `--modules` | 16 | modules per library (library "size") |
| `--app-deps` | 4 | lib dependencies per app |
| `--lib-deps` | 3 | lib→lib dependencies |
| `--layers` | 6 | dependency-graph depth |
| `--clean` | — | wipe `apps/` + `packages/` first |

### Run the benchmark

```bash
# One scale point, all phases, with filesystem stats:
node scripts/measure.mjs --label 10k --apps 10000 --libs 300 \
  --phases gen,install,graph,typecheck,focus,prune --fs-stats

pnpm chart            # render bench/*.svg from results.json
```

Generating and installing at this scale materializes a large `node_modules` (~87k entries at 4,000 apps, `bench/results.json`) and a big lockfile, both growing ~linearly with app count. Start at 200–2,000 apps before going higher.

---

## Results: scaling behavior

Environment: `bench/env.json` (Neoverse-V1, 64 cores, 135 GB, arm64; Node 22, pnpm 10.29, Turbo 2.9, tsc 5.9.3). Four scale points, 200 → 4,000 apps (20× apps, ~14× packages); larger scales extrapolate from this trend. Produced by `scripts/measure.mjs` per scale → `bench/results.json` (the 200–2,000 points via `make sweep`; the 4,000 point a standalone `measure.mjs` run).

| apps (libs) | typecheck cold | typecheck warm | focus build¹ | prune | build tasks | focus closure |
|---|---|---|---|---|---|---|
| 200 (100) | 19.0s | 1.5s | 11.5s | 0.9s | 300 | 75 |
| 1,000 (200) | 68.9s | 5.0s | 14.2s | 2.7s | 1,200 | 124 |
| 2,000 (300) | 127.2s | 7.6s | 15.5s | 5.3s | 2,300 | 100 |
| 4,000 (300) | 233.4s | 20.5s | 21.1s | 7.6s | 4,300 | 121 |

¹ `turbo run build --filter=<one app>...` (app + its library closure). Turbo hashes the tracked source the way a real monorepo would: the generated workspace is made visible to Turbo for the run (build outputs stay ignored), so the warm-cache and graph-load numbers reflect real per-package hashing. Install is measured cleanly and separately, each scale from scratch, in [TOOLING.md](TOOLING.md).

Scaling factor (computed from the table above), 200 → 4,000 apps (20× apps, ~14× packages):

| operation | factor | class |
|---|---|---|
| typecheck cold | ×12.3 | O(repo); ~linear in package count (×14) |
| typecheck warm | ×13.3 | O(repo); Turbo enumerates + hashes every package even on a full cache hit |
| prune | ×8.3 | O(repo); reads the whole graph to compute the closure |
| focus build | ×1.8 | O(closure); its closure grew 75→121 packages while apps grew 20× |

Whole-workspace operations scale ~linearly with package count; the focus build tracks one app's closure (75–124 packages here), not the app count. Extrapolating to 20,000 apps puts an unscoped cold typecheck in the tens of minutes and a full install proportionally large, while a focused build stays in the tens of seconds. The approach is to avoid unscoped whole-repo commands, not optimize them. What stays irreducibly O(repo) at that size — the lockfile, the Turbo graph-load, foundation-change blast radius — is in [LIMITS.md](LIMITS.md).

### Charts
![typecheck cold vs warm](bench/charts/typecheck-cold-vs-warm.svg)
![focus vs full](bench/charts/focus-vs-full.svg)
![lockfile size vs scale](bench/charts/lockfile-vs-scale.svg)

### Avoiding O(repo)
- Dev install: `turbo prune <app> --use-gitignore=false` or `pnpm deploy`, not a full `pnpm install`.
- Build/typecheck: `--filter=<app>...` or `--affected`.
- An unscoped `turbo run` still enumerates the whole graph, even on cache hits.
- CI: `--affected` plus remote cache.
- Past ~20,000 apps, loading one task graph is itself O(repo); shard the workspace — git-based selection like `--affected` still loads the full graph before scoping execution.

---

## Day-to-day developer simulation

`scripts/dev-sim.mjs` models D developers, each owning a small feature area (2 apps + 1 lib), working independently in a 1,000-app / 200-lib workspace (1,200 packages) — table below from `node scripts/dev-sim.mjs --devs 4 --apps 1000 --libs 200`. Each operation is scoped with `turbo --filter` (the set `--affected` selects in CI). Turbo's input hashing respects `.gitignore`, and the generated workspace is gitignored, so the sim makes the source visible to Turbo for the run while keeping build outputs ignored — the way a real, source-tracked monorepo behaves.

| operation | cost |
|---|---|
| onboarding — build a dev's feature area (apps + lib closure) | median 10.8s |
| typecheck-on-save — edit an app, typecheck it | median 4.3s |
| build-before-push — edit an app, build it + closure | median 5.8s |
| lib-edit — edit your own lib, rebuild it + dependents (21 packages here) | median 11.6s |
| independence — a teammate's unrelated edit | **adds 0 rebuilds** to your closure |
| edit foundation lib (`lib-003`, low layer) | **1,080 of 1,200** packages would rebuild |
| edit high-layer lib (`lib-197`) | 21 packages would rebuild |

The inner loop is O(closure), not O(repo): typecheck-on-save (4.3s) and build-before-push (5.8s) touch only the edited app's closure, regardless of the 1,200-package repo.

Independence holds across developers. A teammate editing their own app adds **zero** rebuilds to yours: apps don't depend on each other, so an unrelated app falls outside your `--filter` closure and Turbo never considers it. The 0 is a baseline-vs-after-edit delta (robust to `next build`'s own caching — the closure was a full cache hit both before and after the edit).

Editing a *shared lib* is the sharper test: does it rebuild only its real dependents? The blast-radius rows answer it. A high-layer lib rebuilds 21 packages; a low-layer foundation lib that most packages depend on rebuilds 1,080 of the 1,200 (~90%), since every dependent must rebuild. That blast radius is why foundation edits lean on the remote cache (CI and teammates download the rebuilt packages instead of rebuilding them) and CI `--affected` (only affected packages run), and why teams change foundation libs infrequently.

---

## Optimization playbook

See [`OPTIMIZATIONS.md`](OPTIMIZATIONS.md) for the sourced write-up. Summary:

1. Scope every task: `turbo run … --affected` in CI, `--filter=<app>...` locally.
2. Remote caching: unchanged tasks are downloaded, not rebuilt. Catalogs keep dependency versions identical so cache hashes stay stable.
3. Don't materialize the whole tree in CI: `turbo prune <app> --docker` produces the needed subtree, a pruned lockfile, and a cache-friendly install layer.
4. `node_modules` footprint: at large package counts the pnpm symlink/inode count is significant. `node-linker` mode (`isolated`/`hoisted`/`pnp`) and `package-import-method: clone` (on copy-on-write filesystems) are the relevant settings.
5. Next.js: aggregate build cost is per-build overhead times app count, so the lever is skipping unchanged builds (cache + `--affected`). On Next 16, Turbopack is the default production bundler and powers dev/HMR, so there is nothing to switch.

---

## Artifacts

- One app deployed from this monorepo to Vercel (pruned subtree, cloud build): https://nextjs-monorepo-scale-demo.vercel.app (22s wall; `bench/deploy.json`).
- Four packages published to AWS CodeArtifact for the diamond demo (`scripts/diamond-demo.sh`).

## Findings by area

The companion docs measure each cost separately. The headline result of each, with the bench JSON behind it:

**Verdict — when a shared workspace is worth it.** It fits apps that **share code and versions**: the daily loop is O(closure) (seconds, no install) and the heavy O(repo) costs (cold install, cold typecheck, lockfile rewrite) land on rare events, paid once per change and amortized across machines by the committed lockfile and the remote cache (the Turbo graph-load is the one O(repo) cost paid on every command). It is the wrong fit for **independent** apps — the single lockfile and graph then buy nothing, so a polyrepo or separate installs avoid that shared cost. The measured basis and a per-situation decision table are in [FEASIBILITY.md](FEASIBILITY.md).

### Tooling head-to-head

bun and tsgo win their head-to-heads, but the margin depends on the regime. A full cold install — no committed lockfile, full dependency resolve — is where bun's lead is largest (×58–×440 across 200–2,000 apps vs pnpm's default isolated linker; hoisted is within ~5%); a clean checkout carries the committed lockfile, so it relinks instead, and fully warm at 2,000 apps `pnpm`-hoisted is fastest (4.7s vs bun 10.1s). tsgo runs ~9–12× faster than tsc; a Vite SPA builds ~2.3× faster than the Next App Router (different feature sets). Each section below keeps compatible columns, the fastest cell per row green and the rest labeled with how many times slower. Every number traces to the cited `bench/*.json`; regenerate with `node scripts/comparison-chart.mjs`.

![tooling head-to-head: install (bun vs pnpm), typecheck (tsc vs tsgo), build (Next vs Vite), pnpm install situations, and lint (ESLint vs oxlint)](bench/charts/tool-comparison.svg)

> High-resolution PNG of the chart above: [`bench/charts/tool-comparison.png`](bench/charts/tool-comparison.png).

| area | headline finding | docs |
|---|---|---|
| **Install cost** | pnpm cold install is resolve-bound and ~linear: 48.8s → 476.8s (200 → 2,000 apps). bun installs the same dependency set 58–440× faster. The cold resolve is rare when the lockfile is committed: at 1,000 apps a frozen install is 7–9s and a one-dependency change ~10s; only a missing lockfile pays the full cold install (~16 min at 4,000 apps), which the resolve dominates (98% at 2,000 apps, the largest scale measured). | [FEASIBILITY](FEASIBILITY.md), [TOOLING](TOOLING.md) |
| **`node_modules` footprint** | cold install is within ~5% across `isolated`/`hoisted` (resolution-bound), so the linker is a footprint/strictness choice, not a speed one: `isolated` holds 86,749 entries / 49,712 symlinks at 4,000 apps; `hoisted` ~halves the entries (21,914 vs 50,159 at 2,000 apps); `pnp` removes `node_modules`. | [OPTIMIZATIONS §1](OPTIMIZATIONS.md), [TOOLING](TOOLING.md) |
| **Lockfile** | the single shared lockfile is irreducibly O(repo): 9,897 → 153,967 lines (200 → 4,000 apps). A `catalog:` bump edits **0** app manifests (vs 25 when pinned per-app) but rewrites hundreds of lockfile lines; two concurrent bumps conflict (253 markers) and `pnpm install` auto-resolves them to 0. | [OPTIMIZATIONS §1.5](OPTIMIZATIONS.md), [LIMITS](LIMITS.md) |
| **Type-checking** | whole-repo typecheck is O(repo): cold 19s → 233s, warm cache 1.5s → 20.5s — warm is still O(repo) because Turbo hashes every package on a full hit. tsgo (TypeScript's native port) is ~12× faster per check, drop-in for modern configs, still beta (it drops `node10`/legacy targets and has no LSP plugin API yet). | [TYPECHECKERS](TYPECHECKERS.md) |
| **Build** | Next 16 builds with Turbopack by default — `next build --turbopack` is a no-op (identical output size and bundler). A Vite SPA builds ~2.3× faster with ~20× less output than Next App Router, a different feature set. At scale the lever is skipping unchanged builds, not per-build speed. | [OPTIMIZATIONS §3](OPTIMIZATIONS.md), [TOOLING](TOOLING.md) |
| **Lint** | oxlint vs ESLint pointed at oxlint's own rule set (800-file corpus, 64-core box): oxlint lints in **190ms** running its full **567**-rule native set; ESLint runs the **524**-rule subset it can port and takes **12.0s** without `--cache` / **1.9s** with it — oxlint is **63.3×** / **10.1×** faster (wall-clock; oxlint is multithreaded, ESLint single-process, so the ratio scales with core count). The type-aware gap closed: `oxlint --type-aware` (tsgolint, alpha; 59/61 ts-eslint type-aware rules) flags `no-floating-promises` in **397ms** vs ESLint's type-checked **4.5s** (**11.3×**, mostly the tsgo-vs-tsc substrate). | [TOOLING](TOOLING.md) |
| **Test execution** | the `test` task is O(repo) the same way: whole-repo `turbo run test` runs one task per package (400 at 300:100, 1,200 at 1,000:200 — = package count; cold 5.8s → 15.1s, warm a full cache hit 1.6s → 5.4s). Scoping is O(closure): a focused app's closure is 124 of 1,200 tasks, and a leaf-lib edit re-tests 21 vs a universal-foundation edit's 1,200 (~57× blast spread); sharding splits the 1,200 into 150/shard at 8 shards. (Trivial smoke bodies — the finding is the task-count axis shape, not suite runtime.) | [LIMITS](LIMITS.md) |
| **Focus / deploy** | `turbo prune` emits a complete subtree (0 of 15 closure packages missing) plus a pruned lockfile (876 of 3,969 lines), but omits root configs an app extends (`tsconfig.base.json`) — copy them before building. One app deployed to Vercel via cloud build in 22s. | [OPTIMIZATIONS §4](OPTIMIZATIONS.md) |
| **Semver vs `workspace:`** | internal deps are consumed by semver from a registry; `workspace:` forces local linking and `pnpm publish` rewrites it to a real range. A diamond keeps both majors under the isolated linker; a root override collapses it and breaks the dependent built against the other major; per-app divergence on a *transitive* dep needs a separate workspace + lockfile — proven live on CodeArtifact. | [WORKSPACE-VS-SEMVER](WORKSPACE-VS-SEMVER.md) |
| **Optimal type-error gate (4k:400)** | the workspace-author's core-lib-rev gate on bun + tsgo + oxlint + turbo: a whole-program type-error gate over all 4,000 apps in 1.32s; a breaking foundation signature caught as every app red (4,399 `TS2554`); tsgo-vs-tsc parity holds on heavy real types; the fast `declaration:false` gate misses a `.d.ts` portability error the build catches. | [OPTIMAL-STACK](OPTIMAL-STACK.md) |
| **Developer inner loops** | per-role O(closure) loops on the optimal stack, fresh vs subsequent — app dev (one app + its libs) and lib dev (one leaf lib): typecheck/lint/focused-gate in seconds; the stack run on real apps (vercel/commerce, shadcn/taxonomy). | [SUMMARY](SUMMARY.md), [OPTIMAL-STACK](OPTIMAL-STACK.md) |
| **Core-lib rollout** | advancing a shared internal lib across 4,000 apps: the lockfile (not the range) is the determinism boundary; bun drives it natively (frozen `bunfig`, named-catalog cohorts, `workspace:` HEAD-tracking, concrete-range publish) and cold-installs ~58–440× faster than pnpm on a clean checkout; a universal lib is a republish-fanout; breaking changes go expand→migrate→contract. | [ROLLOUT](ROLLOUT.md) |
| **bun adoption safety** | a bun install vs a pnpm install, head-to-head: bun is adoptable but not a strict safety superset — two real gaps (its built-in allowlist runs registry `postinstall` scripts pnpm 10 blocks; no fail-closed strict-peer knob) plus pnpm's phantom-isolation edge; the rest is parity (file: postinstall blocked on both, missing peer auto-installed on both, both warn on mismatch, same scoped CodeArtifact `.npmrc`). | [ROLLOUT](ROLLOUT.md), [SUMMARY](SUMMARY.md) |
| **Remote cache (CI economics)** | every CI runner starts cold, so a centralized Turborepo cache turns the O(repo) cold start into a restore for the second-and-later runner: whole-repo typecheck **23.6s → 1.9s** (12.5×, 300:100) and **67.2s → 5.9s** (11.4×, 1,000:200); a build **62.7s → 4.0s** (15.5×, 300:100, one cold sample). Restore is itself O(repo) (the warm-cache graph-load floor), so the speedup holds ~11–12× as the repo grows rather than widening; measured over a localhost cache, so a real network adds the download (≤0.5 MB typecheck, 247 MB build). Across a 10-runner same-closure fleet it amortizes ~5.6×; it restores **486 of 500** tasks after a leaf edit but **0 of 500** after a foundation edit. | [LIMITS](LIMITS.md) |
| **Editor / language server** | opening one app is O(closure), not O(repo): the language server loads the opened app's dependency closure (65 libs / 1,123 files), flat as the repo grows 8× (500 → 4,000 apps) and rising only with the closure (628 → 1,123 files). tsgo's native LSP opens that closure in **86ms vs tsserver's 1,620ms** (18.8×) with **275 vs 380MB** RSS (1.4×); once warm, both answer go-to-def/hover in ≤2ms — project load is the cost, not the keystroke. | [LIMITS](LIMITS.md) |
| **The ceiling** | what focus/cache/`--affected` cannot remove at ~20,000 apps: the single lockfile, the per-command Turbo graph-load floor, foundation-change blast radius (~90% of packages), inode/disk pressure, language-server memory when the whole workspace is opened as one project, git worktree cost, and Vercel's per-project model. Past this, shard the workspace or move to a daemon + remote-execution build system. | [LIMITS](LIMITS.md) |

Methodology and industry grounding: [GROUNDING.md](GROUNDING.md) maps each practice to its primary source and the documented ceiling; [REVIEW.md](REVIEW.md) is the static-check, type-check, and two-reviewer pipeline every change runs through.

## License

MIT, see [LICENSE](LICENSE).

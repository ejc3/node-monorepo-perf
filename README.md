# Next.js Monorepo Scale Lab

Benchmark rig for a pnpm + Turborepo workspace of N Next.js apps and M shared libraries. It generates the workspace with a layered dependency graph and measures install, typecheck, build, and the scoped ("focus") operations. Tested to 2,000 apps / 300 libs.

Result: whole-workspace operations — install, typecheck, even a warm-cache `turbo run`, and `turbo prune`'s graph load — scale with package count. A focused build (`turbo run --filter=<app>...`, `pnpm deploy`) executes only one app's dependency closure and stays roughly constant as app count grows. The workflow avoids unscoped whole-repo execution. Numbers in [Results](#results-scaling-behavior).

---

## The three layers of "focus"

| Layer | Question it answers | Tool | Command |
|---|---|---|---|
| **Install-time** | "Install only *this* app's dependency closure" | `pnpm deploy` / `turbo prune` | `turbo prune @demo/app-05000 --docker` |
| **Task-time** | "Build/typecheck only the affected packages" | Turborepo filters | `turbo run build --filter=@demo/app-05000...` |
| **Artifact-time** | "Ship a minimal subtree to CI/Vercel/Docker" | `turbo prune` | `turbo prune @demo/app-05000 --docker` then build `out/` |

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

Generating and installing tens of thousands of apps materializes a large `node_modules` (hundreds of thousands of inodes) and a big lockfile. Start at 200–2,000 apps before going higher.

---

## Results: scaling behavior

Environment: `bench/env.json` (Neoverse-V1, 64 cores, 135 GB, arm64; Node 22, pnpm 10.29, Turbo 2.9, tsc 5.9.3). Three scale points, 200 → 2,000 apps (10× apps, ~7.7× packages); larger scales extrapolate from this trend.

| apps (libs) | typecheck cold | typecheck warm | focus build¹ | prune | build tasks | focus closure |
|---|---|---|---|---|---|---|
| 200 (100) | 19.0s | 1.5s | 11.5s | 0.9s | 300 | 75 |
| 1,000 (200) | 68.9s | 5.0s | 14.2s | 2.7s | 1,200 | 124 |
| 2,000 (300) | 127.2s | 7.6s | 15.5s | 5.3s | 2,300 | 100 |

¹ `turbo run build --filter=<one app>...` (app + its library closure). Turbo hashes the tracked source the way a real monorepo would: the generated workspace is made visible to Turbo for the run (build outputs stay ignored), so the warm-cache and graph-load numbers reflect real per-package hashing. Install is measured cleanly and separately, each scale from scratch, in [TOOLING.md](TOOLING.md).

Scaling factor, 200 → 2,000 apps (10× apps, ~7.7× packages):

| operation | factor | class |
|---|---|---|
| typecheck cold | ×6.7 | O(repo); ~linear in package count |
| typecheck warm | ×5.0 | O(repo); Turbo enumerates + hashes every package even on a full cache hit |
| prune | ×5.7 | O(repo); reads the whole graph to compute the closure |
| focus build | ×1.3 | O(closure); its closure grew 75→100 packages while apps grew 10× |

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
- Past ~20k packages, loading one task graph is itself O(repo); shard or use git-based selection.

---

## Day-to-day developer simulation

`scripts/dev-sim.mjs` models D developers, each owning a small feature area (2 apps + 1 lib), working independently in a 1,000-app / 200-lib workspace (1,200 packages). Each operation is scoped with `turbo --filter` (the set `--affected` selects in CI). Turbo's input hashing respects `.gitignore`, and the generated workspace is gitignored, so the sim makes the source visible to Turbo for the run while keeping build outputs ignored — the way a real, source-tracked monorepo behaves.

| operation | cost |
|---|---|
| onboarding — build a dev's feature area (apps + lib closure) | median 10.8s |
| typecheck-on-save — edit an app, typecheck it | median 4.3s |
| build-before-push — edit an app, build it + closure | median 5.8s |
| lib-edit — edit your own lib, rebuild it + dependents (21 here) | median 11.6s |
| independence — a teammate's unrelated edit | **adds 0 rebuilds** to your closure |
| edit foundation lib (`lib-003`, low layer) | **1,080 of 1,200** packages would rebuild |
| edit high-layer lib (`lib-197`) | 21 packages would rebuild |

The inner loop (typecheck-on-save 4.3s, build-before-push 5.8s) touches only the edited app's closure regardless of the 1,200-package repo — O(closure), not O(repo). Independence is exact: a teammate editing their own app adds **zero** rebuilds to yours, because the cache for your unchanged closure stays valid (measured as a baseline-vs-after-edit delta, since `next build` itself re-runs on every build). The one expensive action is editing a widely-used foundation lib: its blast radius is its dependents (~90% of the repo here), which is why shared-lib changes lean on remote cache + CI `--affected`, and why foundation libs change rarely.

---

## Optimization playbook (what actually scales)

See [`OPTIMIZATIONS.md`](OPTIMIZATIONS.md) for the sourced write-up. Summary:

1. Scope every task: `turbo run … --affected` in CI, `--filter=<app>...` locally.
2. Remote caching: unchanged tasks are downloaded, not rebuilt. Catalogs keep dependency versions identical so cache hashes stay stable.
3. Don't materialize the whole tree in CI: `turbo prune <app> --docker` produces the needed subtree, a pruned lockfile, and a cache-friendly install layer.
4. `node_modules` footprint: at large package counts the pnpm symlink/inode count is significant. `node-linker` mode (`isolated`/`hoisted`/`pnp`) and `package-import-method: clone` (on copy-on-write filesystems) are the relevant settings.
5. Next.js: aggregate build cost is per-build overhead times app count, so the lever is skipping unchanged builds (cache + `--affected`). Turbopack is faster for dev/HMR; check production bundle size when switching.

---

## Artifacts

- One app deployed from this monorepo to Vercel (pruned subtree, cloud build): https://nextjs-monorepo-scale-demo.vercel.app (22s wall; `bench/deploy.json`).
- Four packages published to AWS CodeArtifact for the diamond demo (`scripts/diamond-demo.sh`).

## Companion docs

- [OPTIMIZATIONS.md](OPTIMIZATIONS.md) — pnpm / Turborepo / Next.js / Vercel optimization playbook.
- [WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md) — semver vs `workspace:`, overrides, diamond dependencies.
- [TYPECHECKERS.md](TYPECHECKERS.md) — tsc vs tsgo and the faster type-checking levers.
- [TOOLING.md](TOOLING.md) — bun vs pnpm install, Vite vs Next build.
- [REVIEW.md](REVIEW.md) — the quality pipeline: static checks, type-checking, and the review workflows.
- [LIMITS.md](LIMITS.md) — what breaks at 20k that focus/cache can't fix, gotchas, and what's left to quantify.

## License

MIT, see [LICENSE](LICENSE).

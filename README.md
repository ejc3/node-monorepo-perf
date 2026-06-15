# Next.js Monorepo Scale Lab

**How does a pnpm + Turborepo workspace behave with 10,000 tiny Next.js apps and 300 moderate shared libraries — and what actually makes it fast again?**

This repo is a reproducible benchmark rig. It generates a workspace of *N* Next.js apps and *M* libraries with a realistic layered dependency graph, then measures the operations that hurt at scale (install, typecheck, build) and the techniques that rescue them.

> TL;DR — at 10k apps the enemy is **doing work for all 10,000 things**. The fix is **focus**: only ever touch the subset you need. There are three independent layers of focus, and they compose.

---

## The three layers of "focus"

| Layer | Question it answers | Tool | Command |
|---|---|---|---|
| **Install-time** | "Install only *this* app's dependency closure" | `pnpm deploy` / `turbo prune` | `turbo prune @demo/app-05000 --docker` |
| **Task-time** | "Build/typecheck only the affected packages" | Turborepo filters | `turbo run build --filter=@demo/app-05000...` |
| **Artifact-time** | "Ship a minimal subtree to CI/Vercel/Docker" | `turbo prune` | `turbo prune @demo/app-05000 --docker` then build `out/` |

The headline numbers (build one app vs. build everything; focused install vs. full install; cache cold vs. warm) are produced by `scripts/measure.mjs` and recorded in [`bench/results.json`](bench/results.json). See **[Results](#results)**.

---

## Architecture

```
pnpm-demo/
├── pnpm-workspace.yaml     # workspace globs + catalog (single source of dep versions)
├── turbo.json              # build/typecheck task graph (dependsOn ^build)
├── tsconfig.base.json      # shared compiler options
├── scripts/
│   ├── generate.mjs        # emit N apps + M libs with a layered DAG
│   ├── measure.mjs         # timed benchmark harness → bench/results.json
│   └── chart.mjs           # render scaling charts (SVG) from results
├── apps/        (generated) app-00001 … app-10000   — TINY: layout + page
└── packages/    (generated) lib-0001  … lib-0300    — MODERATE: index + N modules
```

**Apps are tiny on purpose** (a layout + a page importing a few libs) — the point is the *count*, not per-app size. **Libraries are moderate** (an `index.ts` re-exporting ~16 small modules each) and form a **layered DAG**: a lib in layer *L* depends on a few libs in layer *L-1*. Apps depend on a handful of libs spread across layers. This gives Turborepo a real graph to traverse, with bounded-but-non-trivial build closures (the thing that makes "focus" meaningful).

Key scale decisions baked in:

- **pnpm catalogs** (`catalog:` in `pnpm-workspace.yaml`) — every app/lib pins the *same* Next/React/TS versions. One source of truth → smaller lockfile, deduped store, and identical hashes → maximal Turborepo cache hits.
- **`workspace:*`** for all internal deps — local source always wins, never the registry.
- **Libraries build to `dist/` with declarations**; apps consume the built `dist`. That makes `build` a genuine dependency of downstream `build`/`typecheck` (`dependsOn: ["^build"]`).

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

> ⚠️ Generating and installing **10,000 apps** materializes a large `node_modules` (hundreds of thousands of inodes) and a big lockfile. Start at 200–2000 apps to feel the curve before going to 10k.

---

## Results

_Populated by `scripts/measure.mjs`. See [`bench/results.json`](bench/results.json) and the charts in [`bench/`](bench/)._

<!-- RESULTS_TABLE -->
_(run the benchmark to populate)_

---

## Optimization playbook (what actually scales)

See **[`OPTIMIZATIONS.md`](OPTIMIZATIONS.md)** for the full, sourced write-up. The short version:

1. **Never operate on all 10k.** Use `turbo run … --affected` (CI) or `--filter=<app>...` (local). This is the single biggest win.
2. **Cache aggressively, remotely.** Turborepo remote cache turns "rebuild the world" into "download the world." Identical dep versions (catalogs) keep hashes stable.
3. **Don't materialize the whole tree in CI.** `turbo prune <app> --docker` ships only the needed subtree + a pruned lockfile + a cache-friendly install layer.
4. **Mind the symlink farm.** At 10k packages the pnpm `node_modules` inode count is a real cost; `node-linker` mode (`isolated`/`hoisted`/`pnp`) and `package-import-method: clone` (on CoW filesystems) are the levers.
5. **For Next.js specifically**, per-build cold-start overhead × N dominates — so the leverage is *skipping unchanged builds*, not shaving a single build. Turbopack wins dev/HMR; verify production bundle size when switching.

---

## License

MIT — see [LICENSE](LICENSE).

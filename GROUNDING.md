# Industry grounding

This doc cites the primary source behind each practice in the benchmark, shows where pnpm + Turborepo hits a ceiling and which architecture replaces it, and maps the methodology to standard benchmarking norms.

## Practices this repo follows

| Practice | Source |
|---|---|
| `node-linker: isolated` is the default; a footprint/strictness choice, not a speed lever; `hoisted`/`pnp` are the escapes | [pnpm settings](https://pnpm.io/settings) |
| Catalogs (`catalog:`) centralize a version specifier as the single source of truth — one version across the workspace, one-edit upgrades, fewer conflicts (dedup itself happens at install) | [pnpm catalogs](https://pnpm.io/catalogs), [Turborepo managing-dependencies](https://turborepo.dev/docs/crafting-your-repository/managing-dependencies) |
| One shared workspace lockfile (per-package lockfiles sacrifice cross-package dedup) | [pnpm settings](https://pnpm.io/settings) |
| Declare each dependency in the package that uses it; root holds only tooling | [Turborepo](https://turborepo.dev/docs/crafting-your-repository/managing-dependencies) |
| Decompose install: `install --lockfile-only` resolves without materializing; `--frozen-lockfile` in CI | [pnpm install](https://pnpm.io/cli/install) |
| `turbo run --filter=app...` for the dependency-closure (O(closure)) | [turbo run](https://turborepo.dev/docs/reference/run) |
| `turbo run --affected` in CI (changed packages + dependents) | [Turborepo CI guide](https://turborepo.dev/docs/crafting-your-repository/constructing-ci) |
| `turbo prune --docker` → `json/` install layer + `full/` source layer + pruned lockfile | [turbo prune](https://turborepo.dev/docs/reference/prune) |
| Remote caching (download unchanged outputs instead of rebuilding) | [Turborepo remote caching](https://turborepo.dev/docs/core-concepts/remote-caching) |
| One Vercel project per app; skip-unaffected does not consume a build slot (legacy turbo-ignore does) | [Vercel monorepos](https://vercel.com/docs/monorepos), [limits](https://vercel.com/docs/limits) |

## The ceiling: when pnpm + Turborepo gives way

The benchmark's thesis is that this stack has a ceiling near where graph-load + lockfile + foundation-blast dominate, and the escape is a different architecture. That is vendor-acknowledged and has documented end-states.

- The ceiling is real, not self-asserted: Nx documents that affected + caching cannot eliminate the tasks of genuinely-modified projects or their dependents — those still re-run, and the remedy beyond that is distributed task execution ([Nx reduce-waste](https://nx.dev/docs/concepts/ci-concepts/reduce-waste)).
- Caching is not execution: remote *cache* (Nx Replay) only helps the second consumer of an artifact; the escape needs distributed *execution* (Nx Agents, [Bazel RBE](https://bazel.build/remote/rbe)).
- The per-invocation O(repo) graph-load is escaped by a persistent daemon: Buck2 keeps one dependency graph between invocations and is remote-execution-first ([buck2](https://buck2.build/docs/about/why/)); Bazel persistent workers cut startup ([Bazel persistent](https://bazel.build/remote/persistent)).
- Real end-states: Google (Piper + CitC FUSE + Blaze/Bazel, ~1B files, [research](https://research.google/pubs/why-google-stores-billions-of-lines-of-code-in-a-single-repository/)); Meta (Sapling + EdenFS + Buck2, [Sapling](https://engineering.fb.com/2022/11/15/open-source/sapling-source-control-scalable/), [Buck2](https://engineering.fb.com/2023/04/06/open-source/buck2-open-source-large-scale-build-system/)); Microsoft (Scalar/VFS-for-Git + Rush + Lage, [Scalar](https://github.blog/open-source/git/the-story-of-scalar/), [rushstack](https://rushstack.io/)); Canva and Uber (Git + Bazel, [Canva](https://www.canva.dev/blog/engineering/we-put-half-a-million-files-in-one-git-repository-heres-what-we-learned/), [Uber](https://www.uber.com/blog/go-monorepo-bazel/)).

## The Git axis (sourced)

At ~130k files (20k apps) Git itself needs scaling, with the same focus-vs-whole-repo split:

- `core.fsmonitor=true` + `core.untrackedCache=true`: `git status` at 2M files 85.1s → 0.75s ([fsmonitor](https://github.blog/engineering/infrastructure/improve-git-monorepo-performance-with-a-file-system-monitor/)).
- Cone sparse-checkout + sparse index: index 180 MB → <10 MB, `git status` 1.3s → <200 ms ([sparse index](https://github.blog/open-source/git/make-your-monorepo-feel-small-with-gits-sparse-index/)).
- Partial clone (`git clone --filter=blob:none --sparse`): clone becomes O(history) not O(all blobs) ([sparse-checkout](https://github.blog/open-source/git/bring-your-monorepo-down-to-size-with-sparse-checkout/)).
- Scalar (`scalar clone`, built into Git 2.38+): bundles the above + commit-graph + background maintenance ([Scalar](https://github.blog/open-source/git/the-story-of-scalar/)).

## Methodology norms

| Norm | Source | This suite |
|---|---|---|
| Named cold/warm/clean states (install time is dominated by what's already populated) | [pnpm benchmarks](https://pnpm.io/benchmarks) | install-bench/lockfile-bench model cold (no lockfile) / warm (lockfile, no node_modules) / truly-cold (fresh store) |
| Reset state / isolate the store between configs | [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) | isolated per-run temp workspace; each scale freshly generated; node_modules + yarn project state + lockfile removed per measurement; ambient tool env (`YARN_*`/`BUN_*`/`PNPM_*`/`npm_config_*`) stripped per timed run; truly-cold redirects each tool's store + metadata to a throwaway dir (pnpm `--store-dir`+`--config.cache-dir`, bun `BUN_INSTALL_CACHE_DIR`, yarn `YARN_GLOBAL_FOLDER`), asserted populated afterward |
| Verify completeness (don't time a no-op) | [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) | `verifyComplete()` throws unless every app and lib resolves all declared deps + devDeps (yarn PnP: through the `.pnp.cjs` resolver, resolved zips present and non-empty); build-bench errors on 0-byte output |
| Report variance, not bare averages; repeat noisy runs | [hyperfine](https://github.com/sharkdp/hyperfine), [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) | dev-sim reports medians; short/noisy ops repeated; large cold installs (deterministic-heavy, low relative noise) measured once |
| Report absolute numbers + full system config | [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) | `/usr/bin/time -v` CPU% + peak RSS per run; `bench/env.json` (CPU model, cores, RAM, OS, tool versions) |

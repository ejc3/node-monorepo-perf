# Industry grounding

This doc cites the primary source behind each practice in the benchmark, shows where pnpm + Turborepo hits a ceiling and which architecture replaces it, and maps the methodology to standard benchmarking norms.

## Practices this repo follows

| Practice | Source |
|---|---|
| `node-linker: isolated` is the default; `hoisted`/`pnp` are the escapes. Cold install is within ~3% across linkers; the warm relink is 1.6–3.3× faster hoisted (`bench/install-bench.json`) | [pnpm settings](https://pnpm.io/settings) |
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

## Scenario realism (industry sourcing)

Each measured scenario, checked against primary sources — official docs, named-company
engineering posts, survey data — so the suite tests practices that exist in the wild:

| Scenario | Verdict | Key sources |
|---|---|---|
| Frozen install from the committed lockfile as the CI norm (`npm ci` / `--frozen-lockfile` / `--immutable`), fresh runner unless a cache step restores | Realistic | [npm ci docs](https://docs.npmjs.com/cli/v11/commands/npm-ci/) ("meant to be used in automated environments"); [pnpm settings](https://pnpm.io/settings) (`frozenLockfile` defaults true under CI env); [yarn rc](https://yarnpkg.com/configuration/yarnrc) (`enableImmutableInstalls` "true (the default on CI)"); [GitHub's Node starter workflow](https://github.com/actions/starter-workflows/blob/main/ci/node.js.yml) (`setup-node cache:` + `npm ci`); [bun install docs](https://bun.com/docs/pm/cli/install) (`bun ci` = `--frozen-lockfile`; no CI auto-enable — the asymmetry `yarn-rollout-bench`/`wave-rollout-bench` measure) |
| Catalogs as the one source of shared versions; named catalogs routing cohorts during staged upgrades | Realistic | [pnpm Catalogs](https://pnpm.io/catalogs) (named catalogs documented for "migrating to a newer version of a dependency piecemeal", react16/17/18 example); [Turborepo docs](https://turborepo.dev/docs) recommend catalogs; in the wild: vuejs/core, create-t3-turbo |
| Monorepos at 1,000–4,000+ packages | Realistic to ~2,500; the 4,000-app point extrapolates above the documented cluster | [Microsoft's 1JS](https://www.jonathancreamer.com/how-we-shrunk-our-git-repo-size-by-94-percent/) ~2,500 packages / ~20M LOC; [TikTok's frontend monorepo](https://developers.tiktok.com/blog/2024-sparo-faster-git-for-frontend-monorepos) 1,000+ projects, for which TikTok built [lockfile subspaces](https://developers.tiktok.com/blog/subspaces-divide-and-conquer-your-npm-upkeep) and Sparo; [DefinitelyTyped](https://jakebailey.dev/posts/pnpm-dt-3/) 9,114 workspace projects. Documented counts cluster at 1,000–2,500 — the lab's 4,000-app point sits above that cluster and below DefinitelyTyped's special case |
| yarn PnP as a production install layout | Realistic | [Yarn's default install strategy](https://yarnpkg.com/features/pnp) in modern releases; [Datadog runs Yarn PnP across its frontend](https://opensource.datadoghq.com/projects/yarn/) (Yarn's lead maintainer works there); [Klaviyo's zero-installs migration](https://klaviyo.tech/goodbye-dependency-installations-a242ccf6fa40) to Yarn 3 PnP (CI image builds 11 min average / 16 min worst-case → ~1 min) — the same two axes the lab measures: the install win and the compat boundary |
| Wave-based internal-lib rollouts (pinned-stable cohort + HEAD-tracking cohort) | Realistic | [Uber's tiered staged rollouts of monorepo-wide changes](https://www.uber.com/blog/controlling-the-rollout-of-large-scale-monorepo-changes/) (least-critical service tiers deploy first); [pnpm named-catalog migration docs](https://pnpm.io/catalogs); Changesets [snapshot](https://github.com/changesets/changesets/blob/main/docs/snapshot-releases.md)/[prerelease](https://github.com/changesets/changesets/blob/main/docs/prereleases.md) lanes. Strict one-version shops ([Google-style live-at-HEAD](https://research.google/pubs/why-google-stores-billions-of-lines-of-code-in-a-single-repository/)) instead cohort at the deploy layer — the mechanics differ by shop, the staging practice does not |
| bun / yarn 4 as the CI installer at scale | Realistic | [State of JS 2025](https://2025.stateofjs.com/en-US/other-tools/): 1,123 respondents named `bun install` among the monorepo tools they regularly use (pnpm led at 3,940); bun in production at [Anthropic](https://www.anthropic.com/news/anthropic-acquires-bun-as-claude-code-reaches-usd1b-milestone) (Claude Code's infrastructure and native installer; Anthropic acquired Bun), [Midjourney](https://bun.com/blog/bun-v1.3) (frontend development), and [Railway](https://docs.railway.com/reference/functions) (Functions run on the Bun runtime); yarn PnP in production at [Datadog](https://opensource.datadoghq.com/projects/yarn/) (frontend) and [Klaviyo](https://klaviyo.tech/goodbye-dependency-installations-a242ccf6fa40) (Yarn 3, CI). For both tools the evidence is adoption signal, not documented pnpm→bun or pnpm→yarn speed migrations |
| Fresh containers as the CI-runner stand-in (`container-install-bench`) | Partially | Faithful for the self-hosted container tier: GitLab's Docker executor is container-per-job (podman is a supported runtime), and GitHub's actions-runner-controller runs one ephemeral Kubernetes pod per job. GitHub-HOSTED runners are fresh **VMs** per job — stronger isolation with a different fs/network substrate, so hosted-runner absolute times differ; the empty-cache-per-job property the bench isolates is the same |

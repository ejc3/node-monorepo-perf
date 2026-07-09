# Industry Grounding

This doc cites the primary source behind each practice in the benchmark, shows where pnpm + Turborepo hits a ceiling and which architecture replaces it, and maps the methodology to standard benchmarking norms.

## Practices This Repo Follows

| Practice | Source |
|---|---|
| `node-linker: isolated` as the default, with `hoisted`/`pnp` as the escapes | [pnpm settings](https://pnpm.io/settings) |
| Catalogs (`catalog:`) centralize a version specifier as the single source of truth | [pnpm catalogs](https://pnpm.io/catalogs), [Turborepo managing-dependencies](https://turborepo.dev/docs/crafting-your-repository/managing-dependencies) |
| One shared workspace lockfile (per-package lockfiles sacrifice cross-package dedup) | [pnpm settings](https://pnpm.io/settings) |
| Declare each dependency in the package that uses it, with the root holding only tooling | [Turborepo](https://turborepo.dev/docs/crafting-your-repository/managing-dependencies) |
| Decomposed install (`--lockfile-only`, then `--frozen-lockfile` in CI) | [pnpm install](https://pnpm.io/cli/install) |
| `turbo run --filter=app...` for the dependency-closure (O(closure)) | [turbo run](https://turborepo.dev/docs/reference/run) |
| `turbo run --affected` in CI (changed packages + dependents) | [Turborepo CI guide](https://turborepo.dev/docs/crafting-your-repository/constructing-ci) |
| `turbo prune --docker` → `json/` install layer + `full/` source layer + pruned lockfile | [turbo prune](https://turborepo.dev/docs/reference/prune) |
| Remote caching (download unchanged outputs instead of rebuilding) | [Turborepo remote caching](https://turborepo.dev/docs/core-concepts/remote-caching) |
| One Vercel project per app | [Vercel monorepos](https://vercel.com/docs/monorepos), [Vercel limits](https://vercel.com/docs/limits) |

Details:

- `node-linker`: cold install is within ~3% across linkers, and the warm relink is 1.6–3.3× faster hoisted (`bench/install-bench.json`).
- Catalogs: one version across the workspace, one-edit upgrades, and fewer conflicts; dedup itself happens at install.
- Install decomposition: `install --lockfile-only` resolves without materializing; CI installs use `--frozen-lockfile`.
- Vercel: skip-unaffected does not consume a build slot; legacy turbo-ignore does.

## The Ceiling

The benchmark's thesis is that this stack has a ceiling near where graph-load + lockfile + foundation-blast dominate, and the escape is a different architecture. That is vendor-acknowledged and has documented end-states.

- Nx documents that affected + caching cannot eliminate the tasks of modified projects or their dependents; the remedy beyond that is distributed task execution ([Nx reduce-waste](https://nx.dev/docs/concepts/ci-concepts/reduce-waste)).
- Caching is not execution: remote *cache* (Nx Replay) only helps the second consumer of an artifact; the escape needs distributed *execution* (Nx Agents, [Bazel RBE](https://bazel.build/remote/rbe)).
- The per-invocation O(repo) graph-load is escaped by a persistent daemon: Buck2 keeps one dependency graph between invocations and is remote-execution-first ([the buck2 docs](https://buck2.build/docs/about/why/)); Bazel persistent workers cut startup ([Bazel persistent](https://bazel.build/remote/persistent)).
- Real end-states: Google (Piper + CitC FUSE + Blaze/Bazel, ~1B files, [Google's monorepo paper](https://research.google/pubs/why-google-stores-billions-of-lines-of-code-in-a-single-repository/)); Meta (Sapling + EdenFS + Buck2, [Sapling](https://engineering.fb.com/2022/11/15/open-source/sapling-source-control-scalable/), [Buck2](https://engineering.fb.com/2023/04/06/open-source/buck2-open-source-large-scale-build-system/)); Microsoft (Scalar/VFS-for-Git + Rush + Lage, [Scalar](https://github.blog/open-source/git/the-story-of-scalar/), [Rush Stack docs](https://rushstack.io/)); Canva and Uber (Git + Bazel, [Canva](https://www.canva.dev/blog/engineering/we-put-half-a-million-files-in-one-git-repository-heres-what-we-learned/), [Uber](https://www.uber.com/blog/go-monorepo-bazel/)).

## The Git Axis

At ~130k files (20k apps) Git itself needs scaling, with the same focus-vs-whole-repo split:

- `core.fsmonitor=true` + `core.untrackedCache=true`: `git status` at 2M files 85.1s → 0.75s ([git fsmonitor docs](https://github.blog/engineering/infrastructure/improve-git-monorepo-performance-with-a-file-system-monitor/)).
- Cone sparse-checkout + sparse index: index 180 MB → <10 MB, `git status` 1.3s → <200 ms ([sparse index](https://github.blog/open-source/git/make-your-monorepo-feel-small-with-gits-sparse-index/)).
- Partial clone (`git clone --filter=blob:none --sparse`): clone becomes O(history) rather than O(all blobs) ([git sparse-checkout docs](https://github.blog/open-source/git/bring-your-monorepo-down-to-size-with-sparse-checkout/)).
- Scalar (`scalar clone`, built into Git 2.38+): bundles the above + commit-graph + background maintenance ([Scalar](https://github.blog/open-source/git/the-story-of-scalar/)).

## Methodology Norms

| Norm | Source | This suite |
|---|---|---|
| Named cold/warm/clean states (install time is dominated by what's already populated) | [pnpm benchmarks](https://pnpm.io/benchmarks) | install-bench/lockfile-bench model cold (no lockfile) / warm (lockfile, no node_modules) / truly-cold (fresh store) |
| Reset state / isolate the store between configs | [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) | isolated per-run temp workspace with full state reset per measurement |
| Verify completeness (don't time a no-op) | [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) | `verifyComplete()` after installs, output checks in build-bench |
| Report variance, not bare averages; repeat noisy runs | [hyperfine's README](https://github.com/sharkdp/hyperfine), [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) | medians for dev-sim, repeats for noisy ops |
| Report absolute numbers + full system config | [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) | `/usr/bin/time -v` per run plus `bench/env.json` |

Details:

- State isolation: each scale is freshly generated in an isolated per-run temp workspace; node_modules, yarn project state, and the lockfile are removed per measurement; ambient tool env (`YARN_*`/`BUN_*`/`PNPM_*`/`npm_config_*`) is stripped per timed run. Truly-cold runs redirect each tool's store and metadata to a throwaway dir (pnpm `--store-dir` + `--config.cache-dir`, bun `BUN_INSTALL_CACHE_DIR`, yarn `YARN_GLOBAL_FOLDER`), asserted populated afterward.
- Completeness: `verifyComplete()` throws unless every app and lib resolves all declared deps + devDeps (yarn PnP: through the `.pnp.cjs` resolver, with resolved zips present and non-empty); build-bench errors on 0-byte output.
- Variance: dev-sim reports medians and short or noisy ops are repeated; large cold installs are deterministic-heavy with low relative noise, so they are measured once.
- System config: `/usr/bin/time -v` records CPU% and peak RSS per run; `bench/env.json` records CPU model, cores, RAM, OS, and tool versions.

## Scenario Realism

Each measured scenario is checked against primary sources (official docs, named-company engineering posts, survey data) so the suite tests practices that exist in the wild:

| Scenario | Verdict | Key sources |
|---|---|---|
| Frozen install from the committed lockfile as the CI norm (`npm ci` / `--frozen-lockfile` / `--immutable`), fresh runner unless a cache step restores | Realistic | [npm ci docs](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [pnpm settings](https://pnpm.io/settings), [yarn rc](https://yarnpkg.com/configuration/yarnrc), [GitHub's Node starter workflow](https://github.com/actions/starter-workflows/blob/main/ci/node.js.yml), [bun install docs](https://bun.com/docs/pm/cli/install) |
| Catalogs as the one source of shared versions, with named catalogs routing cohorts during staged upgrades | Realistic | [pnpm Catalogs](https://pnpm.io/catalogs), [Turborepo docs](https://turborepo.dev/docs), vuejs/core, create-t3-turbo |
| Monorepos at 1,000–4,000+ packages | Realistic to ~2,500 | [Microsoft's 1JS](https://www.jonathancreamer.com/how-we-shrunk-our-git-repo-size-by-94-percent/), [TikTok's frontend monorepo](https://developers.tiktok.com/blog/2024-sparo-faster-git-for-frontend-monorepos), [DefinitelyTyped](https://jakebailey.dev/posts/pnpm-dt-3/) |
| yarn PnP as a production install layout | Realistic | [Yarn's default install strategy](https://yarnpkg.com/features/pnp), [Datadog's Yarn page](https://opensource.datadoghq.com/projects/yarn/), [Klaviyo's zero-installs migration](https://klaviyo.tech/goodbye-dependency-installations-a242ccf6fa40) |
| Wave-based internal-lib rollouts (pinned-stable cohort + HEAD-tracking cohort) | Realistic | [Uber's staged rollouts](https://www.uber.com/blog/controlling-the-rollout-of-large-scale-monorepo-changes/), [pnpm named-catalog migration docs](https://pnpm.io/catalogs), Changesets [snapshot releases](https://github.com/changesets/changesets/blob/main/docs/snapshot-releases.md) and [prerelease lanes](https://github.com/changesets/changesets/blob/main/docs/prereleases.md), [Google-style live-at-HEAD](https://research.google/pubs/why-google-stores-billions-of-lines-of-code-in-a-single-repository/) |
| bun / yarn 4 as the CI installer at scale | Realistic | [State of JS 2025](https://2025.stateofjs.com/en-US/other-tools/), [Anthropic](https://www.anthropic.com/news/anthropic-acquires-bun-as-claude-code-reaches-usd1b-milestone), [Midjourney](https://bun.com/blog/bun-v1.3), [Railway](https://docs.railway.com/reference/functions), [Datadog](https://opensource.datadoghq.com/projects/yarn/), [Klaviyo](https://klaviyo.tech/goodbye-dependency-installations-a242ccf6fa40) |
| Fresh containers as the CI-runner stand-in (`container-install-bench`) | Partially | Faithful for the self-hosted container tier (details below) |

Details:

- Frozen CI installs: npm's docs say `npm ci` is "meant to be used in automated environments"; pnpm's `frozenLockfile` defaults to true under CI env; yarn's `enableImmutableInstalls` is "true (the default on CI)"; GitHub's Node starter workflow pairs `setup-node cache:` with `npm ci`. `bun ci` equals `--frozen-lockfile` with no CI auto-enable; that asymmetry is what `yarn-rollout-bench` and `wave-rollout-bench` measure.
- Catalogs: pnpm documents named catalogs for "migrating to a newer version of a dependency piecemeal", with a react16/17/18 example; Turborepo's docs recommend catalogs; vuejs/core and create-t3-turbo use them in the wild.
- Package counts: Microsoft's 1JS is ~2,500 packages and ~20M LOC; TikTok's frontend monorepo has 1,000+ projects, for which TikTok built [lockfile subspaces](https://developers.tiktok.com/blog/subspaces-divide-and-conquer-your-npm-upkeep) and Sparo; DefinitelyTyped has 9,114 workspace projects. Documented counts cluster at 1,000–2,500, so the lab's 4,000-app point extrapolates above that cluster and sits below DefinitelyTyped's special case.
- yarn PnP: PnP is Yarn's default install strategy in modern releases; Datadog runs Yarn PnP across its frontend (Yarn's lead maintainer works there); Klaviyo migrated to Yarn 3 PnP zero-installs, taking CI image builds from 11 min average (16 min worst-case) to ~1 min. Those are the same two axes the lab measures: the install win and the compat boundary.
- Staged rollouts: Uber stages monorepo-wide changes by tier, deploying least-critical service tiers first; Changesets provides snapshot and prerelease lanes. Strict one-version shops (Google-style live-at-HEAD) instead cohort at the deploy layer: the mechanics differ by shop, the staging practice does not.
- CI installers: in State of JS 2025, 1,123 respondents named `bun install` among the monorepo tools they regularly use (pnpm led at 3,940). bun runs in production at Anthropic (Claude Code's infrastructure and native installer; Anthropic acquired Bun), Midjourney (frontend development), and Railway (Functions run on the Bun runtime); yarn PnP runs in production at Datadog (frontend) and Klaviyo (Yarn 3, CI). For both tools the evidence is adoption signal; there are no documented pnpm→bun or pnpm→yarn speed migrations.
- Fresh containers: GitLab's Docker executor is container-per-job (podman is a supported runtime), and GitHub's actions-runner-controller runs one ephemeral Kubernetes pod per job. GitHub-hosted runners are fresh **VMs** per job, with stronger isolation and a different fs/network substrate, so hosted-runner absolute times differ; the empty-cache-per-job property the bench isolates is the same.

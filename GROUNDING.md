# Industry Grounding

The primary source behind each practice in the benchmark, where pnpm + Turborepo hits a ceiling and the architecture that replaces it, and the methodology's mapping to benchmarking norms.

## Practices This Repo Follows

| Practice | Source |
|---|---|
| `node-linker: isolated` default, `hoisted`/`pnp` as escapes | [pnpm settings](https://pnpm.io/settings) |
| Catalogs (`catalog:`) centralize a version specifier | [pnpm catalogs](https://pnpm.io/catalogs), [Turborepo managing-dependencies](https://turborepo.dev/docs/crafting-your-repository/managing-dependencies) |
| One shared workspace lockfile | [pnpm settings](https://pnpm.io/settings) |
| Declare each dependency where it is used; root holds only tooling | [Turborepo](https://turborepo.dev/docs/crafting-your-repository/managing-dependencies) |
| Decomposed install (`--lockfile-only`, then `--frozen-lockfile` in CI) | [pnpm install](https://pnpm.io/cli/install) |
| `turbo run --filter=app...` for the dependency-closure (O(closure)) | [turbo run](https://turborepo.dev/docs/reference/run) |
| `turbo run --affected` in CI (changed packages + dependents) | [Turborepo CI guide](https://turborepo.dev/docs/crafting-your-repository/constructing-ci) |
| `turbo prune --docker` → `json/` + `full/` + pruned lockfile | [turbo prune](https://turborepo.dev/docs/reference/prune) |
| Remote caching | [Turborepo remote caching](https://turborepo.dev/docs/core-concepts/remote-caching) |
| One Vercel project per app | [Vercel monorepos](https://vercel.com/docs/monorepos), [Vercel limits](https://vercel.com/docs/limits) |

- `node-linker`: cold install within ~3% across linkers; warm relink 1.6–3.3× faster hoisted (`bench/install-bench.json`).
- Vercel: skip-unaffected does not consume a build slot; legacy turbo-ignore does.

## The Ceiling

The stack has a ceiling near where graph-load + lockfile + foundation-blast dominate; the escape is a different architecture, vendor-acknowledged with documented end-states.

- Affected + caching cannot eliminate the tasks of modified projects or their dependents; the remedy is distributed task execution ([Nx reduce-waste](https://nx.dev/docs/concepts/ci-concepts/reduce-waste)).
- Caching is not execution: remote *cache* (Nx Replay) helps only the second consumer; the escape needs distributed *execution* (Nx Agents, [Bazel RBE](https://bazel.build/remote/rbe)).
- The per-invocation O(repo) graph-load is escaped by a persistent daemon: Buck2 keeps one graph between invocations, remote-execution-first ([buck2 docs](https://buck2.build/docs/about/why/)); Bazel persistent workers cut startup ([Bazel persistent](https://bazel.build/remote/persistent)).
- End-states: Google (Piper + CitC FUSE + Blaze/Bazel, ~1B files, [paper](https://research.google/pubs/why-google-stores-billions-of-lines-of-code-in-a-single-repository/)); Meta (Sapling + EdenFS + Buck2, [Sapling](https://engineering.fb.com/2022/11/15/open-source/sapling-source-control-scalable/), [Buck2](https://engineering.fb.com/2023/04/06/open-source/buck2-open-source-large-scale-build-system/)); Microsoft (Scalar/VFS-for-Git + Rush + Lage, [Scalar](https://github.blog/open-source/git/the-story-of-scalar/), [Rush Stack](https://rushstack.io/)); Canva and Uber (Git + Bazel, [Canva](https://www.canva.dev/blog/engineering/we-put-half-a-million-files-in-one-git-repository-heres-what-we-learned/), [Uber](https://www.uber.com/blog/go-monorepo-bazel/)).

## The Git Axis

At ~130k files (20k apps) Git itself needs scaling, with the same focus-vs-whole-repo split:

- `core.fsmonitor=true` + `core.untrackedCache=true`: `git status` at 2M files 85.1s → 0.75s ([fsmonitor](https://github.blog/engineering/infrastructure/improve-git-monorepo-performance-with-a-file-system-monitor/)).
- Cone sparse-checkout + sparse index: index 180 MB → <10 MB, `git status` 1.3s → <200 ms ([sparse index](https://github.blog/open-source/git/make-your-monorepo-feel-small-with-gits-sparse-index/)).
- Partial clone (`git clone --filter=blob:none --sparse`): clone becomes O(history) not O(all blobs) ([sparse-checkout](https://github.blog/open-source/git/bring-your-monorepo-down-to-size-with-sparse-checkout/)).
- Scalar (`scalar clone`, Git 2.38+): bundles the above + commit-graph + background maintenance ([Scalar](https://github.blog/open-source/git/the-story-of-scalar/)).

## Methodology Norms

| Norm | Source |
|---|---|
| Named cold/warm/clean states | [pnpm benchmarks](https://pnpm.io/benchmarks) |
| Reset state / isolate the store between configs | [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) |
| Verify completeness (don't time a no-op) | [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) |
| Report variance, not bare averages; repeat noisy runs | [hyperfine](https://github.com/sharkdp/hyperfine), [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) |
| Report absolute numbers + full system config | [benchmarking crimes](https://gernot-heiser.org/benchmarking-crimes.html) |

- State: fresh per-run temp workspace; node_modules/yarn-state/lockfile removed per measurement; ambient tool env (`YARN_*`/`BUN_*`/`PNPM_*`/`npm_config_*`) stripped per timed run. Truly-cold redirects each tool's store + metadata to a throwaway dir, asserted populated.
- Completeness: `verifyComplete()` throws unless every app and lib resolves all declared deps + devDeps (yarn PnP through `.pnp.cjs`); build-bench errors on 0-byte output.
- System config: `/usr/bin/time -v` records CPU% and peak RSS per run; `bench/env.json` records CPU model, cores, RAM, OS, tool versions.

## Scenario Realism

Each scenario is checked against primary sources so the suite tests practices that exist in the wild.

| Scenario | Verdict | Key sources |
|---|---|---|
| Frozen install from committed lockfile as CI norm (`npm ci` / `--frozen-lockfile` / `--immutable`) | Realistic | [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [pnpm settings](https://pnpm.io/settings), [yarn rc](https://yarnpkg.com/configuration/yarnrc), [GitHub Node workflow](https://github.com/actions/starter-workflows/blob/main/ci/node.js.yml), [bun install](https://bun.com/docs/pm/cli/install) |
| Catalogs as one source of shared versions, named catalogs routing cohorts | Realistic | [pnpm Catalogs](https://pnpm.io/catalogs), [Turborepo docs](https://turborepo.dev/docs), vuejs/core, create-t3-turbo |
| Monorepos at 1,000–4,000+ packages | Realistic to ~2,500 | [Microsoft 1JS](https://www.jonathancreamer.com/how-we-shrunk-our-git-repo-size-by-94-percent/), [TikTok frontend monorepo](https://developers.tiktok.com/blog/2024-sparo-faster-git-for-frontend-monorepos), [DefinitelyTyped](https://jakebailey.dev/posts/pnpm-dt-3/) |
| yarn PnP as a production install layout | Realistic | [Yarn PnP](https://yarnpkg.com/features/pnp), [Datadog Yarn](https://opensource.datadoghq.com/projects/yarn/), [Klaviyo zero-installs](https://klaviyo.tech/goodbye-dependency-installations-a242ccf6fa40) |
| Wave-based internal-lib rollouts (pinned-stable + HEAD-tracking cohorts) | Realistic | [Uber staged rollouts](https://www.uber.com/blog/controlling-the-rollout-of-large-scale-monorepo-changes/), [pnpm named-catalog migration](https://pnpm.io/catalogs), Changesets [snapshot](https://github.com/changesets/changesets/blob/main/docs/snapshot-releases.md) and [prerelease](https://github.com/changesets/changesets/blob/main/docs/prereleases.md), [Google live-at-HEAD](https://research.google/pubs/why-google-stores-billions-of-lines-of-code-in-a-single-repository/) |
| bun / yarn 4 as the CI installer at scale | Realistic | [State of JS 2025](https://2025.stateofjs.com/en-US/other-tools/), [Anthropic](https://www.anthropic.com/news/anthropic-acquires-bun-as-claude-code-reaches-usd1b-milestone), [Midjourney](https://bun.com/blog/bun-v1.3), [Railway](https://docs.railway.com/reference/functions), [Datadog](https://opensource.datadoghq.com/projects/yarn/), [Klaviyo](https://klaviyo.tech/goodbye-dependency-installations-a242ccf6fa40) |
| Fresh containers as the CI-runner stand-in (`container-install-bench`) | Partially | Faithful for the self-hosted container tier |

- Frozen CI installs: `npm ci` is "meant to be used in automated environments"; pnpm `frozenLockfile` defaults true under CI; yarn `enableImmutableInstalls` "true (the default on CI)". `bun ci` equals `--frozen-lockfile` with no CI auto-enable — the asymmetry `yarn-rollout-bench`/`wave-rollout-bench` measure.
- Package counts: Microsoft 1JS ~2,500 packages / ~20M LOC; TikTok 1,000+ projects ([lockfile subspaces](https://developers.tiktok.com/blog/subspaces-divide-and-conquer-your-npm-upkeep) + Sparo); DefinitelyTyped 9,114 projects. Documented counts cluster at 1,000–2,500, so the lab's 4,000-app point extrapolates above the cluster and below DefinitelyTyped.
- yarn PnP: Klaviyo migrated to Yarn 3 PnP zero-installs, CI image builds 11 min average (16 min worst-case) → ~1 min.
- CI installers: State of JS 2025 — 1,123 respondents named `bun install` among monorepo tools they use (pnpm led at 3,940). bun in production at Anthropic (acquired Bun; Claude Code infra), Midjourney, Railway; yarn PnP at Datadog and Klaviyo. Evidence is adoption signal; no documented pnpm→bun or pnpm→yarn speed migrations.
- Fresh containers: GitLab's Docker executor is container-per-job; GitHub's actions-runner-controller runs one ephemeral pod per job. GitHub-hosted runners are fresh **VMs** per job (absolute times differ); the empty-cache-per-job property the bench isolates is the same.

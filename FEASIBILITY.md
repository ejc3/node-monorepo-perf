# Feasibility: should you adopt a shared-workspace monorepo?

Every benchmark number traces to a `bench/*.json` file produced by `scripts/`;
external claims are linked to their source. Stack: pnpm 10.29, Turborepo 2.9.18,
Node 22, on a 64-core arm64 box (`bench/env.json`); Next 16.2.9
(`bench/turbopack-bench.json`). Measured at 200,
1,000, 2,000, and 4,000 apps (300 / 1,200 / 2,300 / 4,300 packages); larger sizes
are labeled extrapolation.

## Verdict

A shared workspace is workable when your apps **share code and versions** (shared
libs, one-version-everywhere, cross-package refactors): the day-to-day loop is
O(closure) — seconds, no install — and the O(repo) costs fall on rare events that
are paid once per change and shared across environments. It is the wrong tool when
your apps are **independent**: the single lockfile + graph then buy nothing and you
pay their cost for no benefit — a polyrepo / separate installs fits better. The
rest of this doc is the measured basis for that split.

## The cost model: O(closure) every day, O(repo) on rare events

Day-to-day work is scoped to one app's closure and runs no install:

| daily action | mechanism | cost | source |
|---|---|---|---|
| start a dev server | `turbo dev --filter=app` / `next dev` | no install (uses existing `node_modules`); startup is `next dev`, not separately benchmarked | — |
| typecheck on save | `tsc --noEmit` on the app | median 4.3s | `dev-sim.json` |
| build before push | `turbo run build --filter=app...` | median 5.8s | `dev-sim.json` |
| onboard a feature area | build a dev's apps + lib closure | median 10.8s | `dev-sim.json` |
| a teammate's unrelated app edit | — | 0 added rebuilds to your closure | `dev-sim.json` |

The whole-workspace operations grow ~linearly with package count (`results.json`):

| O(repo) operation | 200 apps | 2,000 apps | 4,000 apps | when it is paid |
|---|---|---|---|---|
| cold install (no lockfile: resolve + materialize) | 48s | 472s | 984s (16.4m) | first install / deleted lockfile (a CI runner with the committed lockfile does a frozen install instead — ~9s, see install modes below) |
| cold typecheck (no cache) | 19s | 127s | 233s | a cache-busting change |
| warm typecheck (full cache hit) | 1.5s | 7.6s | 20.5s | every whole-repo `turbo` run |
| lockfile size | 9,897 | 79,967 | 153,967 lines | written once, read by all |

## When each O(repo) cost is paid — and what amortizes it

None of the costs above lands in the daily loop; each is a discrete event with an
amortizer:

| O(repo) cost | paid on | amortizer |
|---|---|---|
| full resolve (98–99% of a cold install, `lockfile-bench.json`) | **no usable lockfile** (first install / deleted lockfile). A *dependency change* with the lockfile present is incremental, not full — see below. | the committed lockfile: one machine resolves + commits; everyone else `--frozen-lockfile` reads it and skips the resolve |
| materialize `node_modules` (the other 1–2%) | every fresh checkout | warm store (no re-download); `turbo prune` installs only one app's closure on CI |
| cold typecheck | a cache-busting change | Remote Cache: a task runs once anywhere, others download the output (`FULL TURBO`); `--affected` only considers changed packages |
| graph-load | every `turbo` command | inherent (compute the closure); Vercel reports an 11× cut, ~1,000 pkgs 8.1s→0.7s ([blog](https://vercel.com/blog/making-turborepo-ninety-six-percent-faster-with-agents-sandboxes-and-humans)) |
| lockfile churn / conflicts | a version change | catalogs (0 manifest edits vs 25 pinned, `lockfile-merge-bench.json`); `pnpm install` auto-resolves conflicts, 253 markers → 0 ([pnpm.io/git](https://pnpm.io/git)) |

### "Paid once" means once per *change*, not once per *person or machine*

- **Resolve once, reused via git.** The resolve's result — the lockfile — is
committed to `pnpm-lock.yaml`. The full from-scratch resolve happens only when the
lockfile is first created; a later dependency change re-resolves just the delta
(incremental, see below). Either way, every teammate, CI runner, and deploy runs
`pnpm install --frozen-lockfile`, which reads the committed lockfile and skips
resolution — so the cost does not multiply with the number of people or runners.
- **Build once, reused via cache.** A task with input-hash `H` runs once anywhere;
others with the same `H` download the output. Cold typecheck 233s @4k → cached
20.5s for everyone else (`results.json` warm typecheck).
- **Residual that does repeat per environment:** each machine links its own
`node_modules` (the 1–2% materialize), pays the per-command graph-load, and pays
for its own genuine cache misses.

The build-once amortization **requires the remote cache to be on** — without it,
"once per source state" degrades to "once per machine." The committed-lockfile
amortization is automatic (the lockfile is in git).

## When the slow operations bite

Each O(repo) cost is dormant until a specific trigger fires it:

- **The full from-scratch resolve (16 min @4k) bites only when there is no usable
lockfile** — the first install, or a deleted/corrupt lockfile, or `--no-lockfile`.
It does **not** bite on a fresh clone, a cold CI runner, or a deleted
`node_modules` *as long as the committed lockfile is present* — those read the
lockfile and take the cheap path (link, plus a download if the store is cold). A
dependency change with the lockfile present is also incremental, not from-scratch —
pnpm reuses locked versions and re-resolves only the delta
(`install-modes-bench.json`, 1,000 apps, lockfile 41,069 lines):

| install situation | time | % of cold |
|---|---|---|
| cold-resolve (no lockfile) | 233.4s | 100% |
| +1 dependency (lockfile present) | 9.5s | 4% |
| catalog version bump (lockfile present) | 51.3s | 22% |
| frozen, warm store (returning machine / CI) | 7.4s | 3% |
| frozen, cold store (new CI runner) | 9.2s | 4% |

The new-CI-runner row is corroborated and extended per tool in fresh podman containers
(`container-install-bench.json`, same scale, frozen install, empty caches, real network):
pnpm 8.9s, bun **0.9s**, yarn-PnP 4.4s, yarn node-modules 6.5s, npm 10.4s — table in
[TOOLING.md](TOOLING.md).

So a one-dep change is ~10s and a fresh clone / cold CI runner is ~7–9s (frozen);
only the no-lockfile case is the 233s/16-min resolve. The exception is a **catalog
bump** (51.3s): it re-resolves that shared dep across every importer — cheap in
*edits* (0 manifests), not in *time*.
- **Cold typecheck** bites when a change invalidates many packages' cache: a shared
`tsconfig`/toolchain bump, a low-layer foundation-lib edit (rebuilds ~90% of the
repo, `dev-sim.json` blast radius), or any cache miss with no remote cache. A PR
under `--affected` + warm/remote cache rebuilds only what changed.
- **Graph-load** bites on every `turbo` command (before it computes the closure) —
sub-second to low-seconds, and being reduced (see the Vercel link above).
- **Lockfile merge conflict** bites when two branches change dependencies in
overlapping lockfile regions; `pnpm install` auto-resolves it (253→0 markers).
- **Version skew** bites while apps sit off the catalog version. Turborepo hashes a
package's resolved dependency versions as part of its task inputs, so an
off-catalog version produces a different input hash → a cache miss for that
package — which is the documented reason catalogs keep cache hashes stable (§2.3
of OPTIMIZATIONS.md). `lockfile-merge-bench.json` measures the manifest/lockfile
churn of skew (25 changed manifests), not the cache-hit rate.

## The graph-load is the only global cost single-app work pays

A shared workspace keeps **one lockfile + one dependency graph** as the source of
truth — that is what delivers one version everywhere (catalogs), atomic
cross-package refactors, and correct closure computation. Single-app operations
scope on top of it, touching a small slice: at 4,000 apps one app's build closure
is **121 of 4,300 packages (~3%)** (`results.json`), and `turbo prune` emits a
pruned lockfile of **876 of 3,969 lines** at the 80-app scale
(`focus-install-bench.json`). The only global cost a single-app command still pays
is the graph-load (reading the whole graph to find that 3%).

If your apps don't share, nothing needs to stay coherent and the global cost buys
nothing — use separate installs (`pnpm install --ignore-workspace`) or a polyrepo,
where there is no shared lockfile or graph.

## The package-manager lever: pnpm vs bun (neither required)

Turborepo supports pnpm, npm, yarn, and bun, all at its Stable tier
([support policy](https://turborepo.dev/docs/support-policy)); **bun is not
required**. The resolve dominates pnpm's install, and bun's install is much faster
(`install-bench.json`, cold install; yarn 4 is measured in the same dataset and
also beats pnpm at every scale — fastest of all at 2,000 apps, PnP 3.2s — see the
five-way table in [TOOLING.md](TOOLING.md)):

| scale | pnpm isolated | bun | ratio |
|---|---|---|---|
| 200 apps | 47.8s | 0.13s | ~357× |
| 1,000 apps | 229.5s | 2.2s | ~103× |
| 2,000 apps | 471.2s | 7.5s | ~62× |

Both package managers can do the strict setup; the difference is install speed vs
how long the strict toolchain has existed. bun 1.3+ has an isolated linker (default
for workspaces, [docs](https://bun.com/docs/pm/isolated-installs)), catalogs and
the `workspace:` protocol ([docs](https://bun.com/docs/pm/workspaces)) with
pnpm-lockfile migration ([docs](https://bun.com/docs/pm/lockfile)). The
isolated-installs + catalogs
combination had critical bugs in bun 1.3
([oven-sh/bun#23615](https://github.com/oven-sh/bun/issues/23615)), with the
documented workaround being the hoisted linker (which reintroduces phantom
dependencies). pnpm's isolated+catalog path is the longer-established one, at the
resolve cost above.

Filesystem is a minor lever: on btrfs, pnpm reflinks `node_modules` (CoW) instead
of ext4's hardlinks — equal relink time (2.9s vs 3.1s) and ~0 extra disk (0.4 MB
exclusive of 338 MB), with CoW-independent inodes (`fs-bench.json`).

## Your setup: centralized shared versions + independently-published packages

Your constraint is a hybrid, and the two halves are orthogonal:

1. **Centralize the versions of shared third-party deps** — one React, one
 TypeScript across everything.
2. **Keep internal packages independently versioned and published to npm** —
 consumed by semver/range, available on the registry.

…while it still **behaves like a workspace** (edit a lib, dependents pick up local
source). pnpm supports both axes, and they compose:

| your requirement | how pnpm does it |
|---|---|
| centralize shared third-party versions | `catalog:` in `pnpm-workspace.yaml`: one line per shared dep, referenced as `catalog:`. Bump once; measured 0 app-manifest edits on a rollout (`lockfile-merge-bench.json`). |
| internal packages independently versioned + on npm | each has its own `version`; consumers declare it by plain semver (`"@you/widget": "^1.2.0"`). With `link-workspace-packages=false` (pnpm 8+ default) that resolves from npm by version. |
| `*` / ranges | `^1.2.0`, `workspace:*`, `workspace:^`, `workspace:^1.2.0` all supported. |
| available on npm | `pnpm publish`/`pnpm pack` rewrite `workspace:` and `catalog:` to concrete versions in the tarball, so the published package has real ranges (npm does not rewrite — publish with pnpm). |
| behaves like a workspace | for in-tree dev, set `link-workspace-packages=true`, or use `workspace:^1.2.0` (links local in dev, publishes as `^1.2.0`), or inject `workspace:` transiently. |

Catalogs handle the *shared* axis; semver-internal deps + `workspace:` injection
handle the *independent-but-local-in-dev* axis. Mechanics, the publish-rewrite
walkthrough, and the diamond/override cases are in
[WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md). For the fully independent end of
the spectrum — each app its own workspace + lockfile, libs consumed from the
registry — [WORKSPACE-VS-SEMVER.md §7](WORKSPACE-VS-SEMVER.md) materializes it live
(`scripts/per-app-workspace-demo.sh`): a transitive lib resolving local in one app
and from the registry in another, which one shared root cannot do per-app.

### pnpm vs bun for this hybrid

Cells not benchmarked on bun are marked *(unverified)*.

| capability your setup needs | pnpm 10 | bun 1.3 |
|---|---|---|
| catalogs (centralize shared) | yes (`pnpm-workspace.yaml`) | yes ([docs](https://bun.com/docs/pm/workspaces)); isolated+catalog had bugs in 1.3 ([#23615](https://github.com/oven-sh/bun/issues/23615)) |
| `workspace:` + publish-rewrite to npm | yes | `bun publish` rewrites `workspace:` ([docs](https://bun.com/docs/pm/workspaces)) *(not benchmarked here)* |
| semver-internal resolves from registry | yes (`link-workspace-packages=false`) | `workspace:` → local; plain-semver local-vs-registry behavior *(verify on your bun)* |
| isolated linker (no phantom deps) | yes (default) | yes (default for workspaces, [docs](https://bun.com/docs/pm/isolated-installs)) |
| lockfile merge conflicts auto-resolved | yes, measured (253→0) | `bun.lock` ([docs](https://bun.com/docs/pm/lockfile)) *(auto-resolve not benchmarked here)* |
| whole-workspace cold install at scale | slow (16 min @4k); resolve-once, frozen elsewhere | 62–357× faster install (measured) |

The two paths, side by side (no recommendation):

- **pnpm** does the independently-published + catalogs + workspace setup as the
model pnpm documents, with the strict isolated linker; cost is the whole-workspace
resolve (16 min cold @4k) and the inode-heavy linker.
- **bun** exposes the same capabilities with 62–357× faster installs; cost is that
the isolated+catalog path is newer (1.3, 2025) and hit the bugs above, and the
*(unverified)* rows are untested here.
- **npm** works with Turborepo but has no catalogs, so the centralize-shared axis
becomes manual version-pinning. **yarn 4** has catalogs (the 4.17.0 CLI this repo
benchmarks bundles the catalog plugin) and the fastest measured cold install at
2,000 apps (`install-bench.json`, table in [TOOLING.md](TOOLING.md)); its rollout
mechanics are not vetted here the way bun's and pnpm's are ([ROLLOUT.md](ROLLOUT.md)).

*(If you meant Buck2 / Bazel rather than bun — a build system, not a package
manager — it would replace Turborepo's task orchestration, not pnpm; a separate
comparison.)*

## Version skew is the cost you cannot fully optimize away

Catalogs keep everyone on one version only while everyone stays on the catalog;
during a real rollout some apps lag. Pinning a shared dep in 25 apps off-catalog
changes 25 `package.json` files (vs 0 under catalog) and adds lockfile entries for
those apps (`lockfile-merge-bench.json`; `generate.mjs --skew`). Each off-catalog
app also gets a different Turborepo input hash for that dependency, i.e. a cache
miss until it returns to the catalog (the hashing mechanism, §2.3 of
OPTIMIZATIONS.md; the cache-hit rate itself is not benchmarked here). The
mitigation is operational: roll versions through the catalog in one commit and keep
skew windows short.

## Which direction fits which situation

| situation | direction |
|---|---|
| apps share libs, want one-version-everywhere + cross-package refactors | shared pnpm workspace + Turborepo, with remote cache + prune + catalogs |
| same, but install/resolve time dominates | same, with bun (accepting the 1.3 strict-mode caveats) or yarn 4 for installs — yarn is the fastest measured cold install at 2,000 apps, bun below that scale (`install-bench.json`) |
| many apps, weak sharing | shard into several smaller workspaces (cap each lockfile/graph) |
| apps independent (no shared libs / no version coherence) | polyrepo / separate installs — no global lockfile or graph |

## By scale

- **Up to ~1,000–2,000 apps (≤2,300 packages):** cold install minutes, cold
typecheck ~1–2 min — both rare and cacheable; daily loop seconds.
- **4,000 apps / 4,300 packages (measured):** cold install 16.4 min, cold typecheck
233s. These are bearable only if remote cache + prune keep them rare; the isolated
linker uses 86,749 `node_modules` entries / 49,712 symlinks at this size
(`results.json`), so `df -i` is worth watching — hoisted roughly halves the
entries (21,914 vs 50,159 at 2,000 apps, `install-bench.json`); yarn PnP removes
`node_modules` entirely (measured: 64 entries — unplugged native packages only —
plus a 3.5 MB `.pnp.cjs` at 2,000 apps, same dataset).
- **10,000–20,000 packages (extrapolated from the ~linear trend):** lockfile
~360k–720k lines (154k at 4,300 pkgs ≈ 36 lines/pkg), cold install and cold
typecheck in the tens of minutes. At this
size a single shared workspace needs sharding or git-based selection.

Vercel's platform also caps projects per git repo (Pro: 60; Hobby: 10; Enterprise:
custom — [limits](https://vercel.com/docs/limits)), a deployment-side ceiling
separate from these build/install costs.

## Measured vs extrapolated

Measured: 200 / 1,000 / 2,000 / 4,000 apps (`bench/results.json` + the per-axis
benches). Extrapolated (labeled as such): 10k–20k packages, by the
~linear-in-packages trend the four points establish. Reproduce any number via the
`Makefile` targets; each table names its source JSON.

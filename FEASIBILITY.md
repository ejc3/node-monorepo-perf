# Feasibility: Should You Adopt a Shared-Workspace Monorepo?

**Stack:** pnpm 10.29, Turborepo 2.9.18, Node 22, 64-core arm64 (`bench/env.json`); Next
16.2.9. Measured on [the workspace under test](README.md#the-workspace-under-test)
at 200 / 1,000 / 2,000 / 4,000 apps (300 / 1,200 / 2,300 / 4,300 packages); larger is
extrapolation.

## Verdict

A shared workspace works when apps **share code and versions**: the daily loop is
O(closure) (seconds, no install), and the O(repo) costs are rare events paid once per
change. It is the wrong tool when apps are **independent** — the single lockfile + graph
buy nothing — where a polyrepo or separate installs fit better.

## The Cost Model

Daily work is scoped to one app's closure, no install (`dev-sim.json`, 1,000 apps):

- typecheck on save (`tsc --noEmit`) median 4.3s
- build before push (`turbo run build --filter=app...`) median 5.8s
- onboard a feature area 10.8s
- a teammate's unrelated edit adds 0 rebuilds to your closure
- a dev server needs no install

Whole-workspace operations grow ~linearly with package count (`results.json`):

| O(repo) operation | 200 apps | 2,000 apps | 4,000 apps |
|---|---|---|---|
| cold install (no lockfile) | 48s | 472s | 984s (16.4m) |
| cold typecheck (no cache) | 19s | 127s | 233s |
| warm typecheck (full cache hit) | 1.5s | 7.6s | 20.5s |
| lockfile size | 9,897 | 79,967 | 153,967 lines |

## When Each O(repo) Cost Is Paid

Paid once per change, not per person. The resolve (98–99% of a cold install across
200–2,000 apps, `lockfile-bench.json`) is committed to `pnpm-lock.yaml`; everyone else
runs `pnpm install --frozen-lockfile` and skips it. A build task runs once anywhere;
others download the output — but build-once amortization **requires the remote cache on**
([LIMITS.md](LIMITS.md#remote-cache-amortizing-the-orepo-cold-start)).

Only a missing/corrupt lockfile pays the full resolve; other situations are cheap
(`install-modes-bench.json`, 1,000 apps):

- cold-resolve (no lockfile) 233.4s (100%)
- +1 dependency 9.5s (4%)
- catalog version bump 51.3s (22%)
- frozen warm-store 7.4s (3%)
- frozen cold-store 9.2s (4%)

Per tool, frozen install in fresh podman containers (`container-install-bench.json`,
1,000 apps): pnpm 8.9s, bun **0.9s**, yarn-PnP 4.4s, yarn node-modules 6.5s, npm 10.4s
([TOOLING.md](TOOLING.md#the-ci-runner-install-frozen-in-a-fresh-container)).

Cold typecheck recurs on a shared `tsconfig`/toolchain bump or a foundation-lib edit
(rebuilds ~90% of the repo at 1,000 apps, `dev-sim.json`). Lockfile conflicts
auto-resolve (253 markers → 0); catalogs change 0 manifests vs 25 pinned
(`lockfile-merge-bench.json`, 200 apps).

## Single-App Work

One shared lockfile + graph delivers one-version-everywhere and atomic refactors;
single-app commands touch a small slice. At 4,000 apps one app's build closure is **121 of
4,300 packages (~3%)** (`results.json`); `turbo prune` emits **876 of 3,969 lines** at
80-app scale (`focus-install-bench.json`). The only global cost is graph-load.

## Package-Manager Lever

On a full re-resolve, bun is ~62–357× faster than pnpm across 200–2,000 apps
(`install-bench.json`). yarn 4 also beats pnpm at every scale, fastest at 2,000, but PnP
cannot run this repo's tsgo/`next build` stack (`pnp-compat-bench.json`, a 20-app:10-lib
tree). bun's isolated+catalog path is newer and hit bugs
([#23615](https://github.com/oven-sh/bun/issues/23615)). Numbers in [TOOLING.md](TOOLING.md#install-bun-vs-pnpm-vs-yarn-4); the centralized-shared +
independently-published hybrid is in
[WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md).

## Which Direction Fits Which Situation

| situation | direction |
|---|---|
| share libs, want one-version + cross-package refactors | shared pnpm workspace + Turborepo (remote cache + prune + catalogs) |
| same, but install/resolve time dominates | same, with bun or yarn 4 for installs |
| many apps, weak sharing | shard into smaller workspaces |
| apps independent (no shared libs) | polyrepo / separate installs |

## By Scale

- **≤~1,000–2,000 apps (≤2,300 pkgs):** cold install minutes, cold typecheck ~1–2 min,
  both rare; daily loop seconds.
- **4,000 apps / 4,300 pkgs (measured):** cold install/typecheck at the cost-model maxima,
  bearable only with remote cache + prune. Isolated linker: 86,749 `node_modules` entries /
  49,712 symlinks (`results.json`); yarn PnP removes `node_modules` (64 entries + 3.5 MB
  `.pnp.cjs` at 2,000 apps, `install-bench.json`).
- **10k–20k packages (extrapolated):** lockfile ~360k–720k lines, cold install/typecheck
  in tens of minutes — needs sharding.

Vercel caps projects per git repo (Pro 60, Hobby 10, Enterprise custom,
[Vercel limits](https://vercel.com/docs/limits)).

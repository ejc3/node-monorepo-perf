# Feasibility: Should You Adopt a Shared-Workspace Monorepo?

**Stack:** pnpm 10.29 (the core scaling record: `results.json`; the
install-family records below are pnpm 12.8.1, the Rust CLI, marked where cited;
`dev-sim.json` uses pnpm 12.8.1 and the TypeScript 6.0.3 `tsc` task, on a 192-core
c8g.48xlarge), Turborepo 2.9.18, Node 22, 64-core arm64 (`bench/env.json`); Next
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

- typecheck on save (`tsc --noEmit`) median 2.6s
- build before push (`turbo run build --filter=app...`) median 5.0s
- onboard a feature area 8.6s
- a teammate's unrelated edit adds 0 rebuilds to your closure
- a dev server needs no install

Whole-workspace operations grow ~linearly with package count (`results.json`):

| O(repo) operation | 200 apps | 2,000 apps | 4,000 apps |
|---|---|---|---|
| cold install (no lockfile; the pnpm 10.29 record — pnpm 12.8.1 cold-installs the 2,000-app tree in 3.4–7.7s, `install-bench.json`) | 48s | 472s | 984s (16.4m) |
| cold typecheck (no cache) | 19s | 127s | 233s |
| warm typecheck (full cache hit) | 1.5s | 7.6s | 20.5s |
| lockfile size | 9,897 | 79,967 | 153,967 lines |

## When Each O(repo) Cost Is Paid

Paid once per change, not per person. The resolve is committed to `pnpm-lock.yaml`;
everyone else runs `pnpm install --frozen-lockfile` and skips it. Under pnpm 12.8.1 the
resolve share falls with scale: 84% of a cold install at 200 apps, 29% at 1,000, 17% at
2,000 (`lockfile-bench.json`) — resolve still dominates the 200-app cold install;
linking dominates at 1,000–2,000. (pnpm 10's JS resolver is priced leg-vs-leg in
`bench/pnpm12-bench.json`: 303.7s → 1.01s cold resolve at 1,000:200.) A build task runs once anywhere;
others download the output — but build-once amortization **requires the remote cache on**
([LIMITS.md](LIMITS.md#remote-cache-amortizing-the-orepo-cold-start)).

Under pnpm 12.8.1 every install situation is single-digit seconds — the pnpm-10 resolve
penalty is gone (the JS CLI paid 303.7s on a 1,000:200 cold resolve,
`bench/pnpm12-bench.json`), and a full re-resolve costs within 0.5% of a frozen
warm-store relink (`install-modes-bench.json`, 1,000 apps):

- cold-resolve (no lockfile) 3.0s (100%)
- +1 dependency 1.3s (45%)
- catalog version bump 1.4s (47%)
- frozen warm-store 3.0s (101%)
- frozen cold-store 3.2s (107%)

Per tool, frozen install in fresh podman containers (`container-install-bench.json`,
1,000 apps, pnpm 12.8.1): bun **1.04s** and pnpm **1.08s** (a near-tie), yarn-PnP 4.9s,
yarn node-modules 7.0s, npm 10.6s
([TOOLING.md](TOOLING.md#the-ci-runner-install-frozen-in-a-fresh-container)).

Cold typecheck recurs on a shared `tsconfig`/toolchain bump or a foundation-lib edit
(rebuilds ~90% of the repo at 1,000 apps, `dev-sim.json`). Lockfile conflicts
auto-resolve (253 markers → 0); catalogs change 0 manifests vs 25 pinned
(`lockfile-merge-bench.json`, 200 apps).

## Single-App Work

One shared lockfile + graph delivers one-version-everywhere and atomic refactors;
single-app commands touch a small slice. At 4,000 apps one app's build closure is **121 of
4,300 packages (~3%)** (`results.json`); `turbo prune` emits **1,050 of 4,127 lines** at
80-app scale (`focus-install-bench.json`, pnpm 12.8.1). The only global cost is graph-load.

## Package-Manager Lever

On a full re-resolve against pnpm 12.8.1 (the Rust CLI) the winner depends on scale:
bun is ~6× faster at 200 apps (0.14s vs 0.83s), pnpm-hoisted 1.5–2.5× faster than bun
at 1,000–2,000 apps (1.4s vs 2.1s; 3.4s vs 8.7s) (`install-bench.json`). yarn-PnP is
fastest cold at 2,000 (3.3s, with pnpm-hoisted 3.4s within 4%), but PnP
cannot run this repo's stock tsgo/`next build` stack (`pnp-compat-bench.json`, a 20-app:10-lib
tree). bun's isolated+catalog path is newer and hit bugs
([#23615](https://github.com/oven-sh/bun/issues/23615)). Numbers in [TOOLING.md](TOOLING.md#install-bun-vs-pnpm-vs-yarn-4); the centralized-shared +
independently-published hybrid is in
[WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md).

## Which Direction Fits Which Situation

| situation | direction |
|---|---|
| share libs, want one-version + cross-package refactors | shared pnpm workspace + Turborepo (remote cache + prune + catalogs) |
| same, but install/resolve time dominates | same; pnpm 12's Rust CLI removed the resolve wall — cold installs are seconds at every measured scale. bun leads at 200 apps and truly-cold, pnpm-hoisted at 1,000–2,000, and the CI frozen install is a near-tie |
| many apps, weak sharing | shard into smaller workspaces |
| apps independent (no shared libs) | polyrepo / separate installs |

## By Scale

- **≤~1,000–2,000 apps (≤2,300 pkgs):** cold install minutes on the pnpm-10 record
  (seconds under pnpm 12.8.1), cold typecheck ~1–2 min,
  both rare; daily loop seconds.
- **4,000 apps / 4,300 pkgs (measured):** cold install/typecheck at the cost-model maxima,
  bearable only with remote cache + prune. Isolated linker: 86,749 `node_modules` entries /
  49,712 symlinks (`results.json`); yarn PnP removes `node_modules` (64 entries + 3.5 MB
  `.pnp.cjs` at 2,000 apps, `install-bench.json`).
- **10k–20k packages (extrapolated):** lockfile ~360k–720k lines, cold install/typecheck
  in tens of minutes — needs sharding.

Vercel caps projects per git repo (Pro 60, Hobby 10, Enterprise custom,
[Vercel limits](https://vercel.com/docs/limits)).

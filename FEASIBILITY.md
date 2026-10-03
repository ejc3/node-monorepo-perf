# Feasibility: Should You Adopt a Shared-Workspace Monorepo?

**Stack:** pnpm 12.8.1 (the Rust CLI), Turborepo 2.9.18, Node 22, Next 16.2.9. The core
scaling record (`results.json`) and `dev-sim.json` run the TypeScript 6.0.3 `tsc` task on a
192-core c8g.48xlarge; the install-family records cited below ran on the 64-core arm64 box
(`bench/env.json`). Measured on [the workspace under test](README.md#the-workspace-under-test)
at 200 / 1,000 / 2,000 / 5,000 / 10,000 / 20,000 apps (300 → 20,300 packages); the
whole-workspace typecheck stops at 10,000 apps.

## Verdict

A shared workspace works when apps **share code and versions**: the daily loop's work
is O(closure) (seconds, no install; each turbo command also pays a graph load that grows
with the repo, priced under Single-App Work), and the O(repo) costs are rare events paid
once per change. It is the wrong tool when apps are **independent** — the single lockfile + graph
buy nothing — where a polyrepo or separate installs fit better.

## The Cost Model

Daily work is scoped to one app's closure, no install (`dev-sim.json`, 1,000 apps):

- typecheck on save (`tsc --noEmit`) median 2.6s
- build before push (`turbo run build --filter=app...`) median 5.0s
- onboard a feature area 8.6s
- a teammate's unrelated edit adds 0 rebuilds to your closure
- a dev server needs no install

Whole-workspace operations grow with package count (`results.json`):

| O(repo) operation | 200 apps | 2,000 apps | 10,000 apps | 20,000 apps |
|---|---|---|---|---|
| cold install (no lockfile, warm store) | 0.6s | 1.6s | 31.3s | 74.9s |
| cold typecheck (no cache) | 8.4s | 46.6s | 222.8s | not run |
| warm typecheck (full cache hit) | 1.0s | 5.2s | 23.9s | not run |
| lockfile size | 10,185 | 80,255 | 376,255 | 746,255 lines |

Typecheck and lockfile size are ~linear in package count. Install is not: 3.9s at 5,000
apps, 31.3s at 10,000.

## When Each O(repo) Cost Is Paid

Paid once per change, not per person. The resolve is committed to `pnpm-lock.yaml`;
everyone else runs `pnpm install --frozen-lockfile` and skips it. Under pnpm 12.8.1 the
resolve share falls with scale: 84% of a cold install at 200 apps, 29% at 1,000, 17% at
2,000 (`lockfile-bench.json`) — resolve still dominates the 200-app cold install;
linking dominates at 1,000–2,000. (pnpm 10's JS resolver is priced leg-vs-leg in
`bench/pnpm12-bench.json`: 303.7s → 1.01s cold resolve at 1,000:200.) A build task runs once anywhere;
others download the output — but build-once amortization **requires the remote cache on**
([LIMITS.md](LIMITS.md#remote-cache-amortizing-the-orepo-cold-start)).

At 1,000 apps under pnpm 12.8.1 every install situation is single-digit seconds — the pnpm-10 resolve
penalty is gone (the JS CLI paid 303.7s on a 1,000:200 cold resolve,
`bench/pnpm12-bench.json`), and a full re-resolve costs within 0.5% of a frozen
warm-store relink (`install-modes-bench.json`, 1,000 apps):

- cold-resolve (no lockfile) 3.0s (100%)
- +1 dependency 1.3s (45%)
- catalog version bump 1.4s (47%)
- frozen warm-store 3.0s (101%)
- frozen cold-store 3.2s (107%)

Per tool, frozen install in fresh podman containers (`container-install-bench.json`,
1,000 apps, pnpm 12.8.1): bun **1.03s** and pnpm **1.09s** (+6%), yarn-PnP 4.8s,
yarn node-modules 6.7s, npm 10.4s
([TOOLING.md](TOOLING.md#the-ci-runner-install-frozen-in-a-fresh-container)).

Cold typecheck recurs on a shared `tsconfig`/toolchain bump or a foundation-lib edit
(rebuilds ~90% of the repo at 1,000 apps, `dev-sim.json`). Lockfile conflicts
auto-resolve (253 markers → 0); catalogs change 0 manifests vs 25 pinned
(`lockfile-merge-bench.json`, 200 apps).

## Single-App Work

One shared lockfile + graph delivers one-version-everywhere and atomic refactors;
single-app commands touch a small slice. At 20,000 apps one app's build closure is **100 of
20,300 packages (~0.5%)** (`results.json`); `turbo prune` emits **1,050 of 4,127 lines** at
80-app scale (`focus-install-bench.json`, pnpm 12.8.1). The only global cost is graph-load,
and it is measurable at the top: the focused build of a 100-package closure takes 11.9s at
2,000 apps and 39.5s at 20,000.

## Package-Manager Lever

On a full re-resolve against pnpm 12.8.1 (the Rust CLI) the winner depends on scale:
bun is ~5× faster at 200 apps (0.13s vs 0.65–0.67s), pnpm-hoisted 2.4–3.8× faster than bun
at 1,000–2,000 apps (1.2s vs 2.9s; 2.5s vs 9.6s) (`install-bench.json`). yarn-PnP is
second-fastest cold at 2,000 (3.2s to pnpm-hoisted's 2.5s) with no `node_modules`, but PnP
cannot run this repo's stock tsgo/`next build` stack (`pnp-compat-bench.json`, a 20-app:10-lib
tree). bun's isolated+catalog path is newer and hit bugs
([#23615](https://github.com/oven-sh/bun/issues/23615)). Numbers in [TOOLING.md](TOOLING.md#install-bun-vs-pnpm-vs-yarn-4); the centralized-shared +
independently-published hybrid is in
[WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md).

## Which Direction Fits Which Situation

| situation | direction |
|---|---|
| share libs, want one-version + cross-package refactors | shared pnpm workspace + Turborepo (remote cache + prune + catalogs) |
| same, but install/resolve time dominates | same; pnpm 12's Rust CLI removed the resolve wall — cold installs are under 4s through 5,000 apps (31.3s at 10,000, 74.9s at 20,000, `results.json`). bun leads at 200 apps and truly-cold, pnpm-hoisted at 1,000–2,000, and bun leads the CI frozen install by 6% (fresh) |
| many apps, weak sharing | shard into smaller workspaces |
| apps independent (no shared libs) | polyrepo / separate installs |

## By Scale

- **≤~1,000–2,000 apps (≤2,300 pkgs):** cold install 1.1–1.6s, cold typecheck 25–47s,
  both rare; daily loop seconds.
- **10,000 apps / 10,300 pkgs (measured):** cold typecheck 222.8s, cold install 31.3s, a
  full-cache-hit typecheck 23.9s. Isolated linker: 194,827 `node_modules` entries /
  121,712 symlinks (`results.json`); yarn PnP removes `node_modules` (64 entries + 3.5 MB
  `.pnp.cjs` at 2,000 apps, `install-bench.json`).
- **20,000 apps / 20,300 pkgs (measured, except the whole-workspace typecheck):** lockfile
  746,255 lines, cold install 74.9s, `turbo prune` 25.0s and a focused build 39.5s for a
  ~100-package selection. The whole-workspace tsc typecheck is not run at this scale;
  extrapolating the 10,000-app per-package rate gives ~7 minutes cold on 192 cores — needs
  sharding.

Vercel caps projects per git repo (Pro 60, Hobby 10, Enterprise custom,
[Vercel limits](https://vercel.com/docs/limits)).

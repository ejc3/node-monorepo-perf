# Feasibility: should you adopt a shared-workspace monorepo?

This repo is feasibility research from a standing start — you are **not** on a
pnpm-workspace monorepo today. The question is not "is pnpm-workspaces good," but:
given the measured costs, what does the full optimization stack actually buy,
**when are the expensive costs paid vs amortized away**, and is the switch worth
it — in any direction (pnpm, bun, sharding, polyrepo).

Every number below traces to a `bench/*.json` file produced by `scripts/`. Stack:
pnpm 10.29, Turborepo 2.9.18, Next 16, Node 22, on a 64-core arm64 box
(`bench/env.json`). Measured to 4,000 apps / 300 libs (4,300 packages); larger is
labeled extrapolation.

## The one-line verdict

**Feasible, and the daily experience is fast — *if* your apps genuinely share code
and versions, and you run the amortizers (committed lockfile + remote cache +
`turbo prune` + catalogs).** The day-to-day loop is O(closure): seconds, no
install. The expensive work is O(repo), but it is paid on **rare events**
(onboarding, a lockfile change, a cache-busting change), once per change rather
than once per person, and shared across every environment. **Not worth it if your
apps are independent** — then the global coordination is pure overhead and a
polyrepo / separate installs is the better answer.

## The cost model: O(closure) every day, O(repo) on rare events

What you do all day is scoped to one app's dependency closure and never installs:

| daily action | mechanism | cost (measured) | scales with |
|---|---|---|---|
| spin up a dev server | `turbo dev --filter=app` / `next dev` | seconds; **no install** | one app |
| typecheck on save | `tsc --noEmit` on the app | median **4.3s** (`dev-sim.json`) | one app |
| build before push | `turbo run build --filter=app...` | median **5.8s** | app's closure |
| onboarding a feature area | build apps + lib closure | median **10.8s** | closure |
| a teammate's unrelated edit | — | **0** added rebuilds to yours | — |

The expensive operations are whole-workspace, and they grow ~linearly with package
count (`bench/results.json`, 200 → 4,000 apps):

| O(repo) operation | 200 | 2,000 | 4,000 | when it's actually paid |
|---|---|---|---|---|
| cold install (resolve + materialize) | 49s | 477s | **984s** (16.4m) | fresh clone, blown `node_modules`, cold CI |
| cold typecheck (no cache) | 19s | 127s | **233s** | a cache-busting change |
| warm typecheck (full cache hit) | 1.5s | 7.6s | **20.5s** | every whole-repo `turbo` run |
| lockfile size | 9.9k | 80k | **154k** lines | committed once, read by all |

## When each O(repo) cost is paid — and what amortizes it to ~never

This is the crux. None of the costs above is paid in the daily loop; each is a
discrete event with an amortizer:

| O(repo) cost | paid on | amortizer (measured) |
|---|---|---|
| **resolve** (98–99% of install — `lockfile-bench.json`) | a dependency change | the **committed lockfile**: one machine resolves, commits; everyone else `--frozen-lockfile` *reads* it and skips the resolve |
| **materialize** `node_modules` (the other 1–2%) | every fresh checkout | warm store (no re-download); `turbo prune` installs only one app's closure on CI |
| **cold build/typecheck** | a cache-busting change | **Remote Cache**: run once anywhere → downloaded everywhere (`FULL TURBO`); `--affected` only considers changed packages |
| **graph-load floor** | every `turbo` command | Vercel cut it **11×** (Mar 2026: ~1,000 pkgs 8.1s → 0.7s); inherent price of computing the closure |
| **lockfile churn / conflicts** | a version change | **catalogs** (0 manifest edits vs 25 pinned — `lockfile-merge-bench.json`); `pnpm install` auto-resolves conflicts (253 markers → 0); branch lockfiles |

### "Paid once" means once per *change*, not once per *person or machine*

- **Resolve once, reused via git.** The 16-min/154k-line resolve is paid by
  whoever bumps a dependency and committed to `pnpm-lock.yaml`. Every teammate, CI
  runner, and deploy runs `pnpm install --frozen-lockfile`, which reads the lockfile
  and skips the resolve. After 50 devs and 10,000 CI runs, that bump's resolve was
  paid **once**. Adding the 100th CI runner does not re-trigger it.
- **Build once, reused via cache.** A task with input-hash `H` runs once anywhere;
  every other environment with the same `H` downloads the output. Cold typecheck
  233s @4k → cached **20.5s** for everyone else.
- **Residual that does repeat per environment** (honest): each machine links its
  own `node_modules` (the 1–2% materialize, seconds), pays the small per-command
  graph-load, and pays for its own genuine cache misses.

The build-once amortization **requires the remote cache to be on** — without it,
"once per source state" degrades to "once per machine." (The committed-lockfile
amortization is automatic; the lockfile is in git.)

## When the slow operations bite

Each O(repo) cost is dormant until a specific trigger fires it:

- **Cold install (16 min @4k)** bites on: a fresh clone with no `node_modules`; a
  deleted `node_modules`; a CI runner with a cold cache. It does **not** bite on a
  dev-server start, a branch switch with an unchanged lockfile, or a warm
  re-install (7–16s).
- **The resolve** (98–99% of that install) bites **only when the lockfile must be
  regenerated** — a dependency added/removed/bumped — on the one machine making the
  change. `--frozen-lockfile` (reading the committed lockfile) never triggers it.
- **Cold typecheck/build (233s @4k)** bites when a change invalidates many
  packages' cache: a shared `tsconfig`/toolchain bump, a low-layer foundation-lib
  edit (rebuilds ~90% of the repo), or any cache miss with no remote cache. A
  normal PR under `--affected` + warm/remote cache rebuilds only what changed.
- **Graph-load** bites on **every** `turbo` command (before it computes the
  closure) — but it's sub-second to low-seconds, and shrinking.
- **Lockfile merge conflict** bites when two branches both change dependencies in
  overlapping lockfile regions (a version rollout); `pnpm install` auto-resolves it.
- **Version skew** bites continuously while apps sit off the catalog version: each
  off-catalog app carries extra lockfile entries and a distinct Turbo input hash (a
  guaranteed cache miss) until it's pulled back onto the catalog.

## Why there is "global" cost at all for single-app work

A shared workspace keeps **one lockfile + one dependency graph** as the source of
truth — that is what delivers one version everywhere (catalogs), atomic
cross-package refactors, and correct closure computation. Single-app operations
**scope on top of** that, touching a tiny slice: at 4,000 apps one app's build
closure is **121 of 4,300 packages (~3%)** and `turbo prune` emits a pruned
lockfile of **876 of 3,969 lines** (`focus-install-bench.json`, 80-app scale). The
only global cost a single-app command still pays is the **graph-load** (you must
read the whole graph to know your 3%) — small, and shrinking 11×.

If your apps don't share, there is nothing to keep coherent and the global cost
buys nothing — use separate installs (`pnpm install --ignore-workspace`) or a
polyrepo, and there is no shared lockfile or graph to pay for.

## The package-manager lever: pnpm vs bun (neither required)

Turborepo supports pnpm, npm, yarn, and bun (all Stable tier); **bun is not
required**. But the resolve is the bottleneck, and bun's install is dramatically
faster (`install-bench.json`, cold install):

| scale | pnpm isolated | bun | ratio |
|---|---|---|---|
| 200 | 48.8s | 0.11s | ~440× |
| 1,000 | 232s | 2.3s | ~100× |
| 2,000 | 477s | 8.3s | ~58× |

The trade is **speed-now vs maturity**, not "speed vs losing features": bun 1.3+
has an isolated linker (default for workspaces), catalogs, the `workspace:`
protocol, and auto-migrates `pnpm-lock.yaml`/`pnpm-workspace.yaml`. But the exact
strict setup — isolated installs + catalogs — had critical bugs in bun 1.3
([oven-sh/bun#23615](https://github.com/oven-sh/bun/issues/23615)) with the
workaround being the hoisted linker (which reintroduces phantom dependencies). So:
pnpm = strict + catalogs at a steep resolve cost; bun = fast installs but younger
monorepo tooling and the strict-mode bugs. Pick per your tolerance.

Filesystem is a minor lever: on btrfs, pnpm reflinks `node_modules` (CoW) instead
of ext4's hardlinks — same relink time (2.9s vs 3.1s) and ~0 extra disk (0.4 MB
exclusive of 338 MB), with CoW-safe independent inodes (`fs-bench.json`).

## Your setup: centralized shared versions + independently-published packages

Your constraint is a **hybrid**, and the two halves are orthogonal:

1. **Centralize the versions of shared third-party deps** — one React, one
   TypeScript, etc. across everything.
2. **Keep internal packages independently versioned and published to npm** —
   consumed by semver/range (for separation), available on the registry.

…while it still **feels like a workspace** (edit a lib, its dependents pick up the
local source). All of this is first-class in pnpm — it is literally pnpm's
documented model — and the two axes compose:

| your requirement | how pnpm satisfies it |
|---|---|
| centralize shared third-party versions | **`catalog:`** in `pnpm-workspace.yaml`: one line per shared dep, every package references `catalog:`. Bump once, everyone moves; measured 0 app-manifest edits on a rollout (§1.3). |
| internal packages independently versioned + on npm | each package has its own `version`; consumers declare it by **plain semver** (`"@you/widget": "^1.2.0"`). With `link-workspace-packages=false` (pnpm 8+ default) that resolves from **npm by version** — CI, prod, and outside consumers get the published release. |
| `*` / ranges | `^1.2.0`, `workspace:*`, `workspace:^`, `workspace:^1.2.0` all supported. |
| available on npm | `pnpm publish`/`pnpm pack` rewrite `workspace:` and `catalog:` to concrete versions in the tarball, so the published package has real `^1.2.0` / `19.2.7` deps — consumable by npm / yarn / bun users (npm itself does **not** rewrite — use pnpm to publish). |
| still feels like a workspace | for in-tree dev, either set `link-workspace-packages=true` (a satisfying semver resolves to the local package), or use `workspace:^1.2.0` (links local in dev, publishes as `^1.2.0`), or inject `workspace:` transiently. Edit the lib → dependents build against local source. |

So: **catalogs handle the *shared* axis; semver-internal deps + `workspace:`
injection handle the *independent-but-local-in-dev* axis.** Full mechanics, the
publish-rewrite walkthrough, and the diamond/override edge cases are in
[WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md).

### pnpm vs bun for this exact hybrid

Both can do it; the axis is maturity vs install speed. Cells I have **not**
benchmarked on bun are marked *(unverified)* — I won't assert bun behavior I
didn't test.

| capability your setup needs | pnpm 10 | bun 1.3 |
|---|---|---|
| catalogs (centralize shared) | yes, mature (`pnpm-workspace.yaml`) | yes, but isolated+catalog had **critical bugs** in 1.3 ([#23615](https://github.com/oven-sh/bun/issues/23615)) |
| `workspace:` + publish-rewrite to npm | yes, mature — this is pnpm's bread and butter | `bun publish` rewrites `workspace:` *(newer, not benchmarked here)* |
| semver-internal resolves from registry, not local | yes (`link-workspace-packages=false`) | `workspace:` → local; plain-semver local-vs-registry behavior differs *(verify on your bun)* |
| isolated linker (no phantom deps) | yes (default) | yes (default for workspaces, 1.3+) |
| lockfile merge conflicts auto-resolved | yes, measured (253 → 0 markers) | `bun.lock` *(auto-resolve not verified here)* |
| whole-workspace cold install at scale | slow (16 min @4k) — but resolve-once, frozen everywhere | **58–440× faster** install (measured) |

**The two approaches, side by side (no pick — yours to make):**

- **pnpm** does the independently-published-packages + catalogs + workspace-feel
  model exactly as documented and battle-tested, with the strict isolated linker.
  Cost: the whole-workspace resolve (16 min cold @4k), inode-heavy linker.
- **bun** exposes the same capabilities (catalogs, `workspace:`, isolated linker,
  publish-rewrite, auto-migration) with **58–440× faster installs**. Cost: the
  isolated+catalog path is newer and hit critical bugs in 1.3 (#23615), and the
  rows marked *(unverified)* above I did not test on bun.
- **npm / yarn** work with Turborepo but have **no catalogs**, so the
  centralize-shared axis becomes manual version-pinning.

The axis is speed-now (bun) vs maturity (pnpm) for the exact strict setup you
want; the verified facts are in the table above.

*(If by "buck" you meant **Buck2 / Bazel** — a build system, not a package manager
— that's a different axis: it would replace Turborepo's task orchestration, not
pnpm. Say so and I'll add that comparison.)*

## Version skew is the cost you can't fully optimize away

Catalogs keep everyone on one version *if everyone stays on the catalog*. During a
real rollout they don't: some apps lag. Skew is measurable
(`lockfile-merge-bench.json`, and `generate.mjs --skew`): pinning a shared dep in
25 apps off-catalog changes **25 `package.json` files** (vs 0 under catalog) and
adds lockfile entries + divergent Turbo input hashes (fewer cache hits) for those
apps. The mitigation is operational, not technical: roll versions through the
catalog in one commit and keep skew windows short.

## When NOT to adopt — and the alternatives (any direction)

| your situation | recommended direction |
|---|---|
| apps share libs, want one-version-everywhere + atomic refactors | **shared pnpm workspace + Turborepo** (this model) with remote cache + prune + catalogs |
| same, but install/resolve time is the dominant pain | same, but evaluate **bun** for installs (accept the 1.3 strict-mode caveats) |
| thousands of apps, weak sharing | **shard** into several smaller workspaces (cap each lockfile/graph) — Vercel documents only **60 projects per repo** |
| apps are independent (no shared libs, no version coherence) | **polyrepo / separate installs** — no global lockfile or graph; skip the model |

## Verdict by scale

- **Up to ~1,000–2,000 packages:** comfortable. Cold install minutes, cold
  typecheck ~1–2 min, both rare and cached; daily loop seconds. This is the range
  Vercel's tooling targets (≤60 projects/repo) and operates in.
- **~4,000 packages (measured):** still feasible but the cold floors hurt — 16-min
  cold install, 4-min cold typecheck. You **must** run remote cache + prune so
  those are paid rarely, and watch the inode count (isolated linker: 86,749
  `node_modules` entries / 49,712 symlinks at 4k — `df -i` matters; hoisted/pnp cut
  it).
- **10,000–20,000 packages (extrapolated from the ~linear trend):** the lockfile
  (~400k–800k lines), cold install (tens of minutes), and cold typecheck (tens of
  minutes) become real operational risks. At this size, loading one task graph is
  itself O(repo); shard or use git-based selection, and treat a single shared
  workspace as a deliberate, well-resourced choice — not a default.

## Measured vs extrapolated

Measured: 200, 1,000, 2,000, 4,000 packages (`bench/results.json` + the per-axis
benches). Extrapolated (labeled as such): 10k–20k, by the ~linear-in-packages
trend the four points establish. Reproduce any number via the `Makefile` targets;
the command for each table is named in its caption or the section header.

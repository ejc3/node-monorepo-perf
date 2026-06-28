# Rolling out a new version of an internal core lib

How to advance a shared internal library across a 4,000-app monorepo: gate it against every app
before it merges, move consumers onto it in waves, keep some consumers on a pinned stable version
while others track in-repo HEAD, hold third-party deps frozen while internal deps are driven forward,
and keep every build reproducible. Publishing every package to the registry (AWS CodeArtifact) is
assumed available.

Every mechanic below is measured in `bench/wave-rollout-bench.json` (a self-contained repro:
`node scripts/wave-rollout-bench.mjs`) or an existing bench named inline; the bun claims are also
cross-checked against bun's source at the `bun-v1.3.14` tag.

## The one idea: the lockfile is the determinism boundary, not the range form

"Floating on the registry, where every rebuild resolves something different" is not caused by a `^` or
`*` range. It is caused by **resolving live** — a non-frozen install, or no committed lockfile. With a
committed lockfile and a frozen install, the range is inert: the installer reads the exact pinned
version and never consults the registry.

Measured (`bench/wave-rollout-bench.json`, `frozenPnpm`): a `^3.0.0` dependency, committed lockfile,
`pnpm install --frozen-lockfile` twice from a wiped `node_modules` — byte-identical both runs (same
resolved version, same lockfile hash). Drift the manifest out of sync with the lockfile and the same
command **fails closed** (`ERR_PNPM_OUTDATED_LOCKFILE`) rather than silently re-resolving. So the fix
for reproducibility is **commit the lockfile + install frozen everywhere**, not pin every range to an
exact version.

This makes "frozen vs not-frozen" the whole answer to driving internal versions:

- **Frozen** (`pnpm install --frozen-lockfile`) runs everywhere a build must reproduce — every CI run,
  the all-app gate, every deploy. It performs no resolution, so third-party never moves and rebuilds
  are identical.
- **Not-frozen** runs in the deliberate places: authoring an advance (the wave), plus routine
  dependency add/remove. Each is a re-resolve that rewrites the lockfile; **the committed lockfile diff
  is the change.** Third-party stays frozen by *inaction on its versions* — not by an origin-aware
  toggle (the lockfile freezes third-party and internal identically). One caveat: advancing an internal
  lib re-resolves *that lib's own* subtree, so if its third-party deps changed, transitive third-party
  can move — which is why the wave PR reviews the lockfile diff.

The time split is already measured (`bench/install-modes-bench.json`, 1,000 apps / 200 libs): a
from-scratch resolve with no lockfile is 233s; a frozen install is 7.4s warm-store / 9.2s on a cold
CI runner; a one-dependency change against the committed lockfile is 9.5s; a catalog bump that
re-resolves a shared dep across every importer is 51s. Frozen is the cheap, reproducible default; the
expensive resolve bites only without a usable lockfile.

### pnpm owns the boundary; bun is the installer, not the authority

The stack of record installs with bun, but the determinism boundary should be pnpm, for two
source-verified reasons (`bun-v1.3.14`, `src/install`), each also measured on this machine
(`bench/wave-rollout-bench.json`, `frozenBun`):

- **bun does not auto-enable frozen in CI; pnpm does.** `frozen_lockfile` is set only by
  `--frozen-lockfile`, `bun ci`, `--production`, or bunfig (`CommandLineArguments.zig:797`,
  `PackageManagerOptions.zig:335-344,613-620`); the one `env.isCI()` check only disables the progress
  bar (`PackageManagerOptions.zig:392`). Measured: a bare `bun install` with `CI=1` on a drifted
  lockfile re-resolved and rewrote `bun.lock` (exit 0, `autoFroze=false`). pnpm flips its
  frozen-lockfile default to true in CI. So on bun, frozen is a flag you must pass on every call site,
  not a property you inherit.
- **bun ignores pnpm-workspace.yaml catalogs.** bun reads catalogs from `package.json`
  (`lockfile/Package.zig:1592-2011`); pnpm-workspace.yaml is read only via the one-time migration path
  (`pnpm.zig`). Measured: a `catalog:` defined only in pnpm-workspace.yaml does not resolve under
  `bun install` (exit 1, `resolvedPnpmCatalog=false`). The repo already decatalogs before any bun
  install for this reason (`scripts/optimal-gate-bench.mjs`).

bun's explicit `--frozen-lockfile` does fail closed on the drift measured here (exit 1) — so bun is not
broken — but `oven-sh/bun#24223` reports contexts where it does not, and the two points above mean the
lockfile and the channel of record stay on pnpm. Run bun for install speed; gate and stage the rollout
on pnpm.

## The mechanisms, scoped honestly

| mechanism | what it gives | the catch |
|---|---|---|
| committed lockfile + `--frozen-lockfile` | the hermetic boundary; ranges inert; third-party frozen by inaction | sound on pnpm; on bun it is a flag to enforce, and bun ignores pnpm catalogs |
| pnpm **named catalogs** (`catalog:stable`/`catalog:next`) | central version channels; a repoint is one catalog entry, zero consumer-manifest edits | reach only **direct** deps; **reject `workspace:` specs**; invisible to bun |
| registry **semver pins** (`link-workspace-packages=false`) | per-cohort version control for a directly-imported lib; two majors coexist in one lockfile | also needs `prefer-workspace-packages=false`; a pinned cohort loses in-tree `--affected` + instant lib-edit feedback for that lib |
| **`workspace:`** link | co-dev / track HEAD; instant local edits, no publish | a partition of consumers, not the fleet; use `workspace:*`/`workspace:^`, not `workspace:^x.y.z`, for HEAD-tracking |
| **`pnpm.overrides`** (root, can reference a catalog) | force a transitive internal dep repo-wide in lockstep | root-scoped (all-or-nothing per edge); cannot pin a workspace copy |
| changesets (pre/snapshot) + a codemod/Renovate driver | version-bump fanout, prerelease channels, cohort-edit automation | not wired here; 400 interdependent libs publish in **topological** order |

Measured catalog facts (`bench/wave-rollout-bench.json`, `namedCatalogDirect`/`catalogRejectsWorkspace`):
two cohorts on `catalog:stable` and `catalog:next` resolve `is-odd@1.0.0` and `is-odd@3.0.0` in one
lockfile; repointing the `stable` entry to the new version moved that cohort with **0 of 2 consumer
manifests edited** (measured by hashing every consumer manifest before and after). A catalog value that is
a `workspace:` spec is a hard install error (`ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC`) for every
form tested (`workspace:*`, `workspace:^`, `workspace:~`, `workspace:^1.0.0`). The
central-vs-per-manifest cost is also measured at `bench/lockfile-merge-bench.json`: a catalog bump
changes 0 app manifests; a per-app pin of the same version changes 25.

## Two limits you cannot design away

**1. A *universal* core lib is direct AND transitive, so per-cohort waves on it are a republish-fanout,
not a one-line flip.** Every app imports the foundation tier directly, and every non-foundation shared
lib also depends on it (`scripts/generate.mjs`), so an app reaches the foundation both directly and
transitively through whatever libs it imports. A published lib bakes a **concrete** range for its own internal deps into the
tarball: measured (`bench/wave-rollout-bench.json`, `universalCollapse`), a source spec of `workspace:^`
is rewritten to `^1.0.0` in `pnpm pack`'s output. So a consumer catalog over `@demo/core` cannot repoint
the `lib → core` edge baked inside every dependent lib's tarball — holding a cohort on the old core means
**republishing the dependent libs**. The clean "wave = one catalog line" story holds for a lib consumed
**only directly** (the catalog-routing measurement above), or for **non-breaking** advances of a
universal one. Two coexisting majors of a directly-imported lib is the diamond behavior
(`WORKSPACE-VS-SEMVER.md` §3) — but it is a registry-version story, not a `workspace:` one.

**2. A breaking change forces expand / migrate / contract, because the gate is global and synchronous.**
A breaking signature turns every dependent red at once — measured at 4,000/4,000 apps, 4,399 `TS2554`
diagnostics, in 1.39s (`bench/optimal-gate-bench.json`). With "merge only on green," a hard major is
never green until every app migrates in one atomic PR — a flag day, the opposite of a wave. The
protocol that keeps every wave green is:

- **Expand** — ship the new API additively alongside the old (a non-breaking minor; the gate stays
  green for all 4,000).
- **Migrate** — move cohorts onto the new API wave by wave; each wave stays green.
- **Contract** — remove the old API only after every cohort has migrated (the final breaking major).

So "roll out a new version in waves" is really *roll out adoption of a new API additively, then
contract* — not run two majors of a universal lib at once.

## Mixed consumers: two modes, both hermetic, one partition

| mode | spec | pinned by | who |
|---|---|---|---|
| registry-pinned cohort (gets waves) | `catalog:stable` / `catalog:next` / a published semver (needs `link-workspace-packages=false`) | the committed lockfile | the fleet; advances only when its cohort's pin moves |
| workspace-linked (tracks HEAD / co-dev) | `workspace:*` / `workspace:^` | the git SHA of the checkout | the team co-developing the lib |

Both are deterministic — one pins against the lockfile, the other against the git tree
(`WORKSPACE-VS-SEMVER.md` §1-2, `scripts/registry-resolution-demo.sh`). They are a **partition**, not
both-for-everyone: the small co-dev set gets instant-local-source edits; the 4,000-app fleet is
publish-then-bump. Giving the whole fleet instant-local propagation would mean a root override forcing
every app onto the local copy — which forfeits the per-cohort pinning the waves depend on. Two notes the
config requires: the repo's `.npmrc` sets `link-workspace-packages=true` + `prefer-workspace-packages=true`
(every internal dep is `workspace:*`), so nothing resolves from the registry today; the registry-cohort
half needs **both** flipped to `false`. Keep the in-tree dev version a distinct pre-release identifier
(e.g. `2.0.0-dev`) so a published `2.0.0` and the moving HEAD never collide on one number.

## Codemods for the per-manifest parts

The version-control spine stays native — catalogs, the lockfile, frozen installs, the `workspace:`
protocol, the publish rewrite. The parts that are genuinely N manifest edits — assigning apps to a
cohort (switching a consumer's `catalog:stable` to `catalog:next`) and the *migrate* step of
expand/migrate/contract (rewriting call sites from the old API to the new) — are codemod territory
(jscodeshift / ast-grep), driven per wave. This keeps the cohort-assignment cost mechanical without
bolting a foreign version mechanism onto the workspace.

## Gate the artifact, not just the source

The fast whole-program gate (`bench/optimal-gate-bench.json`, 1.32s) type-checks `@demo/*` mapped to
`packages/*/src` — it validates the in-tree **source**, which is what a `workspace:`-linked consumer
compiles. A registry-pinned cohort consumes the published **tarball** (`dist/index.d.ts`), so the wave
gate must also resolve the lib through the installed published version and run the declaration build:

- The fast gate runs `declaration:false` and provably misses `.d.ts` portability errors that the build
  catches (`bench/decl-emit-caveat.json`: tsc `TS2742` / tsgo `TS2883`). tsgo does not emit
  declarations, so a `tsc --declaration` build is also the only thing that proves the artifact is
  publishable — add it to the pre-merge gate, not as an afterthought.
- The gate is typecheck-only — no app build, no tests, no runtime. "Run the new lib against all 4,000
  apps" is, precisely, *typecheck 4,000 apps*; signature/arity breaks surface (the `TS2554` fanout),
  behavior does not. Pair it with a post-deploy health signal (bake window / canary) before promoting a
  cohort — a green typecheck is not a healthy deploy.

The orchestrated turbo path (`bench/optimal-gate-bench.json`, 80.1s / 4,800 tasks cold) is the
build-and-emit form of the same all-app gate; it is ~60× the fast gate's wall time and the per-wave CI
cost to budget against.

## Rollback and publish order

- **Never delete a published version any lockfile may pin** — deletion breaks every frozen install that
  resolves it. The repo's CodeArtifact role can delete versions (the publishing demos self-clean), which
  makes this a real foot-gun. Keep at least N-1, and both coexisting majors, published.
- **Roll back** by repointing the catalog to the prior version, re-running the frozen gate, and
  redeploying — you cannot un-ship an app already on the new version, so a bad promote is forward-fixed,
  not un-deployed.
- **Publish 400 interdependent libs in topological order** (sinks first). A core-lib advance fans out to
  republishing its dependent libs so the fleet resolves a coherent cross-lib version set.

## What is measured vs what is not

Measured here (`bench/wave-rollout-bench.json`): the frozen byte-identical + fail-closed property; bun's
no-CI-auto-freeze and pnpm-catalog-ignorance (source-verified at `bun-v1.3.14` + measured on 1.3.14);
named-catalog cohort routing and the zero-manifest repoint; the catalog-rejects-`workspace:` error; the
publish rewrite that bakes a concrete range (the universal collapse). Measured elsewhere: the
frozen-vs-not install times (`bench/install-modes-bench.json`), the all-4,000-app breaking-change catch
(`bench/optimal-gate-bench.json`), the catalog-vs-per-pin churn (`bench/lockfile-merge-bench.json`), the
`workspace:`→semver rewrite and registry-vs-local resolution live on CodeArtifact
(`scripts/per-app-workspace-demo.sh`, `scripts/registry-resolution-demo.sh`), the `.d.ts` gap
(`bench/decl-emit-caveat.json`), spec-form neutrality (`bench/perf-matrix.json`).

Not measured (extensions a future bench would add): a multi-wave workflow end to end (advance cohort 1,
then cohort 2, then promote); the per-wave Turborepo cache-miss cost of version skew, which
`FEASIBILITY.md` describes as manifest churn, not a measured hit rate; publishing the full 400-lib fleet
(the live-registry demos publish only their own small fixtures — `@ejc3/util`+`@ejc3/ui` in
`per-app-workspace-demo.sh`, `@ejc3/reslib` in `registry-resolution-demo.sh`); a gate that runs a
published-registry candidate against registry-pinned cohorts rather than the in-tree source.

## Reproduce

```bash
node scripts/wave-rollout-bench.mjs   # the five rungs above -> bench/wave-rollout-bench.json
```

Self-contained: it scaffolds throwaway workspaces under the OS temp dir, pins each to the public npm
registry for one tiny real dependency, and removes them on exit. It hard-fails if any asserted mechanic
stops reproducing; bun's frozen behavior is recorded per run rather than asserted, since that behavior is
the property under measurement.

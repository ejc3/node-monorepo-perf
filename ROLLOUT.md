# Rolling out a new version of an internal core lib

How to advance a shared internal library across a 4,000-app monorepo: gate it against every app
before it merges, move consumers onto it in waves, keep some consumers on a pinned stable version
while others track in-repo HEAD, hold third-party deps frozen while internal deps are driven forward,
and keep every build reproducible. Every package is published to the registry (AWS CodeArtifact).

Every mechanic below is measured in `bench/wave-rollout-bench.json` (`node scripts/wave-rollout-bench.mjs`,
a self-contained repro) as a bun-vs-pnpm head-to-head, or in an existing bench named inline. The bun
behaviors are cross-checked against bun's source at the `bun-v1.3.14` tag.

## The recommendation: drive the rollout with bun

bun runs the entire rollout natively — frozen-lockfile determinism, named-catalog version channels, the
`workspace:` link for co-development, and the concrete-range publish rewrite — and against pnpm it wins
the full re-resolve by ~62–357× and the fresh-CI-runner frozen install outright (0.9s vs pnpm 8.9s,
`bench/container-install-bench.json`). yarn 4, the third driver vetted here, runs every rollout mechanic
natively too — including the CI auto-immutable default bun lacks — and is the faster installer at the top
of the warm-store range. bun keeps the recommendation on the CI-runner frozen install against yarn as
well (0.9s vs yarn-nm 6.5s; yarn-PnP's 4.4s doesn't apply to this stack, since tsgo and `next build` do
not run under PnP — `bench/pnp-compat-bench.json`). The adoption-safety vet covers bun and pnpm only
(`bench/bun-safety-bench.json`); yarn has not been run through it, so it neither gains nor loses there.
Use bun.

**Cold install — the full re-resolve.** With no usable lockfile — authoring it fresh, or after a change
that invalidates it — the install pays the full dependency resolve, and that is where the gap is large
(`bench/install-bench.json`, no lockfile, fresh `node_modules`, warm store):

| workspace | pnpm (isolated) cold | bun cold | bun is |
|---|---|---|---|
| 200 apps / 100 libs | 47.8s | 0.13s | ~357× |
| 1,000 apps / 200 libs | 229.5s | 2.2s | ~103× |
| 2,000 apps / 300 libs | 471.2s | 7.5s | ~62× |

Measured to 2,000 apps; the 4,000-app target is beyond `install-bench.json`'s ceiling, and bun's per-app
cold cost rises with scale, so the ratio at 4,000 is below the 62× floor (extrapolation, not measured). With
the package **store** also cold and still no lockfile — the bench's truly-cold pass — bun stays ahead, but
this path is network-bound and a single sample: bun 1.2s vs pnpm-hoisted 24.0s at 200 apps
(`install-bench.json` `trulyCold`). It downloads every package and its metadata, so the exact multiple varies with the network and
isn't directly comparable to the warm-store cold table above — the like-for-like figures are the warm-store
cold ratios.

**Warm install — everything cached.** When the store and `node_modules` are both warm, the gap narrows.
Through 1,000 apps both are single-digit seconds (at 1,000: bun 2.6s, pnpm-isolated 7.3s, pnpm-hoisted 3.0s).
At 2,000 apps they cross: bun warm 9.5s, pnpm-isolated 15.2s, and **pnpm-hoisted warm 4.7s — ~2×
faster than bun**. On a fully warm runner at the top of the range, pnpm-hoisted wins the bun-vs-pnpm
install comparison; bun's advantage is specifically the cold path.

So drive with bun: when the resolve path is exercised bun is far faster (~62–357× on the full re-resolve,
1.2s vs 24.0s in the single truly-cold sample), and bun does every rollout mechanic natively. Where a
runner stays fully warm with an unchanged lockfile the install gap is small (and pnpm-hoisted can edge bun)
— there the choice rests on the mechanics, not install speed. A rollout exercises both paths: each wave's
catalog repoint re-resolves the changed lockfile entries (an incremental re-resolve with the lockfile
present — smaller than the full-re-resolve table), and every fresh container or new clone re-materializes
`node_modules` from the committed lockfile — the case now measured directly in fresh podman containers
(`bench/container-install-bench.json`, 1,000 apps, frozen install): bun 0.9s vs pnpm 8.9s with empty
caches and real downloads, 0.4s vs 7.0s with a restored dependency cache — bun wins that case outright
(five-way table in [TOOLING.md](TOOLING.md)). (yarn 4, measured in `install-bench.json`'s warm-store dataset, beats pnpm's cold install at
every measured scale and beats bun's at 2,000 apps; its PnP linker is the fastest warm install at
1,000–2,000 apps, while its node-modules linker trails pnpm-hoisted warm —
`bench/install-bench.json`, table in [TOOLING.md](TOOLING.md); its rollout mechanics are vetted
in the "yarn as a driver" subsection below.)

### yarn as a driver, vetted: every mechanic native, plus the CI-frozen default

yarn 4 runs the same five mechanics natively (`bench/yarn-rollout-bench.json`, yarn 4.17.0 on the same
self-contained scaffolds): the committed lockfile resolves byte-identically across fresh installs;
`--immutable` fails closed on a drifted manifest (exit 1, lockfile untouched); and — the one determinism
default bun lacks — **yarn auto-enables immutable installs in CI**: a bare `CI=true yarn install` on drift
fails closed with no configuration at all, where bun needs the committed `bunfig.toml` line (pnpm has the
same auto-frozen CI default). Named catalogs live in `.yarnrc.yml` and route two cohorts to two versions
in one lockfile; a repoint edits 0 consumer manifests. `workspace:` as a catalog value is ACCEPTED and
links the local package — the same HEAD-tracking lane bun offers, and the same foot-gun pnpm's stricter
validation rejects. `yarn pack` bakes concrete ranges for BOTH protocols (`workspace:^` → `^1.2.0` and
`catalog:` → `3.0.1`), so the republish-fanout mechanics are identical. yarn reads neither
`pnpm-workspace.yaml` nor bun's `package.json` catalogs — author them in `.yarnrc.yml`.

What yarn does not have here: the adoption-safety vet below covers bun vs pnpm only, and yarn's PnP
linker — its fastest install mode — does not run this repo's optimal toolchain (tsgo and `next build`
fail under PnP while tsc/turbo/oxlint work, `bench/pnp-compat-bench.json`); under its node-modules
linker no such caveat applies.

pnpm is a complete fallback that does the same mechanics, and it ships two guardrails bun does not default to
(below). One closes on bun with a single committed line (pnpm auto-enables frozen in CI; bun needs the
`bunfig.toml` line). The other is a genuine pnpm safety edge: pnpm rejects a `workspace:` spec as a catalog
value, ruling out a foot-gun both bun and yarn allow — they are more permissive there, not more guarded. Neither blocks the
rollout on bun, and where installs exercise the resolve path the ~62–357× full-re-resolve gap outweighs both; the catalog-validation
strictness is a real, if minor, point for pnpm. A full safety vet (next subsection) finds two further bun
gaps, one more pnpm safety edge (phantom isolation — single-package projects only; workspaces are parity), and otherwise parity. Pick pnpm only if you
specifically want those defaults and will pay the install cost; otherwise the answer is bun.

### Adoption safety, vetted: two real gaps, the rest parity

bun is adoptable, but it is not a strict safety superset of pnpm. A head-to-head vet of a bun install vs a
pnpm install (`bench/bun-safety-bench.json`, bun 1.3.14 vs pnpm 10) finds **two genuine bun gaps**, **one
pnpm safety edge**, and otherwise parity:

- **Lifecycle scripts — bun's built-in allowlist.** A local `file:` dependency's `postinstall` is blocked
  by default on **both** (bun prints "Blocked N postinstall. Run `bun pm untrusted`"; pnpm "Ignored build
  scripts ... Run pnpm approve-builds"). The gap is bun's built-in *trusted allowlist*: a registry dep on
  that list (esbuild) has its `postinstall` run by bun without opt-in, where pnpm 10 blocks all build
  scripts until approved. Bound it by auditing `bun pm untrusted` after install.
- **No fail-closed strict-peer knob.** pnpm `strict-peer-dependencies=true` turns a peer-version mismatch
  into a hard failure (exit 1, `ERR_PNPM_PEER_DEP_ISSUES`); none of bun's three plausible knobs (the
  `npm_config_strict_peer_dependencies` env var, `.npmrc strict-peer-dependencies`, `bunfig.toml [install]
  strictPeerDependencies`) flips its exit. bun *warns* on a mismatch (on stderr) but cannot gate on it.
- **Phantom dependency (pnpm's edge — single-package projects only).** An undeclared transitive import
  resolves under bun's hoisted layout in a single-package project but fails under pnpm's strict isolation,
  which surfaces the missing declaration. In a **workspace** — this repo's subject — bun 1.3 defaults to
  its isolated linker (`node_modules/.bun`) and the same probe fails on both tools
  (`phantomDependency.workspace`): parity there, so the edge applies only to single-package projects.

The rest is parity, which is what makes bun adoptable: a missing peer is auto-installed by both at their
defaults (pnpm's `auto-install-peers` defaults to true, so it is not a bun-only behavior), both warn on a
version mismatch, and bun authenticates to a private CodeArtifact registry through the same scoped `.npmrc`
form the repo's demos use — a `bun publish` + `bun install` round-trip against the real `@ejc3` registry,
host-verified (an absent package returns 404 from the CodeArtifact host, not 401, not a npmjs fall-through).

## The one idea: the lockfile is the determinism boundary, not the range form

"Floating on the registry, where every rebuild resolves something different" is not caused by a `^` or
`*` range. It is caused by **resolving live** — a non-frozen install, or no committed lockfile. With a
committed lockfile and a frozen install, the range is inert: the installer reads the exact pinned version
and never consults the registry.

Measured (`bench/wave-rollout-bench.json`, `determinism`): a `^3.0.0` dependency with a committed
lockfile, installed frozen twice from a wiped `node_modules`, is byte-identical both runs (same resolved
version, same lockfile hash) under pnpm; drift the manifest out of sync with the lockfile and a frozen
install **fails closed** (pnpm `ERR_PNPM_OUTDATED_LOCKFILE`; bun exit 1, lockfile unchanged) rather than
silently re-resolving. So reproducibility is **commit the lockfile + install frozen everywhere** — not pin
every range to an exact version.

This makes "frozen vs not-frozen" the whole answer to driving internal versions:

- **Frozen** runs everywhere a build must reproduce — every CI run, the all-app gate, every deploy. It
  performs no resolution, so third-party never moves and rebuilds are identical.
- **Not-frozen** runs in the deliberate places: authoring an advance (the wave), plus routine dependency
  add/remove. Each is a re-resolve that rewrites the lockfile; **the committed lockfile diff is the
  change.** Third-party stays frozen by *inaction on its versions* — the lockfile freezes third-party and
  internal identically. Advancing an internal lib re-resolves that lib's own subtree, so if its
  third-party deps changed, transitive third-party can move — which is why the wave PR reviews the lockfile
  diff.

The install-time split is measured (`bench/install-modes-bench.json`, 1,000 apps / 200 libs): a
from-scratch resolve with no lockfile is 233s; a frozen install is 7.4s warm-store / 9.2s on a cold CI
runner; a one-dependency change against the committed lockfile is 9.5s; a catalog bump that re-resolves a
shared dep across every importer is 51s. Frozen is the cheap, reproducible default; the expensive resolve
bites only without a usable lockfile.

## The bun-native rollout, end to end

Everything the rollout needs is native to bun. Each step is measured in `bench/wave-rollout-bench.json`.

### 1. Make frozen the default — one committed line

bun does not auto-enable frozen in CI (`frozen_lockfile` is set only by `--frozen-lockfile`, `bun ci`,
`--production`, or bunfig; the one `env.isCI()` check in `bun-v1.3.14` only toggles the progress bar:
`PackageManagerOptions.zig:392`). So commit a `bunfig.toml`:

```toml
[install]
frozenLockfile = true
```

Measured (`determinism.bun`): with that file committed, a bare `bun install` against a drifted lockfile
exits 1 and leaves `bun.lock` unchanged — every call site is frozen by default, no flag to remember. Add
one belt-and-suspenders CI step so a frozen install can never silently re-resolve (`oven-sh/bun#24223`):

```sh
bun install && git diff --exit-code bun.lock
```

That asserts the install changed nothing. Determinism is now a committed property, not a per-command flag.

### 2. Route cohorts with named catalogs — a repoint is one line, zero consumer edits

bun reads catalogs from the root `package.json`. Two named catalogs are two version channels:

```jsonc
// package.json (workspace root)
{
  "workspaces": {
    "packages": ["apps/*", "packages/*"],
    "catalogs": {
      "stable": { "@acme/core": "1.0.0" },
      "next":   { "@acme/core": "3.0.0" }
    }
  }
}
```

A consumer joins a channel by spec, not by version: `"@acme/core": "catalog:stable"`. Measured
(`namedCatalogLanes.bun`, with `is-odd` standing in for `@acme/core`): the `stable` cohort resolves to 1.0.0
and the `next` cohort to 3.0.0 in **one `bun.lock`**; repointing the `stable` entry to 3.0.0 moved that
whole cohort with **0 of 2 consumer manifests edited** (both consumer manifests hashed before and after). A
wave is: move a batch of apps from `catalog:stable` to `catalog:next` (a codemod over those manifests), run
the frozen gate, deploy.
A promote is: point `stable` at the new version — one line. The central-vs-per-manifest cost is also
measured at `bench/lockfile-merge-bench.json`: a catalog bump changes 0 app manifests where a per-app pin
of the same version changes 25.

### 3. Track HEAD with a `workspace:` cohort — and bun lets you catalog it

The team co-developing the lib links it with `workspace:*` / `workspace:^` and gets instant local edits,
no publish. bun goes one further than pnpm here: it **accepts a `workspace:` spec as a catalog value** and
links the local package (measured, `workspaceInCatalog.bun`: a `catalog:` entry of `workspace:*` resolved
to the in-tree copy), so a `workspace:` lib can be a catalog entry too. pnpm rejects this for every form.
Keep the in-tree dev version on a distinct pre-release identifier (e.g. `3.0.0-dev`) so the moving HEAD and a
published `3.0.0` never collide on one number.

### 4. Publishing bakes a concrete range — plan for it

`bun pm pack` rewrites a lib's own internal specs to concrete versions in the tarball. Measured
(`publishBakesConcrete.bun`): a lib's `"@acme/core": "workspace:^"` becomes `"^2.5.0"` and its
`"is-odd": "catalog:"` becomes `"1.0.0"` in the published package. This is what makes a registry-pinned
cohort hermetic — and it is also the constraint on a universal lib (next section).

One cross-tool rule: bun reads catalogs from `package.json`, not `pnpm-workspace.yaml` (measured,
`bunIgnoresPnpmCatalog`: a `catalog:` defined only in `pnpm-workspace.yaml` fails to resolve under
`bun install`). Author the catalog where the driver reads it; do not split it across both files.

## Mixed consumers: two modes, both hermetic, one partition

| mode | spec | pinned by | who |
|---|---|---|---|
| registry-pinned cohort (gets waves) | `catalog:stable` / `catalog:next` / a published semver | the committed lockfile | the fleet; advances only when its cohort's channel moves |
| workspace-linked (tracks HEAD / co-dev) | `workspace:*` / `workspace:^` | the git SHA of the checkout | the team co-developing the lib |

Both are deterministic — one pins against the lockfile, the other against the git tree
(`WORKSPACE-VS-SEMVER.md` §1-2, `scripts/registry-resolution-demo.sh`). They are a **partition**, not
both-for-everyone: the small co-dev set gets instant-local-source edits; the 4,000-app fleet is
publish-then-bump. Giving the whole fleet instant-local propagation means a root override forcing every app
onto the local copy, which forfeits the per-cohort pinning the waves depend on. The repo's `.npmrc`
currently sets `link-workspace-packages=true` + `prefer-workspace-packages=true` (every internal dep
resolves in-tree); the registry-cohort half needs both flipped to `false` so a published semver resolves
from the registry (`WORKSPACE-VS-SEMVER.md` §1).

## Two rules that hold on any tool

These are properties of how packages publish and how a global gate works, not of bun or pnpm.

**1. A *universal* core lib advances by republishing its dependents, not by one catalog line.** A lib that
every app imports directly *and* that every other shared lib re-exports is reached both directly and
transitively. A published lib bakes a **concrete** range for its own internal deps into the tarball (step
4 above: `workspace:^` → `^2.5.0`). So a consumer catalog over `@acme/core` cannot repoint the `lib → core`
edge baked inside every dependent lib's tarball — holding a cohort on the old core means **republishing the
dependent libs**. The "wave = one catalog line" story holds cleanly for a lib consumed **only directly**,
or for a **non-breaking** advance of a universal one. Two coexisting majors of a directly-imported lib is
the diamond behavior (`WORKSPACE-VS-SEMVER.md` §3) — a registry-version story, not a `workspace:` one.

**2. A breaking change is expand → migrate → contract, because the gate is global and synchronous.** A
breaking signature turns every dependent red at once — measured at 4,000/4,000 apps, 4,399 `TS2554`
diagnostics, in 1.39s (`bench/optimal-gate-bench.json`). Under "merge only on green," a hard major is never
green until every app migrates in one atomic PR — a flag day, the opposite of a wave. The protocol that
keeps every wave green:

- **Expand** — ship the new API additively alongside the old (a non-breaking minor; the gate stays green
  for all 4,000).
- **Migrate** — move cohorts onto the new API wave by wave (a codemod over each wave's call sites; each
  wave stays green).
- **Contract** — remove the old API only after every cohort has migrated (the final breaking major).

"Roll out a new version in waves" is *roll out adoption of a new API additively, then contract* — not run
two majors of a universal lib at once.

## Gate the artifact, not just the source

The fast whole-program gate (`bench/optimal-gate-bench.json`, 1.32s) type-checks `@demo/*` mapped to
`packages/*/src` — it validates the in-tree **source**, which is what a `workspace:`-linked consumer
compiles. A registry-pinned cohort consumes the published **tarball** (`dist/index.d.ts`), so the wave gate
must also resolve the lib through the installed published version and run the declaration build:

- The fast gate runs `declaration:false` and misses a `.d.ts` portability error caught by a
  `declaration:true` check (`bench/decl-emit-caveat.json`: tsc `TS2742` / tsgo `TS2883`) and by the
  `tsc --declaration` build. tsgo does not emit declarations, so a `tsc --declaration` build is the only
  thing that proves the artifact is publishable — put it in the pre-merge gate.
- The gate is typecheck-only — no app build, no tests, no runtime. "Run the new lib against all 4,000 apps"
  is, precisely, *typecheck 4,000 apps*; signature/arity breaks surface (the `TS2554` fanout), behavior
  does not. Pair it with a post-deploy health signal (bake window / canary) before promoting a cohort.

The orchestrated turbo path (`bench/optimal-gate-bench.json`, 80.1s / 4,800 tasks cold) is the
build-and-emit form of the same all-app gate; it is ~60× the fast gate's wall time and the per-wave CI cost
to budget against.

## Codemods for the per-manifest parts

The version-control spine stays native — catalogs, the lockfile, frozen installs, the `workspace:`
protocol, the publish rewrite. The parts that are genuinely N manifest edits — assigning apps to a cohort
(switching a consumer's `catalog:stable` to `catalog:next`) and the *migrate* step of
expand/migrate/contract (rewriting call sites from the old API to the new) — are codemod territory
(jscodeshift / ast-grep), driven per wave. This keeps cohort assignment mechanical without bolting a
foreign version mechanism onto the workspace.

## Rollback and publish order

- **Never delete a published version any lockfile may pin** — deletion breaks every frozen install that
  resolves it. The repo's CodeArtifact role can delete versions (the publishing demos self-clean), which
  makes this a real foot-gun. Keep at least N-1, and both coexisting majors, published.
- **Roll back** by repointing the catalog to the prior version, re-running the frozen gate, and
  redeploying — you cannot un-ship an app already on the new version, so a bad promote is forward-fixed, not
  un-deployed.
- **Publish interdependent libs in topological order** (sinks first). A core-lib advance fans out to
  republishing its dependent libs so the fleet resolves a coherent cross-lib version set. Ordering
  presupposes a version bump: a behavior change merged without bumping the changed lib's version leaves
  nothing to publish first, and a dependent's baked range then satisfies against a published version that
  lacks the change — the artifact gate above is what catches that case.

## The pnpm alternative

pnpm does every mechanic above and ships two guardrails on by default that bun makes you configure:

- **pnpm auto-enables frozen in CI;** bun needs the committed `bunfig.toml` line (step 1). One line of
  config versus an inherited default.
- **pnpm rejects a `workspace:` spec as a catalog value** (measured, `workspaceInCatalog.pnpm`:
  `ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC` for `workspace:*`, `workspace:^`, `workspace:~`,
  `workspace:^1.0.0`); bun and yarn both accept it. pnpm's stricter validation rules out one foot-gun
  the other two drivers allow.

Beyond these two rollout defaults, the adoption-safety vet above adds three more points for pnpm
(`bench/bun-safety-bench.json`): two are bun gaps — pnpm default-denies registry build scripts where bun
runs its built-in allowlist, and pnpm has a fail-closed strict-peer mode bun lacks — and one is a
pnpm-unique safety edge: pnpm's isolation surfaces a phantom import bun's hoist hides in single-package
projects (in workspaces bun's isolated default blocks it too). None blocks the rollout on bun; all are
real points for pnpm.

pnpm's named catalogs (in `pnpm-workspace.yaml`) route cohorts and repoint with zero consumer edits
identically (measured, `namedCatalogLanes.pnpm`: `stable`→1.0.0 / `next`→3.0.0 in one lockfile, repoint
moves the cohort with 0 of 2 manifests edited), and `pnpm pack` bakes the same concrete range
(`publishBakesConcrete.pnpm`). The whole rollout is available on pnpm.

The cost is install speed wherever the resolve path is exercised: ~62–357× slower on a full re-resolve
(the table above). On a runner that stays fully warm — store AND `node_modules` cached, lockfile unchanged
— the gap is small and pnpm-hoisted can match or beat bun (`bench/install-bench.json` warm rows); on a
fresh runner the frozen install from the committed lockfile is still ~10–18× bun's (8.9s vs 0.9s empty-cache,
7.0s vs 0.4s cache-restored, `bench/container-install-bench.json`). Where runners stay warm, pnpm's two
defaults (auto-frozen CI, stricter catalog validation) are a real point in its favor; everywhere else the
install gap dominates.
Choose pnpm when your runners stay warm and you want its defaults; otherwise drive with bun and set the
two-line equivalent.

## Reproduce

```bash
node scripts/wave-rollout-bench.mjs   # the bun-vs-pnpm head-to-head -> bench/wave-rollout-bench.json
```

Self-contained: it scaffolds throwaway workspaces under the OS temp dir, pins each to the public npm
registry for one tiny real dependency, and removes them on exit. It hard-fails if any asserted mechanic
stops reproducing.

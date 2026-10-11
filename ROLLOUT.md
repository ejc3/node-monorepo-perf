# Rolling Out a New Version of an Internal Core Lib

Advance a shared internal library across a 4,000-app monorepo: gate it against every app before merge, move consumers
in waves, and hold some on a pinned stable version while others track in-repo HEAD. Every package publishes to AWS
CodeArtifact. The mechanics are measured in `bench/wave-rollout-bench.json` (`node scripts/wave-rollout-bench.mjs`): a
bun-vs-pnpm comparison over five rungs on small self-contained temp scaffolds with one real registry dep, not the
4,000-app tree. The bun behaviors are cross-checked against bun's source at `bun-v1.3.14`.

## The Recommendation

Drive with bun: it runs the entire rollout natively (below). bun's speed edges are the 200-app cold and truly-cold installs and the CI-runner frozen container install. Against pnpm
12.8.1 (the Rust CLI) the full re-resolve on [the workspace under test](README.md#the-workspace-under-test) depends on
scale (`bench/install-bench.json`, no lockfile, fresh `node_modules`, warm store):

| workspace | bun cold | pnpm 12.8.1 cold (isolated / hoisted) | faster |
|---|---|---|---|
| 200 apps / 100 libs | 0.28s | 0.43s / 0.46s | bun ~1.6× |
| 1,000 apps / 200 libs | 2.9s | 2.1s / 0.96s | pnpm-hoisted ~3.1× (pnpm-isolated 1.4×) |
| 2,000 apps / 300 libs | 8.6s | 6.8s / 2.5s | pnpm-hoisted ~3.4× (pnpm-isolated 1.3×) |

Measured to 2,000 apps. bun also wins truly-cold at 200 apps (~1.7×); pnpm-hoisted also wins warm at 1,000–2,000
apps. Per-cell numbers: [TOOLING.md](TOOLING.md#install-bun-vs-pnpm-vs-yarn-4).

Every fresh container or clone re-materializes from the committed lockfile, and on that CI-runner frozen install bun
leads: **bun 0.93s vs pnpm 1.03s on a fresh runner (pnpm +11%); bun 0.42s vs pnpm 0.50s cache-restored (pnpm +19%)**
(`bench/container-install-bench.json`, 1,000 apps, pnpm on its default isolated linker only).

pnpm 12 runs all five rollout mechanics. The rungs below measure parity on catalog lanes, `workspace:` catalog values
(which pnpm 10 rejected), and the publish rewrite, and pnpm enables by default one guardrail bun makes you configure:
auto-frozen in CI. The choice between bun and pnpm 12 rests on the scale you install at and
whose defaults you want, not on a blanket speed gap.

### yarn as a driver

**yarn** runs all five mechanics natively (`bench/yarn-rollout-bench.json`, yarn 4.18.1, the same temp-scaffold
rungs), including the CI auto-immutable default bun lacks. Its fastest mode, PnP, does not run this repo's
stock-tsgo/default-Turbopack path ([TOOLING.md](TOOLING.md#yarn-pnp-toolchain-compatibility)).

### Adoption safety

`bench/bun-safety-bench.json` (bun 1.3.14 vs pnpm 12.8.1, temp scaffolds) finds two bun gaps, one pnpm
edge, and parity elsewhere, including `@ejc3` CodeArtifact auth.

- **Lifecycle scripts (bun gap).** bun's trusted allowlist runs some registry `postinstall` scripts without opt-in;
  pnpm 12 blocks the build and fails the install outright (`ERR_PNPM_IGNORED_BUILDS`).
- **Strict peers (bun gap).** bun has no fail-closed strict-peer knob: none of its three knobs flips its exit. pnpm 12
  exits 1 with `ERR_PNPM_PEER_DEP_ISSUES` on its native config surface (`--config.strict-peer-dependencies=true` /
  `pnpm-workspace.yaml strictPeerDependencies`). It ignores the npm-style `npm_config_strict_peer_dependencies` env
  surface pnpm 10 honored (both surfaces recorded in `peerDependencies.mismatch.pnpmStrict`).
- **Phantom imports (pnpm edge).** An undeclared transitive import resolves under bun in single-package projects;
  workspaces are at parity.

## The Determinism Boundary

Non-reproducibility comes from resolving live (a non-frozen install, or no committed lockfile). With a committed
lockfile and a frozen install, a `^`/`*` range is inert. The `determinism` rung shows this: a `^3.0.0` dep installed
frozen twice from a wiped `node_modules` is byte-identical under pnpm, and after a manifest drift a frozen install fails
closed (pnpm `ERR_PNPM_OUTDATED_LOCKFILE`; bun exit 1). Reproducibility is **commit the lockfile + install frozen
everywhere**, not pin every range. Run non-frozen only where you author an advance (the wave) or add/remove a dep; the
lockfile diff is the change.

Under pnpm 12, freezing buys determinism, not speed: a from-scratch resolve is within 3% of a frozen warm-store install
at 1,000 apps ([FEASIBILITY.md](FEASIBILITY.md#when-each-orepo-cost-is-paid)).

**Lockfile portability under pnpm 12.** pnpm 12's launcher records the `packageManager` pin in `pnpm-lock.yaml` as a
two-document YAML stream: a preamble document carrying `packageManagerDependencies` and the `@pnpm/exe`
platform-binary resolutions, ahead of the dependency lockfile document. With the pin removed, a frozen install exits 1
with `ERR_PNPM_BROKEN_LOCKFILE` (the negative control in `bench/wave-rollout-bench.json`,
`determinism.pnpm.lockfilePortability`). Keep the pin with the lockfile through a rollout.

## The bun-Native Rollout

1. **Frozen by default.** bun does not auto-enable frozen in CI, so commit `bunfig.toml` `[install] frozenLockfile =
   true`, plus a redundant `bun install && git diff --exit-code bun.lock` CI check.
2. **Named catalogs route cohorts.** Two catalogs in the root `package.json` (`stable`, `next`) are two channels; a
   consumer joins by spec (`"@acme/core": "catalog:stable"`). Repointing `stable` moves the cohort with 0 of 2
   manifests edited (`namedCatalogLanes`; a per-app pin edits 25, `bench/lockfile-merge-bench.json`, 200/50). A
   wave codemods a batch onto `catalog:next`, runs the frozen gate, and deploys; a promote is one line.
3. **`workspace:` cohort tracks HEAD.** The co-dev team links `workspace:*`/`workspace:^` for instant local edits. bun
   accepts a `workspace:` spec as a catalog value and links the local package, and so does pnpm 12 for every form
   (pnpm 10 rejected them all with `ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC`; `workspaceInCatalog`).
4. **Publish bakes a concrete range.** `bun pm pack` rewrites `workspace:^`→`^2.5.0` and `catalog:`→`1.0.0`
   (`publishBakesConcrete`). bun reads catalogs from `package.json`, not `pnpm-workspace.yaml`.

Consumers **partition**. The fleet is registry-pinned (`catalog:*`/semver, pinned by the lockfile) and gets waves. The
co-dev team is workspace-linked (`workspace:*`/`workspace:^`, pinned by the git SHA) and tracks HEAD. The registry half
needs `.npmrc` `link-workspace-packages`/`prefer-workspace-packages` set to `false` so a published semver resolves from
the registry ([WORKSPACE-VS-SEMVER.md §1](WORKSPACE-VS-SEMVER.md#1-the-gate-link-workspace-packages),
[§2](WORKSPACE-VS-SEMVER.md#2-workspacerange)).

## Two Rules That Hold on Any Tool

1. **A foundation lib advances by republishing its dependents, not by one catalog line.** A published lib bakes a
   concrete range for its internal deps, and a consumer catalog cannot repoint the `lib→foundation` edge baked into every
   dependent's tarball. "Wave = one catalog line" holds only for a directly consumed lib or a non-breaking advance
   ([WORKSPACE-VS-SEMVER.md §3](WORKSPACE-VS-SEMVER.md#3-diamond-resolution-under-semver)).
2. **A breaking change is expand → migrate → contract, because the gate is global and synchronous.** A breaking
   signature turns every dependent red at once (4,399 `TS2554` diagnostics in 1.55s at 4,000/400 `--universal 1`,
   `bench/optimal-gate-bench.json`). Ship the new API additively (expand), move cohorts wave by wave with a codemod
   (migrate), and remove the old API last (contract).

## Gating the Artifact

The whole-program gate (`bench/optimal-gate-bench.json`, 1.59s for a non-breaking revision on the same 4,000/400 tree) checks
`@demo/*`→`packages/*/src` source, which is what a `workspace:`-linked consumer compiles. A registry-pinned cohort
consumes the published tarball, so the wave gate must also resolve that published version and run the declaration
build. The whole-program gate has two limits:

- It runs `declaration:false` and misses a `.d.ts` portability error that a `declaration:true` check catches
  (`bench/decl-emit-caveat.json`: `TS2883` under both checkers), so add a `tsc --declaration` build. The boundary is
  `declaration` off vs on, not the checker. The caveat bench records the `declaration:true` check, not native declaration-emit output.
- It is typecheck-only: signature and arity breaks surface (`TS2554` fanout), behavior changes do not. Pair it with a
  post-deploy canary.

The per-package turbo path (46.9s / 4,800 tasks cold) is the build-and-emit form, ~30× the whole-program gate, and is the
per-wave CI cost.

## Codemods, Rollback, Publish Order

Two steps are N manifest edits, cohort assignment and the *migrate* step; both are codemod work (jscodeshift /
ast-grep). **Never delete a published version any lockfile may pin**: it breaks every frozen install. Keep N-1 and both
coexisting majors. **Roll back** by repointing the catalog, re-running the gate, and redeploying; a bad promote is
forward-fixed. **Publish interdependent libs sinks-first,** which presupposes a version bump (without one, a
dependent's baked range is satisfied by a version that lacks the change).

## Reproduce

```bash
node scripts/wave-rollout-bench.mjs   # bun-vs-pnpm -> bench/wave-rollout-bench.json
```

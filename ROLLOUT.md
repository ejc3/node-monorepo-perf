# Rolling Out a New Version of an Internal Core Lib

Advance a shared internal library across a 4,000-app monorepo: gate it against every app before merge, move consumers
in waves, hold some on a pinned stable version while others track in-repo HEAD. Every package publishes to AWS
CodeArtifact. Every mechanic is measured in `bench/wave-rollout-bench.json` (`node scripts/wave-rollout-bench.mjs`,
bun-vs-pnpm), bun behaviors cross-checked against source at `bun-v1.3.14`.

## The Recommendation

Drive with bun: it runs the entire rollout natively (below) and beats pnpm's full re-resolve by ~62–357×
(`bench/install-bench.json`, no lockfile, fresh `node_modules`, warm store):

| workspace | pnpm (isolated) cold | bun cold | bun is |
|---|---|---|---|
| 200 apps / 100 libs | 47.8s | 0.13s | ~357× |
| 1,000 apps / 200 libs | 229.5s | 2.2s | ~103× |
| 2,000 apps / 300 libs | 471.2s | 7.5s | ~62× |

Measured to 2,000 apps; 4,000 is below the 62× floor (extrapolation). Warm (store + `node_modules`), the gap narrows
and pnpm-hoisted can edge bun ([TOOLING.md](TOOLING.md#install-bun-vs-pnpm-vs-yarn-4)); bun's edge is the cold/resolve
path. Every fresh container or clone re-materializes from the committed lockfile — the CI-runner frozen install
(`bench/container-install-bench.json`, 1,000 apps): **bun 0.9s vs pnpm 8.9s empty-cache (~10×)**, **bun 0.4s vs pnpm
7.0s cache-restored (~18×)**.

### yarn as a driver

**yarn** runs all five mechanics natively (`bench/yarn-rollout-bench.json`, yarn 4.17.0), including the CI
auto-immutable default bun lacks, but its fastest mode (PnP) doesn't run this repo's toolchain. **pnpm** does every
mechanic and defaults on two guardrails bun makes you configure (auto-frozen in CI; rejecting a `workspace:` spec as a
catalog value) — pick it only if you want those and will pay the install cost.

### Adoption safety

**Adoption safety** (`bench/bun-safety-bench.json`, bun 1.3.14 vs pnpm 10): two bun gaps (a trusted allowlist runs
some registry `postinstall` scripts without opt-in; no fail-closed strict-peer knob), one pnpm edge (phantom import
resolves under bun in single-package projects, parity in workspaces), otherwise parity including `@ejc3` CodeArtifact
auth.

## The Determinism Boundary

Non-reproducibility comes from resolving live (non-frozen, or no committed lockfile); with a committed lockfile and
frozen install a `^`/`*` range is inert. Measured (`determinism`): a `^3.0.0` dep installed frozen twice from a wiped
`node_modules` is byte-identical under pnpm; drift the manifest and a frozen install fails closed (pnpm
`ERR_PNPM_OUTDATED_LOCKFILE`; bun exit 1). So reproducibility is **commit the lockfile + install frozen everywhere**,
not pin every range; not-frozen runs only where you author an advance (the wave) or add/remove a dep, and the lockfile
diff is the change. Install-time (`bench/install-modes-bench.json`, 1,000/200): from-scratch resolve 233s vs frozen
7.4s warm / 9.2s cold.

## The bun-Native Rollout

1. **Frozen by default.** bun doesn't auto-enable frozen in CI, so commit `bunfig.toml` `[install] frozenLockfile =
   true`, plus a redundant `bun install && git diff --exit-code bun.lock` CI check.
2. **Named catalogs route cohorts.** Two catalogs in the root `package.json` (`stable`, `next`) are two channels; a
   consumer joins by spec (`"@acme/core": "catalog:stable"`). Repointing `stable` moves the cohort with 0 of 2
   manifests edited (`namedCatalogLanes`; a per-app pin edits 25, `bench/lockfile-merge-bench.json`). A wave codemods a
   batch onto `catalog:next`, runs the frozen gate, deploys; a promote is one line.
3. **`workspace:` cohort tracks HEAD.** The co-dev team links `workspace:*`/`workspace:^` for instant local edits. bun
   accepts a `workspace:` spec as a catalog value (`workspaceInCatalog`); pnpm rejects every form.
4. **Publish bakes a concrete range.** `bun pm pack` rewrites `workspace:^`→`^2.5.0` and `catalog:`→`1.0.0`
   (`publishBakesConcrete`). bun reads catalogs from `package.json`, not `pnpm-workspace.yaml`.

Consumers **partition**: the fleet is registry-pinned (`catalog:*`/semver, pinned by the lockfile, gets waves), the
co-dev team is workspace-linked (`workspace:*`/`workspace:^`, pinned by the git SHA, tracks HEAD). The registry half
needs `.npmrc` `link-workspace-packages`/`prefer-workspace-packages` set `false` so a published semver resolves from
the registry ([WORKSPACE-VS-SEMVER.md §1](WORKSPACE-VS-SEMVER.md#1-the-gate-link-workspace-packages),
[§2](WORKSPACE-VS-SEMVER.md#2-workspacerange)).

## Two Rules That Hold on Any Tool

1. **A universal core lib advances by republishing its dependents, not one catalog line,** because a published lib
   bakes a concrete range for its internal deps and a consumer catalog can't repoint the `lib→core` edge baked into
   every dependent's tarball. "Wave = one catalog line" holds only for a directly-consumed lib or a non-breaking
   advance ([WORKSPACE-VS-SEMVER.md §3](WORKSPACE-VS-SEMVER.md#3-diamond-resolution-under-semver)).
2. **A breaking change is expand → migrate → contract, because the gate is global and synchronous.** A breaking
   signature turns every dependent red at once (4,399 `TS2554` diagnostics in 1.39s, `bench/optimal-gate-bench.json`):
   ship the new API additively (expand), move cohorts wave by wave (migrate, codemod), remove the old API last (contract).

## Gating the Artifact

The fast whole-program gate (`bench/optimal-gate-bench.json`, 1.32s) checks `@demo/*`→`packages/*/src` source, what a
`workspace:`-linked consumer compiles; a registry-pinned cohort consumes the published tarball, so the wave gate must
also resolve that published version and run the declaration build. Two caveats: the fast gate runs `declaration:false`
and misses a `.d.ts` portability error a `declaration:true` check catches (`bench/decl-emit-caveat.json`: tsc `TS2742`
/ tsgo `TS2883`), so add a `tsc --declaration` build (tsgo can't emit declarations); and it's typecheck-only, so
signature/arity breaks surface (`TS2554` fanout) but behavior doesn't — pair a post-deploy canary. The orchestrated
turbo path (80.1s / 4,800 tasks cold) is the build-and-emit form, ~60× the fast gate — the per-wave CI cost.

## Codemods, Rollback, Publish Order

Two parts are genuinely N manifest edits — cohort assignment and the *migrate* step — both codemod territory
(jscodeshift / ast-grep). **Never delete a published version any lockfile may pin** (breaks every frozen install; keep
N-1 and both coexisting majors). **Roll back** by repointing the catalog, re-running the gate, redeploying — a bad
promote is forward-fixed. **Publish interdependent libs sinks-first,** presupposing a version bump (else a dependent's
baked range satisfies against a version lacking the change).

## Reproduce

```bash
node scripts/wave-rollout-bench.mjs   # bun-vs-pnpm -> bench/wave-rollout-bench.json
```

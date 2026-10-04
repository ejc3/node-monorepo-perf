# Rolling Out a New Version of an Internal Core Lib

Advance a shared internal library across a 4,000-app monorepo: gate it against every app before merge, move consumers
in waves, hold some on a pinned stable version while others track in-repo HEAD. Every package publishes to AWS
CodeArtifact. Every mechanic is measured in `bench/wave-rollout-bench.json` (`node scripts/wave-rollout-bench.mjs`,
bun-vs-pnpm, five rungs on small self-contained temp scaffolds with one real registry dep, not the 4,000-app tree),
bun behaviors cross-checked against source at `bun-v1.3.14`.

## The Recommendation

Drive with bun: it runs the entire rollout natively (below), with its catalogs in `package.json`. The measured
mechanics are parity with pnpm 12, and bun's speed edges are the 200-app cold and truly-cold installs and the
CI-runner frozen container install. Against pnpm 12.8.1 (the Rust CLI) the full re-resolve on
[the workspace under test](README.md#the-workspace-under-test) is scale-dependent (`bench/install-bench.json`, no
lockfile, fresh `node_modules`, warm store):

| workspace | bun cold | pnpm 12.8.1 cold (isolated / hoisted) | faster |
|---|---|---|---|
| 200 apps / 100 libs | 0.28s | 0.43s / 0.46s | bun ~1.6× |
| 1,000 apps / 200 libs | 2.9s | 2.1s / 0.96s | pnpm-hoisted ~3.1× (pnpm-isolated 1.4×) |
| 2,000 apps / 300 libs | 8.6s | 6.8s / 2.5s | pnpm-hoisted ~3.4× (pnpm-isolated 1.3×) |

Measured to 2,000 apps. bun also wins truly-cold at 200 apps (1.3s vs pnpm-hoisted 2.2s, fresh store + network,
~1.7×); pnpm-hoisted wins warm at 1,000–2,000 (0.59s/1.1s vs bun's 2.8s/8.8s), and at 200 the warm relink is about 8%
apart across bun and both pnpm linkers (0.25–0.27s, pnpm-isolated fastest). pnpm 12's Rust CLI removed pnpm 10's
cold-resolve wall (307.4s → 0.93s at 1,000:200, `bench/pnpm12-bench.json`). Every fresh container or clone
re-materializes from the committed lockfile,
and on the CI-runner frozen install bun leads pnpm by 11% empty-cache and 19% cache-restored
(`bench/container-install-bench.json`, 1,000 apps): **bun 0.93s
vs pnpm 1.03s empty-cache; bun 0.42s vs pnpm 0.50s cache-restored** (fresh-runner yarn-PnP 4.5s, yarn-nm 6.5s, npm
10.4s; cache-restored 2.2s / 4.2s / 9.7s). pnpm
12 is a fully capable driver — the rungs below measure parity on catalog lanes, `workspace:` catalog values, and the
publish rewrite, with pnpm auto-freezing in CI where bun needs a committed bunfig — so the choice between bun and
pnpm 12 rests on the scale you install at and whose defaults you want, not on a blanket speed gap.

### yarn as a driver

**yarn** runs all five mechanics natively (`bench/yarn-rollout-bench.json`, yarn 4.18.1, the same temp-scaffold
rungs), including the CI
auto-immutable default bun lacks, but its fastest mode (PnP) doesn't run this repo's stock-tsgo/default-Turbopack
path (native-PnP tsgo is measured green; `next build` under PnP builds via webpack/rspack on node
22.22.0 and fails on every builder on node 22.23.3,
[TOOLING.md](TOOLING.md#yarn-pnp-toolchain-compatibility)). **pnpm 12** does every
mechanic and defaults on one guardrail bun makes you configure: auto-frozen in CI. (pnpm 10's second guardrail —
rejecting a `workspace:` spec as a catalog value — is gone: pnpm 12 accepts every form and links the local package,
parity with bun, `workspaceInCatalog`.) Its install cost is no longer the argument against it — the table above has
pnpm-hoisted ahead of bun at the measured 1,000- and 2,000-app points.

### Adoption safety

**Adoption safety** (`bench/bun-safety-bench.json`, bun 1.3.14 vs pnpm 12.8.1, temp scaffolds): two bun gaps (a
trusted allowlist runs some registry `postinstall` scripts without opt-in, where pnpm 12 blocks the build and fails
the install outright — `ERR_PNPM_IGNORED_BUILDS`; no fail-closed strict-peer knob — pnpm 12 exits 1 with
`ERR_PNPM_PEER_DEP_ISSUES` on its native config surface, `--config.strict-peer-dependencies=true` /
`pnpm-workspace.yaml strictPeerDependencies`, while none of bun's three knobs flips its exit), one pnpm edge
(phantom import resolves under bun in single-package projects, parity in workspaces), otherwise parity including
`@ejc3` CodeArtifact auth. One config-surface caveat rides the strict-peer knob: pnpm 12 ignores the npm-style
`npm_config_strict_peer_dependencies` env surface pnpm 10 honored (measured on both surfaces, recorded in
`peerDependencies.mismatch.pnpmStrict`).

## The Determinism Boundary

Non-reproducibility comes from resolving live (non-frozen, or no committed lockfile); with a committed lockfile and
frozen install a `^`/`*` range is inert. The `determinism` rung measures this. A `^3.0.0` dep installed frozen twice
from a wiped `node_modules` is byte-identical under pnpm; drift the manifest and a frozen install fails closed (pnpm
`ERR_PNPM_OUTDATED_LOCKFILE`; bun exit 1). So reproducibility is **commit the lockfile + install frozen everywhere**,
not pin every range. Not-frozen runs only where you author an advance (the wave) or add/remove a dep, and the lockfile
diff is the change. Under pnpm 12 the frozen discipline is for determinism, not speed: the from-scratch resolve costs
within 3% of a frozen warm-store install (2.9s resolve vs 2.8s frozen-warm; frozen-cold-store 2.8s;
`bench/install-modes-bench.json`, 1,000/200, pnpm 12.8.1 — the JS CLI paid 307.4s on a 1,000:200 cold resolve,
`bench/pnpm12-bench.json`).

One pnpm-12 lockfile-portability caveat, measured as a negative control: pnpm 12's launcher records the
`packageManager` pin in `pnpm-lock.yaml` as a two-document YAML stream (a preamble document carrying
`packageManagerDependencies` plus the `@pnpm/exe` platform-binary resolutions ahead of the dependency lockfile
document), and with the pin removed a frozen install exits 1 with `ERR_PNPM_BROKEN_LOCKFILE` — keep the pin with the
lockfile through a rollout (`bench/wave-rollout-bench.json`, `determinism.pnpm.lockfilePortability`).

## The bun-Native Rollout

1. **Frozen by default.** bun doesn't auto-enable frozen in CI, so commit `bunfig.toml` `[install] frozenLockfile =
   true`, plus a redundant `bun install && git diff --exit-code bun.lock` CI check.
2. **Named catalogs route cohorts.** Two catalogs in the root `package.json` (`stable`, `next`) are two channels; a
   consumer joins by spec (`"@acme/core": "catalog:stable"`). Repointing `stable` moves the cohort with 0 of 2
   manifests edited (`namedCatalogLanes`; a per-app pin edits 25, `bench/lockfile-merge-bench.json`, 200/50). A wave codemods a
   batch onto `catalog:next`, runs the frozen gate, deploys; a promote is one line.
3. **`workspace:` cohort tracks HEAD.** The co-dev team links `workspace:*`/`workspace:^` for instant local edits. bun
   accepts a `workspace:` spec as a catalog value and links the local package — and so does pnpm 12, every form
   (pnpm 10 rejected them all with `ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC`; `workspaceInCatalog`).
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
   signature turns every dependent red at once (4,399 `TS2554` diagnostics in 1.55s at 4,000/400 `--universal 1`,
   `bench/optimal-gate-bench.json`):
   ship the new API additively (expand), move cohorts wave by wave (migrate, codemod), remove the old API last (contract).

## Gating the Artifact

The fast whole-program gate (`bench/optimal-gate-bench.json`, 1.59s, same 4,000/400 tree) checks
`@demo/*`→`packages/*/src` source, what a
`workspace:`-linked consumer compiles. A registry-pinned cohort consumes the published tarball, so the wave gate must
also resolve that published version and run the declaration build. Two caveats apply. The fast gate runs
`declaration:false` and misses a `.d.ts` portability error a `declaration:true` check catches
(`bench/decl-emit-caveat.json`: `TS2883` under both checkers), so add a `tsc --declaration` build. The boundary is
`declaration` off vs on, not the checker: typescript@7's native tsc is the shipping compiler, declaration emit
included, and this repo has measured the `declaration:true` check, not native declaration-emit output. And it's
typecheck-only, so signature/arity breaks surface (`TS2554` fanout) but behavior doesn't — pair a post-deploy canary. The orchestrated turbo path (46.9s / 4,800 tasks cold) is the build-and-emit form, ~30× the
fast gate — the per-wave CI cost.

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

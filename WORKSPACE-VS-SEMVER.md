# Semver vs `workspace:`: Internal Deps, Overrides, and Diamonds

Internal packages are independently versioned and normally consumed by plain semver from a registry (AWS CodeArtifact). To develop one locally and have its consumers pick it up, flip that lib to `workspace:` transiently. The proofs run on small throwaway scaffolds published to CodeArtifact (§§3–4 the diamond, §7 the per-app workspaces), not on [the workspace under test](README.md#the-workspace-under-test). Reproduce: `bash scripts/diamond-demo.sh`.

## 1. The Gate: `link-workspace-packages`

Being in a workspace does not force the `workspace:` protocol. App `foo` can declare `"b": "^1.2.0"` for a same-workspace `b`; the gate decides what that plain range resolves to:

| `link-workspace-packages` | `"b": "^1.2.0"` resolves to |
|---|---|
| `false` (pnpm 8+ default) | the registry, even if a matching local `b` exists |
| `true` | the local `b` if its version satisfies `^1.2.0`, else the registry |

Only `workspace:` forces local linking unconditionally. The two halves of this repo sit on opposite sides of the gate. The benchmark workspace's root `.npmrc` sets `link-workspace-packages=true` + `prefer-workspace-packages=true`, so its packages always link local. The independently-published model this doc describes runs with the gate closed: the demo scaffolds (§§3–7) either write `link-workspace-packages=false` in their own `.npmrc` or keep pnpm's `false` default in their standalone roots. That is the setting ROLLOUT.md requires for a registry-pinned cohort.

## 2. `workspace:<range>`

`"@demo/lib-09": "workspace:^1.4.9"` has two halves. `workspace:` is the resolution source: local only, never the registry. `^1.4.9` is the version contract: an install-time check (a bare `*`/`~`/`^` always satisfies; an explicit range can fail and surface drift) and the publish template.

`pnpm pack` on a `--versioned` lib of the workspace under test rewrites source to tarball:

```
"@demo/lib-09": "workspace:^1.4.9"  ->  "@demo/lib-09": "^1.4.9"
"typescript":  "catalog:"           ->  "typescript":  "^5.9.0"
```

| You write | Dev | Published (dep at 1.4.9) |
|---|---|---|
| `workspace:*` | link local | `1.4.9` (exact) |
| `workspace:~` | link local | `~1.4.9` |
| `workspace:^` | link local | `^1.4.9` |
| `workspace:^1.4.9` | link local if satisfied | `^1.4.9` |

At publish, pnpm reads the target's `"version"` and writes the combined range into the tarball copy only; the on-disk file is untouched. An explicit `workspace:^1.4.9` has only `workspace:` stripped. All forms link local at install and produce the same lockfile line count and `node_modules` entry count. Their cold installs are 0.62s (`workspace:*`) and 0.56s (`workspace:^x.y.z`), one sample each, against a ~1.7× move from the `node-linker` (`bench/perf-matrix.json`). The spec form sets the published string.

## 3. Diamond Resolution Under Semver

```
@ejc3/widget@1.0.0  render()      @ejc3/alpha@1.0.0 -> widget ^1.0.0, uses render()
@ejc3/widget@2.0.0  renderBox()   @ejc3/beta@1.0.0  -> widget ^2.0.0, uses renderBox()
consumer -> alpha (widget ^1), beta (widget ^2)
```

Under the isolated linker two majors do not conflict: pnpm installs both (`@ejc3+widget@1.0.0` and `@ejc3+widget@2.0.0` in `.pnpm`) and wires each dependent to the API it was built for.

## 4. Overriding One Lib to `workspace:`

Root `pnpm.overrides` ignore declared ranges and apply workspace-wide, to direct and transitive edges:

```jsonc
{ "pnpm": { "overrides": { "@ejc3/widget": "workspace:*" } } }
```

A local `@ejc3/widget@2.0.0` forces both `alpha` and `beta` onto it, collapsing the diamond. `alpha`, built against v1's `render()`, then breaks: `SyntaxError: ... does not provide an export named 'render'`. A local v1 breaks `beta` instead. To revert, remove the override, delete `node_modules` and the lockfile, and reinstall.

## 5. Switching One App Without Changing the Others

Two apps depend on `@ejc3/alpha`, and `alpha` depends on `@ejc3/widget`. The goal: `web` links the local `widget` while `admin` keeps the registry copy. Difficulty depends on direct vs transitive.

**Direct dependency.** If `web` lists `widget` directly, there is nothing to coordinate. With `link-workspace-packages=false` only `workspace:` forces linking, so flipping `web`'s own spec to `workspace:*` switches that one app, and `admin` stays on registry semver (one lockfile, one app changed).

**Transitive dependency.** `web` never names `widget`, so its manifest has nothing to flip. Every mechanism that reaches a transitive edge is root-level and resolves into one shared lockfile:

- **Root `pnpm.overrides`** forces *every* consumer (the §4 collapse), not one app.
- An **edge-scoped override** (`"@ejc3/alpha>@ejc3/widget": "workspace:*"`) narrows to one edge but still hits every app whose graph has `alpha → widget`.
- A **`.pnpmfile.cjs` `readPackage` hook** rewrites the spec during resolution but runs for the whole install into one lockfile, so it cannot give `web` and `admin` different resolutions.
- **Per-app isolation** is the only way: resolve `web` outside the shared graph (its own workspace root and lockfile, or `pnpm install --ignore-workspace` with a `link:`/`file:` dep), and `admin` keeps the registry version.

A workspace is one graph, one lockfile, one root resolution; there is no "apply this override only when reached from `web`" scope. Tasks scope per app with `turbo run build --filter=<app>...` ([OPTIMIZATIONS.md §2](OPTIMIZATIONS.md#2-task-time-turborepo)); resolution does not.

## 6. Next.js

To import a lib's TypeScript source (not `dist`), set `transpilePackages: ['@ejc3/widget']` in `next.config.mjs`. The libs here ship built `dist`, so they do not need it.

## 7. Per-App Workspaces

§5's recommendation, live on CodeArtifact: one repo with no app-spanning workspace, each app its own pnpm workspace (`scripts/per-app-workspace-demo.sh` builds it). Apps commit plain semver and resolve from the registry; publishable libs commit `workspace:^`; `workspace:*` is for transient co-dev only. A libs-only workspace (`packages: ["libs/*"]`) builds and publishes the lib DAG, and each app's own `pnpm-workspace.yaml` shadows it on install. Both apps pin `@ejc3/ui` at the same version; `@ejc3/util` is `ui`'s transitive dep, named by neither app. The apps differ only in `web`'s root override.

**Proof 1: pnpm rewrites `workspace:^` on pack.** `pnpm pack` on `@ejc3/ui`:

```
source spec:  "@ejc3/util": "workspace:^"
packed:       {"@ejc3/util":"^1.0.0"}
```

`npm publish` does not rewrite, so a lib with internal `workspace:`/`catalog:` deps must publish with pnpm.

**Proof 2: the same transitive lib resolves differently per app.**

```
web    require("@ejc3/ui") = {"SOURCE":"registry@1.0.0","util":"workspace-local"}
admin  require("@ejc3/ui") = {"SOURCE":"registry@1.0.0","util":"registry@1.0.0"}
```

The same registry `@ejc3/ui` gets a local `@ejc3/util` in `web` and a registry one in `admin`, because `web`'s root carries `pnpm.overrides { "@ejc3/util": "workspace:*" }` and `admin`'s does not. The apps hold separate lockfiles. Separate roots can scope this; a shared root cannot.

This buys per-app divergence on a transitive dep and per-app install and lockfile scope. Against the single root it loses the shared catalog (replaced by per-app pins), the fleet `turbo` graph and cross-app `--affected`, instant lib-edit feedback (replaced by publish-then-bump), and the atomic lib+consumers refactor. [FEASIBILITY.md](FEASIBILITY.md) has the cost model and decision criteria.

## 8. When Two Copies Exist (and When They Converge)

Whether a package is installed once or twice follows two rules, applied per package.

**Rule 1: a `workspace:` edge and a registry edge don't merge.** A `workspace:` edge resolves to the
local symlink; a plain semver edge in a registry-installed package's *transitive* graph resolves from
the registry. If one package is reached through one of each (the app links `workspace:*` core while a
registry-installed ui's baked `^2.5.0` pulls a registry core), there are **two copies**, even when the
version numbers match: pnpm does not compare a workspace copy's committed version against a registry
edge's range to unify them. This holds at `link-workspace-packages=false` (the default) and at `true`,
which local-links only a workspace project's own *direct* plain edges (§1); the one setting that
reaches transitive edges is `link-workspace-packages=deep`. One copy therefore means picking a side
for that package: all-workspace (every consumer on `workspace:`, or a root override forcing the
transitive edges there, §4) or all-registry (your own edge becomes a plain range, and Rule 2 decides).

**Rule 2: on a fresh resolve, registry edges converge when their ranges pick the same version.** When
pnpm resolves (no lockfile entry yet), each edge independently takes the highest version satisfying
*its* range. Same-major carets (`^2.5.0` + `^2.6.0`) pick the same newest 2.x, so they share one copy;
that is how a pinned old consumer picks up a compatible release at its next re-resolve. Disjoint
ranges (`^2` vs `^3`) always split: the diamond of §3, safe under the isolated linker, with each
dependent wired to the API it was built against. Overlapping ranges of different shapes (`^2.5.0` +
`~2.5.0`) can also split, because each edge takes its own maximum instead of searching for a shared
solution.

This rule has two limits. An existing lockfile **keeps prior choices**: split edges stay split, and
nothing moves forward until something re-resolves (`pnpm update`, an install after a manifest change,
or `pnpm dedupe`, which re-resolves toward fewer copies within declared ranges). And peer-dependency
contexts can instantiate even a single chosen version more than once
([`dedupe-peer-dependents`](https://pnpm.io/settings#dedupepeerdependents)).

A split costs duplicate bytes plus the hazards of crossing instances (`instanceof` across copies,
doubled singletons, two React contexts). To collapse one durably, the lagging consumer republishes
against the newer range. To collapse one immediately, use a root override (§4); it ignores declared
ranges entirely, so it is exactly as safe as the compatibility claim behind it.

## Reproduce
```bash
bash scripts/diamond-demo.sh            # publish, diamond, collapse (both halves asserted)
bash scripts/per-app-workspace-demo.sh  # per-app workspaces: transitive divergence + publish rewrite
pnpm gen --versioned                    # workspace with semver + workspace:^x.y.z
```

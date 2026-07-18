# Semver vs `workspace:`: Internal Deps, Overrides, and Diamonds

Internal packages are independently versioned, normally consumed by plain semver from a registry (AWS CodeArtifact). To develop one locally and have everything pick it up, flip that lib to `workspace:` transiently. Reproduce: `bash scripts/diamond-demo.sh`. The proofs here run on small throwaway scaffolds published to CodeArtifact (§§3–4 the diamond, §7 the per-app workspaces), not on [the workspace under test](README.md#the-workspace-under-test).

## 1. The Gate: `link-workspace-packages`

Being in a workspace does not force the `workspace:` protocol. App `foo` can declare `"b": "^1.2.0"` for a same-workspace `b`. What that plain range means:

| `link-workspace-packages` | `"b": "^1.2.0"` resolves to |
|---|---|
| `false` (pnpm 8+ default) | the registry, even if a matching local `b` exists |
| `true` | the local `b` if its version satisfies `^1.2.0`, else the registry |

The two halves of this repo sit on opposite sides of the gate: the benchmark workspace's root `.npmrc` sets `link-workspace-packages=true` + `prefer-workspace-packages=true` (its packages always link local), while the independently-published model this doc describes runs with the gate closed — the demo scaffolds (§§3–7) either write `link-workspace-packages=false` in their own `.npmrc` or sit on pnpm's `false` default in their standalone roots, the setting ROLLOUT.md requires for a registry-pinned cohort. Only `workspace:` forces local linking unconditionally.

## 2. `workspace:<range>`

`"@demo/lib-09": "workspace:^1.4.9"` has two halves: `workspace:` is the resolution source (local only, never registry); `^1.4.9` is the version contract — an install-time check (bare `*`/`~`/`^` always satisfies; an explicit range can fail and surface drift) and the publish template.

`pnpm pack` on a `--versioned` lib of the workspace under test rewrites source → tarball:

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

At publish, pnpm reads the target's `"version"` and writes the combined range into the tarball copy only (on-disk file untouched). An explicit `workspace:^1.4.9` just has `workspace:` stripped. All forms link local at install, so spec form does not affect install time — only the published string. Install perf is driven by resolution source and `node-linker` (`scripts/perf-matrix.mjs`).

## 3. Diamond Resolution Under Semver

```
@ejc3/widget@1.0.0  render()      @ejc3/alpha@1.0.0 -> widget ^1.0.0, uses render()
@ejc3/widget@2.0.0  renderBox()   @ejc3/beta@1.0.0  -> widget ^2.0.0, uses renderBox()
consumer -> alpha (widget ^1), beta (widget ^2)
```

Under the isolated linker two majors are not a conflict: pnpm installs both (`@ejc3+widget@1.0.0` and `@ejc3+widget@2.0.0` in `.pnpm`), each dependent against the API it was built for.

## 4. Overriding One Lib to `workspace:`

Root `pnpm.overrides` ignore declared ranges and apply workspace-wide, catching direct and transitive edges:

```jsonc
{ "pnpm": { "overrides": { "@ejc3/widget": "workspace:*" } } }
```

A local `@ejc3/widget@2.0.0` forces both `alpha` and `beta` onto it, collapsing the diamond. `alpha` (built against v1's `render()`) then breaks: `SyntaxError: ... does not provide an export named 'render'`. A local v1 breaks `beta` instead. Revert: remove override, delete `node_modules` + lockfile, reinstall.

## 5. Switching One App Without Changing the Others

Two apps depend on `@ejc3/alpha`; `alpha` depends on `@ejc3/widget`. Goal: `web` links the local `widget`, `admin` keeps the registry copy. Difficulty depends on direct vs transitive.

**Direct dependency.** If `web` lists `widget` directly, nothing to coordinate — with `link-workspace-packages=false` only `workspace:` forces linking, so flipping `web`'s own spec to `workspace:*` switches that one app; `admin` stays on registry semver (one lockfile, one app changed).

**Transitive dependency.** `web` never names `widget`, so there is nothing in its manifest to flip. Every transitive-reaching mechanism is root-level, resolving into one shared lockfile:

- **Root `pnpm.overrides`** — force *every* consumer (§4 collapse), not per-app.
- **Edge-scoped override** `"@ejc3/alpha>@ejc3/widget": "workspace:*"` — narrows to one edge but still hits every app whose graph has `alpha → widget`.
- **`.pnpmfile.cjs` `readPackage` hook** — rewrites the spec during resolution, but runs for the whole install into one lockfile; cannot give `web` and `admin` different resolutions at once.
- **Per-app isolation** — the only way: resolve `web` outside the shared graph (its own workspace root + lockfile, or `pnpm install --ignore-workspace` with a `link:`/`file:` dep). `admin` keeps the registry version.

A workspace is one graph → one lockfile → one root resolution; there is no "apply this override only when reached from `web`" scope. Tasks scope per-app with `turbo run build --filter=<app>...` ([OPTIMIZATIONS.md §2](OPTIMIZATIONS.md#2-task-time-turborepo)); resolution does not.

## 6. Next.js

To import a lib's TypeScript source (not `dist`), set `transpilePackages: ['@ejc3/widget']` in `next.config.mjs`. Here libs ship built `dist`, so it is not needed.

## 7. Per-App Workspaces

§5's recommendation, live on CodeArtifact: one repo, no app-spanning workspace, each app its own pnpm workspace. `scripts/per-app-workspace-demo.sh` builds it. Apps commit plain semver and resolve from the registry; publishable libs commit `workspace:^`; `workspace:*` is transient co-dev only. A libs-only workspace (`packages: ["libs/*"]`) builds/publishes the lib DAG, and each app's own `pnpm-workspace.yaml` shadows it on install. Both apps pin `@ejc3/ui` at the same version. `@ejc3/util` is `ui`'s unnamed transitive dep. The only difference is `web`'s root override.

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

Same registry `@ejc3/ui`, yet transitive `@ejc3/util` is local in `web`, registry in `admin` — because `web`'s root carries `pnpm.overrides { "@ejc3/util": "workspace:*" }` and `admin`'s does not. Separate roots can scope this; a shared root cannot. The apps hold separate lockfiles.

This buys per-app divergence on a transitive dep and per-app install/lockfile scope. Against the single root it loses the shared catalog (becomes per-app pins), the fleet `turbo` graph + cross-app `--affected`, instant lib-edit feedback (now publish-then-bump), and the atomic lib+consumers refactor. [FEASIBILITY.md](FEASIBILITY.md) carries the cost model and decision criteria.

## 8. When Two Copies Exist (and When They Converge)

Whether one package ends up installed once or twice follows two rules, applied per package:

**Rule 1 — a `workspace:` edge and a registry edge don't merge.** A `workspace:` edge resolves to
the local symlink; a plain semver edge on a registry-installed package's *transitive* graph resolves
from the registry. If the same package is reached through one of each — the app links `workspace:*`
core while a registry-installed ui's baked `^2.5.0` pulls a registry core — there are **two
copies**, even when the version numbers match: pnpm does not compare a workspace copy's committed
version against a registry edge's range and unify. This holds at `link-workspace-packages=false`
(the default) and `true` (which local-links only a workspace project's own *direct* plain edges,
§1); the one setting that reaches into transitive edges is `link-workspace-packages=deep`. One copy
therefore means picking a side for that package: all-workspace (every consumer on `workspace:`, or
a root override forcing the transitive edges there, §4) or all-registry (your own edge becomes a
plain range, then Rule 2 decides).

**Rule 2 — on a fresh resolve, registry edges converge when their ranges pick the same version.**
When pnpm actually resolves (no lockfile entry yet), each dependency edge takes the highest version
satisfying *its* range, independently. Same-major carets (`^2.5.0` + `^2.6.0`) pick the same newest
2.x — one shared copy, which is how a pinned old consumer picks a compatible release up at its next
re-resolve. Disjoint ranges (`^2` vs `^3`) necessarily split — the diamond of §3, safe under the
isolated linker, each dependent wired to the API it was built against.
Overlapping-but-different-shaped ranges (`^2.5.0` + `~2.5.0`) can also split, because each edge
takes its own maximum rather than hunting for a shared solution. Two scopes on this rule: an
existing lockfile **keeps prior choices** — already-split edges stay split and nothing rides
forward until something re-resolves (`pnpm update`, an install after a manifest change,
`pnpm dedupe`, which re-resolves toward fewer copies within declared ranges) — and
peer-dependency contexts can instantiate even a single chosen version more than once
([`dedupe-peer-dependents`](https://pnpm.io/settings#dedupepeerdependents)).

A split's cost is duplicate bytes plus the crossing-instance hazards (`instanceof` across copies,
doubled singletons, two React contexts). Collapsing one: durably, the lagging consumer republishes
against the newer range; immediately, a root override (§4) — which ignores declared ranges
entirely, so it is exactly as safe as the compatibility claim behind it.

## Reproduce
```bash
bash scripts/diamond-demo.sh            # publish, diamond, collapse (both halves asserted)
bash scripts/per-app-workspace-demo.sh  # per-app workspaces: transitive divergence + publish rewrite
pnpm gen --versioned                    # workspace with semver + workspace:^x.y.z
```

# Semver vs `workspace:`: internal deps, overrides, and diamonds

Internal packages are independently versioned and normally consumed by plain semver from a registry (here, AWS CodeArtifact). Sometimes you want to develop one of them locally and have everything pick it up, so you flip one lib to `workspace:` temporarily. This covers how that resolves, and what a diamond dependency does when you do.

Reproduce: `bash scripts/diamond-demo.sh` publishes to CodeArtifact, builds the diamond, then collapses it.

## 1. The gate: `link-workspace-packages`

Being in a pnpm workspace does not force the `workspace:` protocol. App `foo` can declare `"b": "^1.2.0"` even though `b` is in the same workspace; that is the independently-versioned convention. What a plain semver range means depends on `link-workspace-packages`:

| `link-workspace-packages` | `"b": "^1.2.0"` resolves to |
|---|---|
| `false` (pnpm 8+ default) | the registry, even if a local `b` with a matching version exists |
| `true` | the local workspace `b` if its version satisfies `^1.2.0`, else the registry |

This repo's diamond example sets `link-workspace-packages=false` so semver internal deps come from CodeArtifact. Only the `workspace:` protocol forces local linking unconditionally.

## 2. `workspace:<range>`

`"@demo/lib-09": "workspace:^1.4.9"` has two halves:

- `workspace:` is the resolution source: satisfy only from the local workspace, never the registry. pnpm links the local package during dev.
- `^1.4.9` is the version contract. It is an install-time check (pnpm links only if the local version satisfies it; a bare `*`/`~`/`^` always satisfies, an explicit range can fail and surface drift) and the publish template.

`pnpm pack` on a `--versioned` lib, source vs tarball:

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

Plain semver gives registry-publishable manifests; `workspace:` guarantees local linking during dev. Typical setup: commit semver, inject `workspace:` transiently to develop a lib in-tree.

### Publish rewrite, step by step

Two files:

```jsonc
// packages/widget/package.json
{ "name": "widget", "version": "1.4.9" }
// packages/card/package.json
{ "name": "card", "dependencies": { "widget": "workspace:^" } }
```

1. During dev, `workspace:` links the local `widget` folder. The `^` is unused; no version is read.
2. At `pnpm publish` of `card`, `workspace:` cannot ship: a registry consumer has no monorepo. pnpm replaces it with a real range.
3. To build that range, pnpm reads `widget`'s `"version"` (`1.4.9`) from `packages/widget/package.json`, at publish time.
4. It writes the combined range into the tarball copy of `card` (the on-disk file is untouched): `workspace:^` -> `^1.4.9`, `workspace:~` -> `~1.4.9`, `workspace:*` -> `1.4.9`. An explicit `workspace:^1.4.9` already has the number, so pnpm just strips `workspace:`.

Shipped `card` depends on `widget: ^1.4.9`.

Spec form and perf: all forms link the local package at install, so the form does not affect install time; only the published string differs. Install perf is driven by the resolution source (local `workspace:` vs registry semver) and the `node-linker` mode. `scripts/perf-matrix.mjs` covers that.

## 3. Diamond resolution under semver

All published to CodeArtifact, consumed by semver:

```
@ejc3/widget@1.0.0   exports render()      (v1 API)
@ejc3/widget@2.0.0   exports renderBox()   (v2 API; render() removed)
@ejc3/alpha@1.0.0    depends on widget ^1.0.0, uses render()
@ejc3/beta@1.0.0     depends on widget ^2.0.0, uses renderBox()

consumer -> alpha (widget ^1)
         -> beta  (widget ^2)     two majors of widget
```

`pnpm install` keeps both majors and gives each dependent the one it needs:

```
$ ls node_modules/.pnpm | grep '@ejc3+widget'
@ejc3+widget@1.0.0
@ejc3+widget@2.0.0

$ node run.mjs
alpha sees widget v1 -> [widget@1] A
beta sees widget v2 -> [widget@2] B
```

Under the isolated linker, two majors of the same package are not a conflict: pnpm installs both, so `alpha` gets widget 1 and `beta` gets widget 2 at the same time, each against the API it was built for.

## 4. Overriding one lib to `workspace:` (the collapse)

To develop `widget` locally and have everyone use that copy, use root `pnpm.overrides`. Overrides ignore declared ranges and apply workspace-wide, so they catch the direct and transitive edges of the diamond:

```jsonc
// root package.json (only the root package's overrides are honored)
{ "pnpm": { "overrides": { "@ejc3/widget": "workspace:*" } } }
```

With a local `@ejc3/widget@2.0.0`, the override forces both `alpha` and `beta` onto it, collapsing the diamond to one version:

```
$ ls node_modules/.pnpm | grep '@ejc3+widget'   # empty: widget is the local workspace copy

$ node run.mjs
SyntaxError: The requested module '@ejc3/widget' does not provide an export named 'render'
```

`alpha` was built against widget v1's `render()`; the override put it on local v2, which removed `render()`. Collapsing a diamond to one local version breaks whichever dependent was written against the other major. A local v1 would break `beta` instead. Revert: remove the override, delete `node_modules` and the lockfile, then reinstall.

## 5. Switching one app without changing the others

**The example.** Take the §3 diamond and make it concrete with two apps. Both `web` and `admin` depend on `@ejc3/alpha`, and `alpha` depends on `@ejc3/widget`. Neither app lists `widget` in its own `package.json` — each pulls it in *transitively* over the `alpha → widget` edge:

```
web   → alpha → widget
admin → alpha → widget
```

```jsonc
// apps/web/package.json   and   apps/admin/package.json  (identical)
{ "dependencies": { "@ejc3/alpha": "^1.0.0" } }
// packages/alpha/package.json
{ "name": "@ejc3/alpha", "dependencies": { "@ejc3/widget": "^1.0.0" } }
```

**The goal:** make `web` link the local `workspace:` copy of `widget` while `admin` keeps resolving `widget` from the registry. How hard that is depends on whether `widget` is a **direct** or a **transitive** dependency of the app.

**Direct dependency — trivial, and already per-app.** If `web` listed `widget` directly (`web → widget` in its own `package.json`), there is nothing to coordinate: each app's manifest controls how it resolves its own direct deps. With `link-workspace-packages=false` (§1) only the `workspace:` protocol forces local linking, so flipping just `web`'s spec switches that one app and leaves `admin` on its registry semver — one shared lockfile, one app changed:

```jsonc
// apps/web/package.json — only this app links local
{ "dependencies": { "@ejc3/widget": "workspace:*" } }
// apps/admin/package.json — unchanged, still resolves from the registry
{ "dependencies": { "@ejc3/widget": "^1.0.0" } }
```

**Transitive dependency — not cleanly per-app.** This is the example above: `web` pulls `widget` in *through* `alpha`, so `web` never names `widget` and there is nothing in its manifest to flip. Every mechanism that can reach a transitive edge is declared at the **root** and applies workspace-wide, and one lockfile records one resolution per edge:

- **Root `pnpm.overrides`** force *every* consumer onto the override — that's the §4 diamond collapse (both `web` and `admin` move), not a per-app switch.
- **Edge-scoped override** `"@ejc3/alpha>@ejc3/widget": "workspace:*"` narrows to one dependency *edge* (widget only under alpha), but it is still root-level: it affects every app whose graph contains `alpha → widget` — here both `web` and `admin` — not the single app you picked.
- **`.pnpmfile.cjs` `readPackage` hook** rewrites the spec during resolution with nothing committed to any `package.json`, but it runs for the *whole* install and resolves into the one shared lockfile — you can gate it (e.g. behind an env var) but cannot produce two different `widget` resolutions for `web` and `admin` at once:
  ```js
  // .pnpmfile.cjs
  module.exports = { hooks: { readPackage(pkg) {
    if (pkg.dependencies?.['@ejc3/widget']) pkg.dependencies['@ejc3/widget'] = 'workspace:*';
    return pkg;
  } } };
  ```
- **Per-app isolation** is the only clean way to make one app differ on a transitive dep: resolve `web` outside the shared graph. Either move it to its own workspace root (its own `pnpm-workspace.yaml` + lockfile, where `workspace:*` can link the local `widget`), or install it standalone with `pnpm install --ignore-workspace` and point at the local copy with a `link:`/`file:` dependency — note `--ignore-workspace` turns *off* workspace resolution, so `workspace:*` no longer applies there. Either way `web` gets its own lockfile while the main workspace lockfile keeps the registry version for `admin` and everyone else.

**Why this needs a separate install (transitive dep only — a direct dep never does):** a pnpm workspace is resolved as a *single* dependency graph into a *single* lockfile, and an override is a property of that one root resolution — there is no "apply this override only when the dep is reached from `web`" scope. (Edge-scoped overrides scope by graph *edge*; the `.pnpmfile` hook runs for the *whole* install — neither scopes to a consuming app.) So any override changes the resolution for every app that touches that edge. To give `web` a different resolution of a shared or transitive dep, you have to take it out of the shared graph and resolve it on its own. For a *direct* dep you don't need any of this: the app's own spec already resolves per-app.

**This is the install-time mirror of task-time focus.** `turbo run build --filter=<app>...` scopes a *task* to one app and its closure trivially (OPTIMIZATIONS.md §2.1) — tasks are per-app. Dependency *resolution* is not: the whole workspace shares one lockfile, so there is no `--filter` for overrides. Task-time focus is per-app and cheap; install-time resolution is workspace-wide and shared — which is the whole reason per-app divergence needs a separate install.

## 6. Next.js

When an app imports a workspace lib's TypeScript source (not its built `dist`), set `transpilePackages` so Next compiles that source instead of expecting prebuilt JS:

```js
// next.config.mjs
export default { transpilePackages: ['@ejc3/widget'] };
```

In this repo libraries ship built `dist`, so apps consume compiled output and `transpilePackages` is not needed.

## 7. Per-app workspaces: the model materialized

§5 ends at a recommendation — to make one app diverge on a *transitive* dep, give it its own workspace root and lockfile. This is that model, run live on CodeArtifact: one git repo, no app-spanning workspace, each app its own pnpm workspace. `scripts/per-app-workspace-demo.sh` builds it and exercises two behaviors a single shared root cannot produce per-app (the necessity is argued in §4–§5).

**The convention.** Apps commit plain semver (`"@ejc3/ui": "^1.0.0"`) and resolve libs from the registry; publishable libs commit `workspace:^` for their internal deps; `workspace:*` is the transient co-dev injection only (§2). Each app has its own `.npmrc` with `link-workspace-packages=false`. A libs-only workspace (`packages: ["libs/*"]`, never `apps/*`) builds and publishes the lib DAG; each app's own `pnpm-workspace.yaml` shadows it on install (pnpm resolves against the nearest workspace file).

**Structure.** Both apps pin `@ejc3/ui` at the **same** version. `@ejc3/util` is named by neither — it is `ui`'s transitive dep. The only difference is `web`'s own root override.

```
examples/per-app-workspace/
  pnpm-workspace.yaml   libs-only: packages: ["libs/*"]   (build + publish the libs)
  libs/util             @ejc3/util, SOURCE="workspace-local"  (the local copy web redirects to)
  apps/web/             own root; members [".", "../../libs/util"]
                        dep @ejc3/ui "1.0.0";  pnpm.overrides { "@ejc3/util": "workspace:*" }
  apps/admin/           own root; members ["."]
                        dep @ejc3/ui "1.0.0";  (no override)
```

**Proof 1 — pnpm rewrites `workspace:^` to a real range on pack/publish** (the one mechanic the diamond demo asserts but never runs — its libs ship plain semver). The script runs `pnpm pack` on `@ejc3/ui` (whose source declares `@ejc3/util: workspace:^`) and asserts the dependency in the produced tarball — proven fresh each run, with no registry write:

```
source spec:  "@ejc3/util": "workspace:^"
packed:       {"@ejc3/util":"^1.0.0"}
```

`npm publish` does not perform this rewrite (`FEASIBILITY.md`), so a lib with internal `workspace:`/`catalog:` deps must publish with pnpm.

**Proof 2 — the same transitive lib resolves differently per app.** Each app's `@ejc3/ui` is the same registry artifact and re-exports the `SOURCE` of the `@ejc3/util` it resolved (the registry copy is marked `registry@1.0.0`, the local copy `workspace-local`). The script first asserts neither app names `@ejc3/util` directly (so it is genuinely transitive), then asserts both resolved sources exactly:

```
web    require("@ejc3/ui") = {"SOURCE":"registry@1.0.0","util":"workspace-local"}
admin  require("@ejc3/ui") = {"SOURCE":"registry@1.0.0","util":"registry@1.0.0"}
```

Both apps run the same registry `@ejc3/ui`, yet its transitive `@ejc3/util` is local in `web` and from the registry in `admin`. The difference is that `web`'s own root carries `pnpm.overrides { "@ejc3/util": "workspace:*" }` and `admin`'s does not. §4 showed this same override in **one** shared root forces **every** consumer onto the local copy; here it is in `web`'s root only, so `admin` is unaffected. A shared root has a single overrides block and cannot scope it to one app — separate workspace roots can. The apps also hold separate lockfiles.

The demo publishes `@ejc3/util` + `@ejc3/ui` to real CodeArtifact at a fixed version, fresh each run (pre-deleting any leftover), and deletes both on exit — self-cleaning.

**The trade.** Observed: per-app divergence on a transitive dep, and per-app install/lockfile scope. Removed relative to the single root: the shared catalog (one-version-everywhere becomes a per-app pin in each app), the fleet `turbo` graph and cross-app `--affected`, instant lib-edit feedback in the pinned default (a lib change is publish-then-bump across the consuming apps), and the atomic cross-cutting refactor (lib + consumers in one commit). `FEASIBILITY.md` carries the full cost model and the decision criteria.

## Reproduce
```bash
bash scripts/diamond-demo.sh            # publish, diamond, collapse
bash scripts/per-app-workspace-demo.sh  # per-app workspaces: transitive divergence + publish rewrite
pnpm gen --versioned                    # workspace with semver + workspace:^x.y.z
```

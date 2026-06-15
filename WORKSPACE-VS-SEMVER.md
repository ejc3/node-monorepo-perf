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

`alpha` was built against widget v1's `render()`; the override put it on local v2, which removed `render()`. Collapsing a diamond to one local version breaks whichever dependent was written against the other major. A local v1 would break `beta` instead. Revert: delete `node_modules`, `git checkout pnpm-lock.yaml`, reinstall.

## 5. Switching for one app only

Not cleanly, with one shared lockfile:

- Root `pnpm.overrides` is workspace-wide, so you cannot make `alpha->widget` link locally for app A but resolve from the registry for app B in one install.
- Edge-scoped override: `"@ejc3/alpha>@ejc3/widget": "workspace:*"` overrides widget only under alpha. Per-edge, still root-level.
- Per-app isolation: give the app its own install/lockfile (`pnpm install --ignore-workspace` in the app dir, or a separate root).
- Without a tracked file: a `.pnpmfile.cjs` `readPackage` hook rewrites the spec during resolution:
  ```js
  // .pnpmfile.cjs
  module.exports = { hooks: { readPackage(pkg) {
    if (pkg.dependencies?.['@ejc3/widget']) pkg.dependencies['@ejc3/widget'] = 'workspace:*';
    return pkg;
  } } };
  ```

## 6. Next.js

When an app imports a workspace lib's TypeScript source (not its built `dist`), set `transpilePackages` so Next compiles it and keeps one React copy:

```js
// next.config.mjs
export default { transpilePackages: ['@ejc3/widget'] };
```

In this repo libraries ship built `dist`, so apps consume compiled output and `transpilePackages` is not needed.

## Reproduce
```bash
bash scripts/diamond-demo.sh    # publish, diamond, collapse
pnpm gen --versioned            # workspace with semver + workspace:^x.y.z
```

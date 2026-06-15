# Optimization Playbook — pnpm + Turborepo + Next.js at 10k-app scale

Principle: any operation that touches all packages scales with repo size. The techniques below scope work to the changed subset, cache the rest, and avoid materializing the whole tree.

Organized by where the cost shows up: install, graph/tasks, Next.js build, CI/deploy. Each item gives what, why, and the command.

---

## 0. The mental model: three layers of "focus"

| Layer | "Only touch…" | Mechanism | Reliable command |
|---|---|---|---|
| **Install-time** | one app's dependency closure | `turbo prune` / `pnpm deploy` | `turbo prune <app> --docker` → install `out/json` |
| **Task-time** | the affected packages | Turborepo filters / `--affected` | `turbo run build --filter=<app>...` |
| **Artifact-time** | a minimal shippable subtree | `turbo prune` | `turbo prune <app> --docker` → build `out/full` |

They **compose**: prune to a subtree (artifact), install only that subtree (install), build only what changed in it (task).

---

## 1. Install-time (pnpm)

### 1.1 `node-linker` mode (footprint and strictness, not install speed)
pnpm's default `isolated` linker builds a symlink farm: every package gets a `node_modules/` of symlinks into a virtual store (`node_modules/.pnpm`), and every file there is a hard link into the global content-addressable store. It is the strictest, most disk-efficient layout, but the count of symlinks and inodes scales with `packages × deps`, which stresses the filesystem and anything that walks the tree. Measured here (`perf-matrix.mjs`): isolated and hoisted install in about the same time (within ~3% on this single run), so the linker is a footprint/strictness choice, not an install-speed one — isolated had ~3x more symlinks (4,211 vs 1,459 at 300/100, full-tree). See [TOOLING.md](TOOLING.md).

```yaml
# pnpm-workspace.yaml
nodeLinker: isolated   # default — strict, deduped, symlink farm
# nodeLinker: hoisted  # flat node_modules (npm-style); fewer symlinks, reintroduces phantom deps
# nodeLinker: pnp      # NO node_modules at all; eliminates the inode cost, highest tooling risk
```
- Use **`hoisted`** for symlink-incompatible tooling (some bundlers, RN, certain serverless packagers).
- Use **`pnp`** (+ `symlink: false`) to kill the symlink farm entirely when your toolchain tolerates Plug'n'Play.

### 1.2 `package-import-method` on copy-on-write filesystems
How files land in `node_modules`. The default `auto` tries reflink clone → hardlink → copy. Measured here on both filesystems (`scripts/fs-bench.mjs`, `bench/fs-bench.json`; 300 apps / 100 libs, warm store): on **ext4** pnpm **hardlinks** into `node_modules` (shared inode with the store); on **btrfs** it **reflinks** (CoW clone) — confirmed by `btrfs filesystem du`, which shows the `node_modules` trees holding only **0.4 MB exclusive of 340 MB apparent** (≈100% shared extents with the store). Warm-store relink time was equal within noise (ext4 3.0s vs btrfs 3.2s), so the CoW path costs nothing extra and buys independent inodes — editing a file in `node_modules` can't corrupt the store, unlike a hardlink. No configuration needed; forcing `clone` only matters if detection is wrong.
```yaml
# pnpm-workspace.yaml
packageImportMethod: auto   # clone (CoW) -> hardlink -> copy; clone is the fast path on CoW filesystems
```

### 1.3 Catalogs (`catalog:`) — dedupe versions, shrink the lockfile, stabilize cache hashes
Define each shared version **once**; reference it from all 10k apps + 300 libs. This is already wired into this repo's `pnpm-workspace.yaml`. Identical versions everywhere → smaller lockfile, deduped store, and — critically — **identical Turborepo input hashes**, which maximizes cache hits.
```yaml
catalog:
  next: 16.2.9
  react: 19.2.7
```
```json
{ "dependencies": { "next": "catalog:", "react": "catalog:" } }
```

### 1.4 Focused install — prefer `pnpm deploy` / `turbo prune` over `install --filter`
`pnpm install --filter <app>...` **looks** like "install just this app," but with a *shared workspace lockfile* it has historically resolved/installed the **entire** workspace anyway (pnpm issues [#8318](https://github.com/pnpm/pnpm/issues/8318), [#7242](https://github.com/pnpm/pnpm/issues/7242)). The structural reason: one lockfile describes the whole workspace. **Verify on your pnpm version** — and for a *reliable* per-app environment use:
```bash
# pnpm 10+: deploy requires inject-workspace-packages=true (or --legacy),
# else ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE
pnpm --config.inject-workspace-packages=true --filter=<app> --prod deploy ./out-app
# or (what this repo uses for Vercel):
turbo prune <app> --docker && (cd out && pnpm install --frozen-lockfile)
```

### 1.5 Lockfile churn is a real scale tax
A single shared lockfile for hundreds of packages produces giant, conflict-prone diffs (pnpm v9's per-component peer-dep listing can make 10k+-char lines and 13k-line no-op diffs — discussions [#8180](https://github.com/orgs/pnpm/discussions/8180)). Mitigations: **Git Branch Lockfiles** (`pnpm` per-branch lockfile names), catalogs (fewer version edits → fewer conflicts), and CI that never needs the full lockfile (prune).

---

## 2. Task-time (Turborepo)

### 2.1 `--filter` — run a task for one app + exactly the graph it needs
```bash
turbo run build --filter=@demo/app-05000        # just that app
turbo run build --filter=@demo/app-05000...     # app + all its (transitive) deps   ← focus build
turbo run build --filter=...@demo/lib-0007      # lib-0007 + everything that depends on it (blast radius)
turbo run build --filter=...^@demo/lib-0007     # only the dependents (exclude the lib itself)
turbo run build --filter='./apps/app-0[0-4]*'   # path globs
```

### 2.2 `--affected` — in CI, only build what the PR touched
```bash
turbo run build typecheck --affected            # diff main→HEAD, pick changed pkgs (+ dependents)
```
Auto-detects GitHub Actions and diffs PR base to head; override the base with `TURBO_SCM_BASE`. A one-file PR builds the changed packages and their dependents, not all of them.

### 2.3 Caching — local, then remote
Turborepo hashes each task's inputs and skips tasks whose hash is unchanged (`>>> FULL TURBO`). In the sweep, whole-workspace typecheck warm ran 1.5s (200 apps) to 7.6s (2,000 apps), versus 19–127s cold. Remote Caching restores matching task outputs across machines instead of re-running them.
```bash
turbo run build --cache=local:rw,remote:r       # fine-grained cache source control
npx turbo login && npx turbo link                # enable Vercel remote cache
```
> Catalogs (§1.3) matter here: mismatched dep versions → different hashes → cache **misses**.

### 2.4 Concurrency — don't leave cores idle
Turbo defaults to **10** concurrent tasks. On a many-core box that throttles a 10k workspace badly. (This repo's harness passes `--concurrency=100%`.)
```bash
turbo run typecheck --concurrency=100%          # = number of cores; or an integer, or 50%
```

### 2.5 Keep the graph honest
`dependsOn: ["^build"]` makes a package's task wait for its dependencies' builds — that's what lets `--filter=app...` compute a correct, minimal closure. Declare `outputs` precisely so cache restores are correct; declare `inputs` to avoid spurious cache misses.

---

## 3. Next.js build cost

In this benchmark, aggregate build cost is dominated by per-app build startup times the app count, not any single build. The main lever is skipping unchanged builds (§2.2/§2.3) more than speeding one build. Beyond that:

### 3.1 Turbopack for builds (Next 16)
```bash
next build --turbopack       # Rust bundler; big dev/HMR wins, faster cold start on large codebases
```
Turbopack supports Fast Refresh and incremental bundling and is generally faster for dev. For production builds, measure both build time and output bundle size when switching; results vary by app.

### 3.2 `output: 'standalone'` — tiny deploy artifacts
```js
// next.config.mjs
export default { output: 'standalone' };
```
Emits a self-contained `.next/standalone` with only the traced runtime deps. Combined with `turbo prune`, this can reduce the per-app deploy/Docker image size.

### 3.3 `optimizePackageImports` — cheaper imports from big libs
```js
export default { experimental: { optimizePackageImports: ['@demo/lib-0001'] } };
```
Can reduce work for large barrel-export packages by importing only the used symbols. It is experimental; benchmark before relying on it in production.

### 3.4 Build-time safety valves you already want at scale
```js
export default {
  eslint: { ignoreDuringBuilds: true },   // lint as its own task, not inside 10k builds
  typescript: { ignoreBuildErrors: true } // typecheck as its own Turbo task, not per-build
};
```
Run `typecheck` and `lint` as **separate Turbo tasks** (cached, filterable) instead of paying for them inside every `next build`.

### 3.5 Share one config, not 10k bespoke ones
Centralize a base `next.config` and `tsconfig` in a shared package and extend per app. Shared config removes one source of hash divergence (source, lockfile, env, and task inputs still determine cache hits) and gives one place to change a flag.

---

## 4. CI / deploy (where it all comes together)

### 4.1 `turbo prune <app> --docker` — minimal, layer-cacheable build context
```bash
turbo prune @demo/app-05000 --docker        # → out/json (manifests+lockfile), out/full (source)
```
- `out/json/` = just the `package.json` files + pruned lockfile → the **install layer** (rarely invalidated).
- `out/full/` = full source of *only* the internal packages this app needs → the **source layer**.

```dockerfile
FROM node AS prune
RUN turbo prune @demo/app-05000 --docker

FROM node AS install
COPY --from=prune /app/out/json/ .
RUN pnpm install --frozen-lockfile          # cached unless deps change

FROM install AS build
COPY --from=prune /app/out/full/ .
RUN turbo run build --filter=@demo/app-05000
```
Caveat: prune has historically had bugs omitting some internal deps ([#7732](https://github.com/vercel/turborepo/issues/7732)) — confirm `out/` builds before trusting it.

### 4.2 CI baseline
```bash
turbo run lint typecheck build --affected --cache=local:rw,remote:rw --concurrency=100%
```
Changed packages only, with remote cache and full core utilization.

### 4.3 Deploying one app to Vercel from the monorepo

Verdict: cloud build, not `--prebuilt`. For a Turborepo monorepo, Vercel's documented default is a cloud build: set the project's Root Directory to `apps/<app>`, keep "Include source files outside of the Root Directory" enabled (default for projects created after 2020-08), and let Vercel install and build with Turborepo and Remote Caching. `vercel deploy --prebuilt` deploys a prior `vercel build` output and only works if `vercel build` can produce a complete `.vercel/output` from the chosen build context. The Root Directory sandbox cannot read files outside it (the docs note `..` cannot move up a level), so an app importing `../../packages/*` fails under `vercel build` unless the include-outside-files option is on. In this repo's prebuilt attempt, `next build` under `vercel build` failed for that reason.

This repo automates and times the cloud-build path in `scripts/deploy-vercel.mjs`:
1. `turbo prune <app>` → tiny self-contained subtree (**bypass `.gitignore`** first — prune respects it, and generated `apps/`+`packages/` are ignored, so it would skip the source).
2. Materialize protocols (`scripts/rewrite-protocols.mjs`): rewrite `catalog:` to concrete versions (Vercel reported *No Next.js version detected* until this was done); keep `workspace:*` so it resolves to the local subtree.
3. Copy root configs prune omits, e.g. `tsconfig.base.json` (else `TS5083: Cannot read file`).
4. Configure project: Root Directory = `apps/<app>`, install + build at repo root via `turbo run build --filter=<app>`.

Measured (`@demo/app-10`): **22s wall** (`bench/deploy.json`). The cloud build linked the libs from the subtree via `workspace:*` and built `@demo/lib-01@0.0.0` etc. — i.e. **`workspace:*` deploys the in-tree source at its local version, never a registry version** (the exact-version rewrite only happens on `pnpm publish`). To deploy a *specific published* version, consume the lib by plain semver from a registry instead — see [WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md).

### 4.4 Publishing internal packages (AWS CodeArtifact)
Internal packages are normally versioned independently and consumed by plain semver from a private registry. Auth goes in a scoped `.npmrc`, not the global one, or it hijacks the main workspace install; npm needs `--userconfig` since it does not walk ancestor `.npmrc` files; `pnpm pack`/`pnpm publish` rewrite `workspace:`/`catalog:` to concrete ranges (npm does not). `scripts/diamond-demo.sh` publishes four packages to CodeArtifact and demonstrates diamond resolution and the `workspace:` override collapse.

---

## 5. Sharp edges to verify live (don't trust the docs blindly)
1. **`pnpm install --filter app...` may install the whole workspace** with a shared lockfile (§1.4). Prefer `pnpm deploy` / `turbo prune`.
2. **`turbo prune` can omit internal deps** in some versions ([#7732](https://github.com/vercel/turborepo/issues/7732)) — build the pruned output before relying on it.
3. **Turbopack production builds** can regress bundle size even while speeding the build — measure both.
4. **Inode/symlink count** from the `isolated` linker can dominate install on 10k packages — watch `df -i` and consider `hoisted`/`pnp`/`clone`.

---

## Sources
pnpm: [settings](https://pnpm.io/settings) · [filtering](https://pnpm.io/filtering) · [catalogs](https://pnpm.io/catalogs) · [deploy](https://pnpm.io/cli/deploy) · [symlinked node_modules](https://pnpm.io/symlinked-node-modules-structure) · [git branch lockfiles](https://pnpm.io/git_branch_lockfiles)
Turborepo: [run/filtering](https://turborepo.dev/docs/reference/run) · [prune](https://turborepo.dev/repo/docs/reference/prune) · [git-based filtering](https://vercel.com/academy/production-monorepos/filtering-git-based)
Yarn (for the `focus` term): [workspaces focus](https://yarnpkg.com/cli/workspaces/focus)
Next.js / bundlers: [webpack vs Turbopack](https://www.catchmetrics.io/blog/nextjs-webpack-vs-turbopack-performance-improvements-serious-regression)
Scale reports: [Vercel: monorepos](https://vercel.com/blog/monorepos) · [remote-cache sharding](https://zomer.vercel.app/blog/optimizing-ci-cd-turborepo-remote-cache-sharding)

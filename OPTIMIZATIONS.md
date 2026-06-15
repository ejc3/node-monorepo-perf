# Optimization Playbook — pnpm + Turborepo + Next.js at 10k-app scale

> The governing principle: **at 10,000 apps, every operation that touches all 10,000 things is the bug.** Almost every technique below is a way to *not* do that — to scope work to the subset that actually changed, cache the rest, and never materialize the whole tree when you don't have to.

This is organized by the lifecycle stage where the cost shows up: **install → graph/tasks → Next.js build → CI/deploy**. Each item says *what*, *why*, and *the command*.

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

### 1.1 `node-linker` mode — the single biggest install lever at 10k packages
pnpm's default `isolated` linker builds a **symlink farm**: every package gets a `node_modules/` of symlinks into a virtual store (`node_modules/.pnpm`), and every file there is a hard link into the global content-addressable store. It's the strictest, most disk-efficient layout — but the **count** of symlinks + inodes scales with `packages × deps`, and that count is what stresses the filesystem and slows anything that walks the tree.

```yaml
# pnpm-workspace.yaml
nodeLinker: isolated   # default — strict, deduped, symlink farm
# nodeLinker: hoisted  # flat node_modules (npm-style); fewer symlinks, reintroduces phantom deps
# nodeLinker: pnp      # NO node_modules at all; eliminates the inode cost, highest tooling risk
```
- Use **`hoisted`** for symlink-incompatible tooling (some bundlers, RN, certain serverless packagers).
- Use **`pnp`** (+ `symlink: false`) to kill the symlink farm entirely when your toolchain tolerates Plug'n'Play.

### 1.2 `package-import-method: clone` on copy-on-write filesystems
How files land in `node_modules`. On APFS/Btrfs/XFS, **reflink clones** beat hard links for speed + safety.
```yaml
# pnpm-workspace.yaml
packageImportMethod: clone   # auto → clone → hardlink → copy
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
pnpm --filter=<app> --prod deploy ./out-app    # self-contained, isolated node_modules
# or
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
Auto-detects GitHub Actions and diffs PR base→head; override the base with `TURBO_SCM_BASE`. This is the **single biggest CI win** at 10k apps — a one-file PR builds a handful of packages, not 10,000.

### 2.3 Caching — local, then remote
Turborepo hashes each task's inputs and skips tasks whose hash is unchanged (`>>> FULL TURBO`). The demo shows whole-workspace typecheck going from tens of seconds **cold** to **~150ms warm**. **Remote Caching** shares those artifacts across teammates + CI, turning "rebuild the world" into "download the world."
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

The key insight: at 10k *tiny* apps the aggregate cost is **per-build cold-start overhead × N**, not any single build being slow. So the leverage is **skipping unchanged builds** (§2.2/§2.3) far more than shaving one build. Beyond that:

### 3.1 Turbopack for builds (Next 16)
```bash
next build --turbopack       # Rust bundler; big dev/HMR wins, faster cold start on large codebases
```
Turbopack wins dev/HMR decisively (~50ms updates vs webpack's 500ms–1.6s). For **production builds**, measure both **build time and output bundle size** when switching — real-world reports show faster builds but occasional bundle-size regressions. Treat it as "verify per app," not "always on."

### 3.2 `output: 'standalone'` — tiny deploy artifacts
```js
// next.config.mjs
export default { output: 'standalone' };
```
Emits a self-contained `.next/standalone` with only the traced runtime deps. Combined with `turbo prune`, the per-app deploy/Docker image shrinks dramatically.

### 3.3 `optimizePackageImports` — cheaper imports from big libs
```js
export default { experimental: { optimizePackageImports: ['@demo/lib-0001'] } };
```
Turns barrel `index.ts` re-exports (exactly what our libraries use) into direct imports, so an app only pulls the symbols it uses — less work per build and smaller bundles.

### 3.4 Build-time safety valves you already want at scale
```js
export default {
  eslint: { ignoreDuringBuilds: true },   // lint as its own task, not inside 10k builds
  typescript: { ignoreBuildErrors: true } // typecheck as its own Turbo task, not per-build
};
```
Run `typecheck` and `lint` as **separate Turbo tasks** (cached, filterable) instead of paying for them inside every `next build`.

### 3.5 Share one config, not 10k bespoke ones
Centralize a base `next.config` and `tsconfig` in a shared package and extend per app. Identical config → identical hashes → cache hits (and one place to change a flag for all 10k apps).

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

### 4.2 The winning CI recipe
```bash
turbo run lint typecheck build --affected --cache=local:rw,remote:rw --concurrency=100%
```
Only-changed packages × remote cache × full core utilization. Reports of 20min→8min CI, 50% lower task durations, and tens of hours/month saved via remote caching are common at this scale.

### 4.3 Deploying one app to Vercel from the monorepo
Two viable paths (this repo demonstrates and times one):
- **Pruned subtree:** `turbo prune <app>` → deploy `out/` with build command `turbo run build --filter=<app>`. Smallest upload; canonical monorepo pattern.
- **Monorepo root + Root Directory:** point the Vercel project at `apps/<app>`; Vercel's Turborepo integration builds only that app and reuses remote cache.

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

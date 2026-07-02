# Optimization Playbook — pnpm + Turborepo + Next.js for 10k-app scale

Principle: any operation that touches all packages scales with repo size. The techniques below scope work to the changed subset, cache the rest, and avoid materializing the whole tree. The costs they address are measured to 4,000 apps (README Results) and extrapolated beyond; 10k is the target scale, not a measured one.

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
pnpm's default `isolated` linker builds a symlink farm: every package gets a `node_modules/` of symlinks into a virtual store (`node_modules/.pnpm`), and every file there is a hard link into the global content-addressable store. It is the strictest, most disk-efficient layout, but the count of symlinks and inodes scales with `packages × deps`, which stresses the filesystem and anything that walks the tree. Measured here (`perf-matrix.mjs`): isolated and hoisted install in about the same time (within ~3.4% on this single run), so the linker is a footprint/strictness choice, not an install-speed one — isolated had ~3x more symlinks (4,211 vs 1,459 at 300/100, full-tree). See [TOOLING.md](TOOLING.md).

```yaml
# pnpm-workspace.yaml
nodeLinker: isolated   # default — strict, deduped, symlink farm
# nodeLinker: hoisted  # flat node_modules (npm-style); fewer symlinks, reintroduces phantom deps
# nodeLinker: pnp      # NO node_modules at all; eliminates the inode cost, highest tooling risk
```
- Use **`hoisted`** for symlink-incompatible tooling (some bundlers, RN, certain serverless packagers).
- Use **`pnp`** (+ `symlink: false`) to kill the symlink farm entirely when your toolchain tolerates Plug'n'Play. The PnP layout's footprint is measured via yarn 4 (the same layout contract, `install-bench.json`): 64 materialized entries (unplugged native packages) plus a 0.8–3.5 MB `.pnp.cjs` at 200–2,000 apps; pnpm's own pnp linker is not measured here.

### 1.2 `package-import-method` on copy-on-write filesystems
How files land in `node_modules`. The default `auto` tries reflink clone → hardlink → copy. Measured here on both filesystems (`scripts/fs-bench.mjs`, `bench/fs-bench.json`; 300 apps / 100 libs, warm store): on **ext4** pnpm **hardlinks** into `node_modules` (shared inode with the store); on **btrfs** it **reflinks** (CoW clone) — confirmed by `btrfs filesystem du`, which shows `node_modules` holding only **0.4 MB exclusive of 338 MB apparent** (≈100% shared extents with the store). Warm-store relink time (a forced `--offline` install, so it's pure store→`node_modules` materialization) was equal within noise: ext4 2.9s vs btrfs 3.1s. The CoW path costs nothing extra and gives independent inodes, so a file edited in `node_modules` can't corrupt the store the way a hardlink can. No configuration needed; forcing `clone` only matters if detection is wrong.
```yaml
# pnpm-workspace.yaml
packageImportMethod: auto   # clone (CoW) -> hardlink -> copy; clone is the fast path on CoW filesystems
```

### 1.2.1 The device underneath — why the relink times match but cold I/O does not
The equal relink times above are a buffered, page-cache result (a warm `--offline` materialization that writes through RAM), so they say nothing about the raw device. Measured directly (`scripts/fs-iops-bench.mjs`, `bench/fs-iops-bench.json`): the two mounts are different NVMe devices, and at the device layer the btrfs scratch NVMe is faster in every access pattern. With 4K random I/O at queue depth 16 and `O_DIRECT` (no OS page cache; a 1 GiB working set), the btrfs NVMe (`/dev/nvme0n1`) does **123,628 read / 14,486 write IOPS** at **241µs / 1,581µs p99**, versus the working-tree ext4 NVMe (`/dev/nvme2n1p1`) at **3,498 / 3,144 IOPS** and **5,669µs / 8,290µs p99** — **×35.3 read, ×4.6 write**, with **×23.5 / ×5.2 lower p99**. The widest gap is random reads (×35.3 IOPS, ×23.5 lower p99); among writes it is durable ones that diverge most — a per-file `fsync` of 5,000 × 512B files runs at **5,162/s on btrfs vs 327/s on the working tree (×15.8)**, far above the ×4.6 `O_DIRECT` random-write gap. The ext4 device serializes durable writes at ~327/s, ~3ms per fsync'd file, in line with its high random-write latency (8,290µs p99), so fsync-bound work (git objects, sqlite, lockfile flushes) is an order of magnitude slower there.

The one case where the two are close is the same buffered, page-cache path fs-bench's relink runs in: a **buffered** small-file burst is ×1.31 (btrfs 54,536 vs 41,517 files/s, create-only) and the relink is equal within noise — because buffered writes land in the page cache (RAM), so device speed barely shows. The device gap only appears once a workload actually touches the device: cold reads that miss the page cache, or any fsync-heavy step. A `node_modules` materialization is the buffered kind, so it lands in that near-parity band — but by the measured device gap a cold install (cold reads plus dependency-tree fsyncs) or any fsync-bound step would run slower on the working-tree volume than on the btrfs NVMe, which is why scratch-heavy benches run there: `real-app-bench`'s `REAL_APP_WORK` defaults to the btrfs mount.

### 1.3 Catalogs (`catalog:`) — dedupe versions, shrink the lockfile, stabilize cache hashes
Define each shared version **once**; reference it from every app and lib in the workspace. This is already wired into this repo's `pnpm-workspace.yaml`. Identical versions everywhere → smaller lockfile, deduped store, and — critically — **identical Turborepo input hashes**, which maximizes cache hits. Measured (`scripts/lockfile-merge-bench.mjs`, 200 apps / 50 libs): rolling one shared version through the catalog changed **0** of the apps' `package.json` files (only `pnpm-workspace.yaml` + the lockfile, which moved 255 lines added / 255 removed), versus **25** `package.json` files when the same dependency is pinned per-app — so a rollout edits one line, not every app, and no app-manifest merge conflicts arise (the lockfile still moves; see §1.5).
```yaml
catalog:
  next: 16.2.9
  react: 19.2.7
```
```json
{ "dependencies": { "next": "catalog:", "react": "catalog:" } }
```

### 1.4 Focused install — prefer `pnpm deploy` / `turbo prune` over `install --filter`
`pnpm install --filter <app>...` still resolves the whole-workspace lockfile — there is only one — but on **pnpm 10.29 it scopes what it materializes**. Measured (`scripts/focus-install-bench.mjs`, 80 apps / 25 libs): a filtered install linked `node_modules` for only **1 of 80 apps** (the target plus its 14-package closure), versus **80/80** for a full install. So the lockfile stays O(repo), but the per-app **materialization** is scoped. For a self-contained per-app environment (its own pruned lockfile) use:
```bash
# pnpm 10+: deploy requires inject-workspace-packages=true (or --legacy),
# else ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE
pnpm --config.inject-workspace-packages=true --filter=<app> --prod deploy ./out-app
# or build a per-app subtree via the verified docker-layer flow in §4.1 — note prune
# omits root configs (tsconfig.base.json), which you must copy before building:
turbo prune <app> --docker   # → install out/json, overlay out/full, copy tsconfig.base.json, build
```

### 1.5 Lockfile churn is a real scale tax — but pnpm auto-resolves the conflicts
The single shared lockfile is O(repo): small intents move a lot of it. Measured (`scripts/lockfile-merge-bench.mjs`, 200 apps / 50 libs, baseline lockfile 8,869 lines):

| change | `package.json` files changed | lockfile lines (added / removed) |
|---|---|---|
| add one dependency to one app | 1 | 10 / 0 |
| bump one shared version via `catalog:` (one line) | **0** | 255 / 255 |
| pin the same version per-app in 25 apps (version skew) | 25 | 57 / 50 |

The `package.json` column is the apples-to-apples comparison: a catalog bump edits **0** app manifests, the same change pinned per-app edits **25** — that's the merge-conflict surface. The lockfile columns are not same-scope (the catalog row re-resolves the dep for every importer; the skew row only the 25 pinned apps), but both move it. A one-line `catalog:` bump rewrites hundreds of lockfile lines because it re-resolves that dependency for every importer — and two such bumps on different branches **conflict**: a real `git merge` of two version bumps produced **253 conflict markers** in `pnpm-lock.yaml`. You don't hand-resolve that: after choosing the source version, **`pnpm install` drove the 253 markers to 0** — pnpm [auto-resolves lockfile merge conflicts](https://pnpm.io/git).

Mitigations, each verified in `lockfile-merge-bench.mjs`, in order:
- **Catalogs (§1.3)** keep a version edit to one line and out of every app's `package.json` (0 vs 25 manifest changes above), so rollouts don't cause `package.json` merge conflicts.
- **`pnpm install` auto-resolution** of the lockfile conflict (253 → 0 markers).
- **Git Branch Lockfiles** (`git-branch-lockfile=true` → a per-branch `pnpm-lock.<branch>.yaml`, verified created) to avoid conflicting on the shared lockfile at all.
- **CI that never needs the full lockfile** — `turbo prune` ships a pruned lockfile (876 of 3,969 lines for one app, §4.1).

bun is **not required** for any of this: pnpm, npm, yarn, and bun are all Turborepo-supported package managers; this repo uses pnpm.

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
Turborepo hashes each task's inputs and skips tasks whose hash is unchanged (`>>> FULL TURBO`). In the sweep, whole-workspace typecheck warm ran 1.5s (200 apps) to 20.5s (4,000 apps), versus 19–233s cold. Remote Caching restores matching task outputs across machines instead of re-running them.
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

In this benchmark, aggregate build cost is dominated by per-app build startup cost multiplied by the app count, not by any single build's duration. The main lever is skipping unchanged builds (§2.2/§2.3) more than speeding one build. Beyond that:

### 3.1 Turbopack for builds (Next 16)
```bash
next build       # Next 16: Turbopack is the default production bundler
```
Measured (`scripts/turbopack-bench.mjs`): on Next 16.2.9, `next build` and `next build --turbopack` produce identical output size and the same bundler (2.6s, 3.90 MB) — `--turbopack` is a no-op because Turbopack is already the default. It also powers `next dev` (Fast Refresh, incremental). The bundler is not a choice to tune on Next 16.

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
  typescript: { ignoreBuildErrors: true } // typecheck as its own Turbo task, not per-build
};
```
Run `typecheck` (and `lint`, if you add it) as **separate Turbo tasks** (cached, filterable) instead of paying for them inside every `next build`. The generated Next 16 config omits the `eslint` key (no webpack-era `ignoreDuringBuilds` carried over) and the apps ship no ESLint config, so `next build` does not lint; if you want lint, run it as its own `turbo run lint --affected` task.

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
COPY tsconfig.base.json .                    # prune omits root configs apps extend (verified, §4.1/§5)
RUN turbo run build --filter=@demo/app-05000
```
Verified here (turbo 2.9.18, `scripts/focus-install-bench.mjs`): prune included **all 15** of the target's closure packages (0 missing) and the docker-flow build succeeded — but only after copying `tsconfig.base.json`, which prune does **not** include (apps extend it). So an earlier report that `turbo prune` drops internal deps ([turborepo#7732](https://github.com/vercel/turborepo/issues/7732)) did not reproduce; the gap to handle is root configs, which `deploy-vercel.mjs` copies.

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

## 5. Sharp edges — verified live on this stack (pnpm 10.29, turbo 2.9.18)

Verified here (`scripts/focus-install-bench.mjs`):
1. **`pnpm install --filter app...` scopes materialization** despite the shared lockfile: 1/80 app `node_modules` under `--filter=app...` vs 80/80 for a full install (§1.4). The lockfile is still O(repo), so for a self-contained per-app lockfile use `pnpm deploy` / `turbo prune`.
2. **`turbo prune` is complete but omits root configs**: 0 of 15 closure packages missing from `out/full`, pruned lockfile 876/3969 lines, and the docker-flow build succeeds — after copying `tsconfig.base.json` (prune doesn't ship it; apps extend it). [turborepo#7732](https://github.com/vercel/turborepo/issues/7732)'s internal-dep omission did not reproduce (§4.1).

3. **Next 16 builds with Turbopack** (`scripts/turbopack-bench.mjs`): `next build` and `next build --turbopack` produced identical output size and the same bundler (2.6s, 3.90 MB on Next 16.2.9) — Turbopack is the default and `--turbopack` is a no-op. The bundler is not a tunable variable on Next 16.
4. **The `isolated` linker is inode-heavy** — measured **50,159** `node_modules` entries vs hoisted's **21,914** at 2,000 apps (`install-bench.json`), ~3× the symlinks (4,211 vs 1,459 at 300/100, `perf-matrix.json`), and **86,749 entries / 49,712 symlinks** at 4,000 apps (`results.json`). At ~10k packages this dominates filesystem/inode pressure — watch `df -i`; `hoisted` roughly halves the entries, and the PnP layout shrinks it to almost nothing (yarn 4 measured: **64** unplugged entries + a 0.8–3.5 MB `.pnp.cjs`, `install-bench.json`).

---

## Sources
pnpm: [settings](https://pnpm.io/settings) · [filtering](https://pnpm.io/filtering) · [catalogs](https://pnpm.io/catalogs) · [deploy](https://pnpm.io/cli/deploy) · [symlinked node_modules](https://pnpm.io/symlinked-node-modules-structure) · [git branch lockfiles](https://pnpm.io/git_branch_lockfiles)
Turborepo: [run/filtering](https://turborepo.dev/docs/reference/run) · [prune](https://turborepo.dev/repo/docs/reference/prune) · [git-based filtering](https://vercel.com/academy/production-monorepos/filtering-git-based)
Yarn (for the `focus` term): [workspaces focus](https://yarnpkg.com/cli/workspaces/focus)
Next.js / bundlers: [webpack vs Turbopack](https://www.catchmetrics.io/blog/nextjs-webpack-vs-turbopack-performance-improvements-serious-regression)
Scale reports: [Vercel: monorepos](https://vercel.com/blog/monorepos) · [remote-cache sharding](https://zomer.vercel.app/blog/optimizing-ci-cd-turborepo-remote-cache-sharding)

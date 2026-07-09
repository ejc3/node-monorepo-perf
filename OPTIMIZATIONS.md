# Optimization Playbook: pnpm + Turborepo + Next.js at 10k-App Scale

Any operation touching all packages scales with repo size. These techniques scope work to the changed subset, cache the rest, and avoid materializing the whole tree. Costs are measured to 4,000 apps ([README results](README.md#results-scaling-behavior)) and extrapolated; 10k is the target, not a measured scale.

## 0. The Mental Model: Three Layers of "Focus"

Three composing scopes: install-time (one app's closure, `turbo prune <app> --docker`), task-time (affected packages, `turbo run build --filter=<app>...`), artifact-time (a minimal shippable subtree, `turbo prune` → `out/full`). Prune to a subtree, install only it, build only what changed.

## 1. Install Time (pnpm)

### 1.1 `node-linker` Mode
The default `isolated` linker builds a symlink farm scaling with `packages × deps`. Isolated and hoisted install within ~3.4% of each other (`perf-matrix.mjs`) — the linker is a footprint/strictness choice, not a speed one. `hoisted` (flat, reintroduces phantom deps) suits symlink-incompatible tooling; `pnp` + `symlink: false` removes the farm, but tsgo and `next build` fail under PnP while tsc/turbo/oxlint pass ([TOOLING.md](TOOLING.md#yarn-pnp-toolchain-compatibility)).

### 1.2 `package-import-method` on Copy-on-Write Filesystems
`auto` tries reflink clone → hardlink → copy. On **ext4** pnpm hardlinks; on **btrfs** it reflinks (CoW), with `node_modules` holding only **0.4 MB exclusive of 338 MB apparent** (`bench/fs-bench.json`; 300/100, warm store). CoW costs nothing extra and gives independent inodes; no config needed.

### 1.2.1 Device-Level I/O
The equal relink times are a buffered page-cache result. At the device layer (`bench/fs-iops-bench.json`) the btrfs scratch NVMe beats the working-tree ext4 NVMe in every 4K `O_DIRECT` pattern: random read ×35.3 IOPS, per-file `fsync` ×15.8 (5,162/s vs 327/s) — so fsync-bound work (git, sqlite, lockfile flushes) is an order of magnitude slower on ext4. Only the buffered path is close (small-file burst ×1.31), so a `node_modules` materialization sits in the near-parity band.

### 1.3 Catalogs (`catalog:`)
Define each shared version once, reference it everywhere. Identical versions → smaller lockfile, deduped store, identical Turborepo input hashes. Rolling one shared version through the catalog changed **0** app `package.json` files versus **25** when pinned per-app (`bench/lockfile-merge-bench.json`, 200/50) — no app-manifest merge conflicts (the lockfile still moves; see [§1.5](#15-lockfile-churn-and-merge-conflicts)).

### 1.4 Focused Install
`pnpm install --filter <app>...` still resolves the whole-workspace lockfile but on **pnpm 10.29 scopes materialization**: it linked `node_modules` for only **1 of 80 apps** vs **80/80** full (`bench/focus-install-bench.json`, 80/25). For a self-contained per-app environment use `pnpm --config.inject-workspace-packages=true --filter=<app> --prod deploy`, or a per-app subtree via [§4.1](#41-turbo-prune-app---docker) (copy `tsconfig.base.json`, which prune omits).

### 1.5 Lockfile Churn and Merge Conflicts
The single shared lockfile is O(repo). Measured (`bench/lockfile-merge-bench.json`, 200/50, baseline 8,869 lines):

| change | `package.json` files changed | lockfile lines (added / removed) |
|---|---|---|
| add one dependency to one app | 1 | 10 / 0 |
| bump one shared version via `catalog:` (one line) | **0** | 255 / 255 |
| pin the same version per-app in 25 apps (version skew) | 25 | 57 / 50 |

The `package.json` column is the apples-to-apples comparison (0 vs 25 manifests = the merge-conflict surface). A one-line `catalog:` bump rewrites hundreds of lockfile lines. Two bumps on different branches conflict: a `git merge` produced **253 conflict markers**, and **`pnpm install` drove them to 0** ([auto-resolves lockfile merge conflicts](https://pnpm.io/git)). Four mitigations apply:

- catalogs ([§1.3](#13-catalogs-catalog))
- `pnpm install` auto-resolution
- Git Branch Lockfiles (`git-branch-lockfile=true`)
- CI via `turbo prune`'s pruned lockfile ([§4.1](#41-turbo-prune-app---docker))

## 2. Task Time (Turborepo)

`--filter` scopes a run: `app...` runs an app + its transitive deps (focus build), `...@demo/lib-0007` a lib + everything depending on it (blast radius), `...^lib` only dependents. Turbo defaults to **10** concurrent tasks — pass `--concurrency=100%` on a many-core box. `dependsOn: ["^build"]` lets `--filter=app...` compute a correct minimal closure.

### 2.2 `--affected`
`turbo run build typecheck --affected` diffs main→HEAD and picks changed packages + dependents. Auto-detects GitHub Actions; override the base with `TURBO_SCM_BASE`.

### 2.3 Caching: Local, Then Remote
Turborepo hashes each task's inputs and skips unchanged ones (`>>> FULL TURBO`). Whole-workspace typecheck warm ran 1.5s (200 apps) to 20.5s (4,000 apps) versus 19–233s cold. Remote Caching (`turbo login && turbo link`) restores outputs across machines. Catalogs ([§1.3](#13-catalogs-catalog)) matter: mismatched versions → different hashes → cache misses.

## 3. Next.js Build Cost

Aggregate build cost is dominated by per-app startup × app count, not any single build's duration. The main lever is skipping unchanged builds ([§2.2](#22---affected)/[§2.3](#23-caching-local-then-remote)).

### 3.1 Turbopack for Builds
On Next 16.2.9, `next build` and `next build --turbopack` produce identical output and the same bundler (2.6s, 3.90 MB); `--turbopack` is a no-op because Turbopack is the default (`bench/turbopack-bench.json`).

A few other levers remain:

- `output: 'standalone'` emits only traced deps.
- `optimizePackageImports` imports only used barrel symbols (experimental).
- Run `typecheck`/`lint` as separate Turbo tasks (`typescript: { ignoreBuildErrors: true }`), not inside every `next build`.
- Centralize base `next.config`/`tsconfig` in a shared package.

## 4. CI and Deploy

### 4.1 `turbo prune <app> --docker`
Produces a layer-cacheable build context: `out/json/` = manifests + pruned lockfile (install layer); `out/full/` = source of only the internal packages the app needs (source layer). A Dockerfile copies `out/json`, installs `--frozen-lockfile`, copies `out/full` + `tsconfig.base.json`, then `turbo run build --filter=<app>`. Verified (turbo 2.9.18, `bench/focus-install-bench.json`): prune included **all 15** closure packages (0 missing) and the build succeeded — but only after copying `tsconfig.base.json`, which prune omits. An earlier report that prune drops internal deps ([turborepo#7732](https://github.com/vercel/turborepo/issues/7732)) did not reproduce. The gap is root configs, which `deploy-vercel.mjs` copies.

A reasonable CI baseline is `turbo run lint typecheck build --affected --cache=local:rw,remote:rw --concurrency=100%`.

### 4.3 Deploying One App to Vercel
Use the cloud build path, not `--prebuilt`: set Root Directory to `apps/<app>`, keep "Include source files outside of the Root Directory" enabled, and let Vercel build with Turborepo + Remote Caching (`vercel build`'s sandbox cannot read `../../packages/*` without it). `scripts/deploy-vercel.mjs` automates it: **22s wall** for `@demo/app-10` (`bench/deploy.json`). `workspace:*` deploys in-tree source at its local version, never a registry version (the exact-version rewrite happens only on `pnpm publish`). For a published version, consume by plain semver — see [WORKSPACE-VS-SEMVER.md](WORKSPACE-VS-SEMVER.md).

### 4.4 Publishing to AWS CodeArtifact
Auth goes in a scoped `.npmrc`, not the global one. npm needs `--userconfig` (it does not walk ancestor `.npmrc`). `pnpm pack`/`pnpm publish` rewrite `workspace:`/`catalog:` to concrete ranges (npm does not). `scripts/diamond-demo.sh` demonstrates diamond resolution and the `workspace:` override collapse.

## 5. Quick Reference

Verified on pnpm 10.29, turbo 2.9.18. The `isolated` linker is inode-heavy. It holds 50,159 `node_modules` entries vs hoisted's 21,914 at 2,000 apps (`install-bench.json`), and 86,749 entries / 49,712 symlinks at 4,000 apps (`results.json`). At ~10k packages this dominates inode pressure; watch `df -i`. `hoisted` roughly halves it, PnP shrinks it to almost nothing ([§1.1](#11-node-linker-mode)).

## Sources
pnpm: [settings](https://pnpm.io/settings), [catalogs](https://pnpm.io/catalogs). Turborepo: [run/filtering](https://turborepo.dev/docs/reference/run), [`turbo prune`](https://turborepo.dev/repo/docs/reference/prune). [Vercel monorepos](https://vercel.com/blog/monorepos).

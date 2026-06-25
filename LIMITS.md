# Limits and gotchas at 20k apps

What focus/cache/`--affected` cannot save you from, what still needs measuring, and the gotchas this build hit.

## What breaks at 20k that you cannot fully work around

These are irreducibly O(repo): scoping and caching reduce *execution*, but the cost remains because it is inherent to having one workspace graph and one lockfile.

1. **The single lockfile.** One `pnpm-lock.yaml` describes the whole workspace. Measured growth: 9,897 → 153,967 lines across 300 → 4,300 packages (≈36 lines per added package); extrapolating ~linearly, that is multi-MB and ~720k lines at 20,000 packages. Every install reads it and (on any dep change) rewrites it, and every branch that touches deps creates a merge-conflict surface. You cannot `--filter` the lockfile — it is global. Mitigations trade away its value: `shared-workspace-lockfile=false` (per-package lockfiles, losing cross-package dedup) or git-branch lockfiles (avoids conflicts, not size).

2. **The Turbo graph-load floor.** `--filter`, `--affected`, and `prune` all parse every `package.json` and build the full dependency DAG *before* selecting a subset. That load is O(repo) on every invocation, including no-ops. Measured: a fully-cached `turbo run typecheck` (Turbo hashing the tracked source) grew 1.5s → 20.5s (200 → 4,000 apps). At 20k the per-command floor is tens of seconds before any task runs. You cannot filter below the graph load. The only escape is to stop having one graph (shard), which gives up atomic cross-package changes.

3. **Foundation/root-change blast radius = the whole repo.** A change to a widely-used lib, or to a root input in every task's hash (`tsconfig.base.json`, the catalog's React/Next version, the pnpm/turbo/next version), invalidates the cache for all dependents. Measured: editing low-layer `lib-003` rebuilds 1,080 of 1,200 packages; at 20k that is ~18k packages. Remote cache only helps the *second* consumer of an artifact — someone still computes the cold rebuild, and `--affected` cannot help when everything is affected. This is organizational (change foundations rarely), not a technical fix.

4. **Materializing the whole tree (inodes/disk).** Installing all 20k apps creates a `node_modules` per package. Isolated-linker symlinks measured 4,211 at 300/100 (full-tree) → hundreds of thousands at 20k, plus the `.pnpm` store. Building all apps' output: 40 Next apps = 156 MB → 20k ≈ 78 GB of `.next`; inodes can exhaust a modest filesystem. Focus (prune/deploy) avoids this per-app, but a full local checkout or a build-everything CI job pays it. Levers: `node-linker=pnp` (no `node_modules`), don't build everything.

5. **Editor / language server.** tsserver loading a 20k-package project means multi-GB memory and slow cross-package IntelliSense/go-to-def. Not captured by build benchmarks; it is the felt daily cost. Mitigations (open a sub-tree, sparse-checkout, pnp + editor SDK) are partial — the project graph is still large.

6. **git at 20k.** ~130k+ source files (20k apps × ~6 + 300 libs × ~16). `git status`/`checkout`/`clone` are O(worktree); without `fsmonitor` + `sparse-checkout` + partial clone they degrade. It scales, but needs Scalar-style setup.

7. **Deploy-platform per-project model.** One Vercel project per deployable app, but Vercel caps projects per git repo (Pro: 60 — [limits](https://vercel.com/docs/limits)), so 20k apps cannot register as 20k projects in one repo; you split across repos or teams, itself a sharding pressure. A push to a foundation lib then evaluates "affected" across every project in the repo. Vercel's native "skip unaffected projects" does not consume a concurrent build slot, but the deprecated `turbo-ignore` Ignored Build Step does, so under it a foundation push competes for the team's finite concurrent-build cap ([limits](https://vercel.com/docs/limits)). Use `turbo run --affected` plus the native skip (`turbo-ignore` is deprecated); per-branch builds still serialize.

The pattern: pnpm + Turborepo's single-graph, single-lockfile model has a ceiling near the point where graph-load + lockfile + foundation-blast dominate. The workaround at the ceiling is to stop having one graph — shard into independent workspaces, or move to a build system with a persistent daemon and remote execution (Bazel/Buck2 + a build farm) where the graph is not reloaded per invocation and work is distributed. That is a different architecture, not a tuning of this one.

## What we should still quantify

Measured so far: gen, install (cold/warm/truly-cold; pnpm-isolated/hoisted/bun), typecheck (cold/warm), focus build, prune, deploy, publish, diamond, dev-sim, Next-vs-Vite build, tsc-vs-tsgo, spec-form/node-linker. Gaps:

1. Direct lockfile measurement at 10k/20k — lines, MB, and pnpm parse time per install. Lockfile *size* is measured through 4,000 apps (`results.json`); the resolve-vs-verify split (`lockfile-bench`) goes to 2,000; the 20k figure in §1 is extrapolated from the 200→4,000 trend.
2. `node-linker=pnp` full-tree footprint — the isolated and hoisted full-tree `node_modules` counts are now measured (TOOLING.md); `pnp` is not.
3. Turbo graph-load floor — `turbo run build --dry` time (no execution) vs scale, isolated from task time.
4. Foundation-change rebuild *time* (we have the count, 1,080; measure the wall-clock cold and with remote cache).
5. Remote cache restore vs rebuild — download-the-world time vs cold build, at scale.
6. `pnpm install --filter app...` at scale. Its materialization scoping is confirmed (1 of 80 apps linked, `focus-install-bench`); the open part is install time + footprint vs `turbo prune` at 10k/20k.
7. `node-linker=pnp` — install time + footprint + tooling compatibility vs isolated/hoisted.
8. Cold onboarding — fresh `git clone` + `pnpm install` for a new dev at 10k/20k.
9. Peak memory under `--concurrency=100%` typecheck/build (OOM risk: 64 × tsc/next workers).
10. tsserver/IDE project-load time + RSS at scale (semi-manual).

## Gotchas this build hit

- Turbo input hashing **and** `turbo prune` respect `.gitignore`; generated, gitignored source is invisible to both (`--use-gitignore=false` for prune; move `.gitignore` aside for dev-sim).
- `catalog:` is pnpm-only — Vercel's framework detector, npm, and bun do not understand it ("No Next.js version detected"; bun ignores it).
- `turbo prune` does not copy root configs packages reference via `../../` (e.g. `tsconfig.base.json`).
- `pnpm install --filter app...` scopes what it *materializes* (1 of 80 apps linked, `focus-install-bench`) but still resolves the one shared, whole-workspace lockfile; for a self-contained per-app lockfile use `pnpm deploy` / `turbo prune`.
- `workspace:*` deploys the in-tree source at its local version, not a published version (rewrite happens only on `pnpm publish`).
- bun ignores `pnpm-workspace.yaml` (needs `package.json` "workspaces") and uses a hoisted layout.
- Don't carry `eslint: { ignoreDuringBuilds: true }` from webpack-era configs — the generated Next 16 config omits the `eslint` key entirely; if you want lint, run it as a separate Turbo task, not inside `next build`.
- `spawnSync` buffers child output in memory → ENOBUFS at scale; pipe to a file instead.
- Even a fully-cached `turbo run` is O(repo) (graph load + hashing).

# Limits and gotchas at 20k apps

What focus/cache/`--affected` cannot save you from, what still needs measuring, and the gotchas this build hit.

## What breaks at 20k that you cannot fully work around

These are irreducibly O(repo): scoping and caching reduce *execution*, but the cost remains because it is inherent to having one workspace graph and one lockfile.

1. **The single lockfile.** One `pnpm-lock.yaml` describes the whole workspace. Measured growth: 9,897 → 153,967 lines across 300 → 4,300 packages (≈36 lines per added package); extrapolating ~linearly, that is multi-MB and ~720k lines at 20,000 packages. Every install reads it and (on any dep change) rewrites it, and every branch that touches deps creates a merge-conflict surface. You cannot `--filter` the lockfile — it is global. Mitigations trade away its value: `shared-workspace-lockfile=false` (per-package lockfiles, losing cross-package dedup) or git-branch lockfiles (avoids conflicts, not size).

2. **The Turbo graph-load floor.** `--filter`, `--affected`, and `prune` all parse every `package.json` and build the full dependency DAG *before* selecting a subset. That load is O(repo) on every invocation, including no-ops. Measured: a fully-cached `turbo run typecheck` (Turbo hashing the tracked source) grew 1.5s → 20.5s (200 → 4,000 apps). At 20k the per-command floor is tens of seconds before any task runs. You cannot filter below the graph load. The only escape is to stop having one graph (shard), which gives up atomic cross-package changes.

3. **Foundation/root-change blast radius = the whole repo.** A change to a widely-used lib, or to a root input in every task's hash (`tsconfig.base.json`, the catalog's React/Next version, the pnpm/turbo/next version), invalidates the cache for all dependents. Measured: editing low-layer `lib-003` rebuilds 1,080 of 1,200 packages; at 20k that is ~18k packages. The same shape holds for the `test` task (`bench/test-axis-bench.json`, 1,000:200): editing a universal foundation lib re-tests every package (1,200 of 1,200) while a leaf-lib edit re-tests only its dependents (21) — a ~57× blast spread (1,200 / 21); `--filter=...<lib>` (the git-free `--affected` stand-in) selects exactly that set. (The cold wall-clocks — 14.3s for the 1,200 vs 3.0s for the 21 — are over trivial smoke bodies, so they bound Turbo orchestration + `node --test` startup, not real suite runtime; the count is the evidence.) Remote cache only helps the *second* consumer of an artifact — someone still computes the cold rebuild, and `--affected` cannot help when everything is affected: a fresh runner restores **486 of 500** tasks from a remote cache after a *leaf* edit, but **0 of 500** after a *universal-foundation* edit (`bench/ci-cache-bench.json`, 300:100; see "Remote cache: amortizing the O(repo) cold start" below). The lever for the unavoidable whole-repo case is sharding the independent test tasks across machines (1,200 → 150/shard at 8 shards, arithmetic). This is organizational (change foundations rarely), not a technical fix.

4. **Materializing the whole tree (inodes/disk).** Installing all 20k apps creates a `node_modules` per package. Isolated-linker symlinks measured 4,211 at 300/100 (full-tree) → hundreds of thousands at 20k, plus the `.pnpm` store. Building all apps' output: 40 Next apps = 156 MB → 20k ≈ 78 GB of `.next`; inodes can exhaust a modest filesystem. Focus (prune/deploy) avoids this per-app, but a full local checkout or a build-everything CI job pays it. Levers: `node-linker=pnp` (no `node_modules`), don't build everything.

5. **Editor / language server.** tsserver loading a 20k-package project means multi-GB memory and slow cross-package IntelliSense/go-to-def. Not captured by build benchmarks; it is the felt daily cost. Mitigations (open a sub-tree, sparse-checkout, pnp + editor SDK) are partial — the project graph is still large.

6. **git at 20k.** ~130k+ source files (20k apps × ~6 + 300 libs × ~16). `git status`/`checkout`/`clone` are O(worktree); without `fsmonitor` + `sparse-checkout` + partial clone they degrade. It scales, but needs Scalar-style setup.

7. **Deploy-platform per-project model.** One Vercel project per deployable app, but Vercel caps projects per git repo (Pro: 60 — [limits](https://vercel.com/docs/limits)), so 20k apps cannot register as 20k projects in one repo; you split across repos or teams, itself a sharding pressure. A push to a foundation lib then evaluates "affected" across every project in the repo. Vercel's native "skip unaffected projects" does not consume a concurrent build slot, but the deprecated `turbo-ignore` Ignored Build Step does, so under it a foundation push competes for the team's finite concurrent-build cap ([limits](https://vercel.com/docs/limits)). Use `turbo run --affected` plus the native skip (`turbo-ignore` is deprecated); per-branch builds still serialize.

The pattern: pnpm + Turborepo's single-graph, single-lockfile model has a ceiling near the point where graph-load + lockfile + foundation-blast dominate. The workaround at the ceiling is to stop having one graph — shard into independent workspaces, or move to a build system with a persistent daemon and remote execution (Bazel/Buck2 + a build farm) where the graph is not reloaded per invocation and work is distributed. That is a different architecture, not a tuning of this one.

## Remote cache: amortizing the O(repo) cold start

Every CI runner starts with an empty local cache, so without a shared cache each one pays the full cold compute. A Turborepo remote cache (here a real `turborepo-remote-cache@2.11.2` server, measured on localhost) lets the second-and-later runner *restore* an artifact a previous runner already built instead of recomputing it. Head-to-head per task and scale (`bench/ci-cache-bench.json`; 64-core box):

| task      | scale                  | no-cache cold | remote-restore | speedup | fresh-runner download |
| --------- | ---------------------- | ------------- | -------------- | ------- | --------------------- |
| typecheck | 300 apps / 100 libs    | 23.6s         | 1.9s           | 12.5×   | 0.2 MB                |
| typecheck | 1,000 apps / 200 libs  | 67.2s         | 5.9s           | 11.4×   | 0.5 MB                |
| build     | 300 apps / 100 libs    | 62.7s         | 4.0s           | 15.5×   | 247 MB                |

"No-cache cold" is pure compute with no remote configured — what every runner pays without a shared cache. "Remote-restore" is a fresh runner (empty local cache, no build outputs) restoring everything from the remote-only cache. Restore is essentially the fully-cached warm run (this bench's warm-local floor is 1.8s / 5.2s vs restore 1.9s / 5.9s at the two scales; the small gap is the ≤0.5 MB download), and §2 shows that floor is itself O(repo): restore skips task *execution* but still pays Turbo's per-command graph-load + hashing (a fully-cached typecheck reaches 20.5s at 4,000 apps). So restore grows with the repo too (1.9s → 5.9s, 300 → 1,000 apps), and stays ~11–12× under the cold compute because it skips execution — not because it is byte-bound. The speedup therefore **holds** (12.5× → 11.4×) rather than widening as the repo grows, while the absolute time saved grows (21.7s → 61.3s). (typecheck is the realistic CI job here: `typecheck dependsOn ^build`, so a cold typecheck also builds the lib dists; its cached artifacts are those dists plus empty typecheck markers — 0.2–0.5 MB. A `build` run also caches every app's `.next`, so a fresh runner downloads 247 MB for 400 packages; the build cell's cold is a single sample — a cold build is slow and the 15.5× effect dwarfs run-to-run noise — while the typecheck cells are medians of two.)

**Someone still pays the first build.** A remote cache only helps consumers *after* the first: the first runner to build a given input computes it and uploads (the "seed"). On localhost that upload is within compute noise (seed vs no-cache cold differ by −0.8s to +0.4s across the three cells, against 23.6–67.2s of compute), so the real seed cost over a network is the artifact transfer — `bytesTransferred / bandwidth`, negligible for a typecheck (≤0.5 MB) but 247 MB for the build, paid once.

**Across a fleet it amortizes — at best.** With R runners (or R CI runs) building the **identical** closure, without a cache all R pay the cold compute; with one, the first seeds and the other R−1 restore. This is the best case: a real CI fleet builds different commits, so cross-runner reuse is partial and the real factor is lower. From the 1,000:200 typecheck (`bench/ci-cache-bench.json`, arithmetic from the measured cold/seed/restore):

| runners R | without cache | with cache | per-runner | fleet speedup |
| --------- | ------------- | ---------- | ---------- | ------------- |
| 1         | 67.2s         | 67.3s      | 67.3s      | 1.0×          |
| 2         | 134s          | 73.2s      | 36.6s      | 1.8×          |
| 5         | 336s          | 90.9s      | 18.2s      | 3.7×          |
| 10        | 672s          | 120s       | 12.0s      | 5.6×          |
| 50        | 3,361s        | 356s       | 7.1s       | 9.4×          |

Per-runner cost converges toward the restore time (5.9s) as the fleet grows. (restore is the localhost floor — over a network add each runner's download; for typecheck that is ≤0.5 MB.)

**It cannot help when an edit changes everything.** A remote cache restores only the artifacts an edit did *not* invalidate. Editing a leaf lib (a few dependents rehash) vs the universal foundation lib (every package rehashes), then a fresh runner runs the whole repo (`bench/ci-cache-bench.json`, 300:100 under `--universal 1`, 500 tasks):

- **leaf edit** → **486 of 500** tasks restored from the cache, 14 recomputed (the edited lib's closure).
- **foundation edit** → **0 of 500** restored, all 500 recomputed.

This is §3's blast radius from the cache's side: scope an edit and the cache absorbs the rest; touch a foundation and the cache is worthless — someone pays the full cold rebuild. That is why foundation changes are rare-by-policy, not cache-able.

## What we should still quantify

Measured so far: gen, install (cold/warm/truly-cold; pnpm-isolated/hoisted/bun), typecheck (cold/warm), focus build, prune, deploy, publish, diamond, dev-sim, Next-vs-Vite build, tsc-vs-tsgo, spec-form/node-linker, remote-cache restore-vs-rebuild. Gaps:

1. Direct lockfile measurement at 10k/20k — lines, MB, and pnpm parse time per install. Lockfile *size* is measured through 4,000 apps (`results.json`); the resolve-vs-verify split (`lockfile-bench`) goes to 2,000; the 20k figure in §1 is extrapolated from the 200→4,000 trend.
2. `node-linker=pnp` full-tree footprint — the isolated and hoisted full-tree `node_modules` counts are now measured (TOOLING.md); `pnp` is not.
3. Turbo graph-load floor — `turbo run build --dry` time (no execution) vs scale, isolated from task time.
4. Foundation-change rebuild *time*: the `test`-task selection is measured by COUNT (`bench/test-axis-bench.json`: foundation re-tests 1,200 vs a leaf's 21 at 1,000:200), and its cold wall-clock bounds Turbo orchestration + node startup (14.3s vs 3.0s) — but over trivial smoke bodies; the remote-cache side is measured at 300:100 (a universal-foundation edit restores 0 of 500 and recomputes the lot, ~26s — see "Remote cache: amortizing the O(repo) cold start"). Still open: real test-suite runtime, the *build* wall-clock (count 1,080), and the cold wall-clock at the 1,080-package scale.
5. `pnpm install --filter app...` at scale. Its materialization scoping is confirmed (1 of 80 apps linked, `focus-install-bench`); the open part is install time + footprint vs `turbo prune` at 10k/20k.
6. `node-linker=pnp` — install time + footprint + tooling compatibility vs isolated/hoisted.
7. Cold onboarding — fresh `git clone` + `pnpm install` for a new dev at 10k/20k.
8. Peak memory under `--concurrency=100%` typecheck/build (OOM risk: 64 × tsc/next workers).
9. tsserver/IDE project-load time + RSS at scale (semi-manual).

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

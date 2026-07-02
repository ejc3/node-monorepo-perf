# Limits and gotchas at 20k apps

What focus/cache/`--affected` cannot save you from, what still needs measuring, and the gotchas this build hit.

## What breaks at 20k that you cannot fully work around

These are irreducibly O(repo): scoping and caching reduce *execution*, but the cost remains because it is inherent to having one workspace graph and one lockfile.

1. **The single lockfile.** One `pnpm-lock.yaml` describes the whole workspace. Measured growth: 9,897 → 153,967 lines across 300 → 4,300 packages (≈36 lines per added package); extrapolating ~linearly, that is multi-MB and ~720k lines at 20,000 packages. Every install reads it and (on any dep change) rewrites it, and every branch that touches deps creates a merge-conflict surface. You cannot `--filter` the lockfile — it is global. Mitigations trade away its value: `shared-workspace-lockfile=false` (per-package lockfiles, losing cross-package dedup) or git-branch lockfiles (avoids conflicts, not size).

2. **The Turbo graph-load floor.** `--filter`, `--affected`, and `prune` all parse every `package.json` and build the full dependency DAG *before* selecting a subset. That load is O(repo) on every invocation, including no-ops. Measured: a fully-cached `turbo run typecheck` (Turbo hashing the tracked source) grew 1.5s → 20.5s (200 → 4,000 apps). At 20k the per-command floor is tens of seconds before any task runs. You cannot filter below the graph load. The only escape is to stop having one graph (shard), which gives up atomic cross-package changes.

3. **Foundation/root-change blast radius = the whole repo.** A change to a widely-used lib, or to a root input in every task's hash (`tsconfig.base.json`, the catalog's React/Next version, the pnpm/turbo/next version), invalidates the cache for all dependents. Measured: editing low-layer `lib-003` rebuilds 1,080 of 1,200 packages; at 20k that is ~18k packages. The same shape holds for the `test` task (`bench/test-axis-bench.json`, 1,000:200): editing a universal foundation lib re-tests every package (1,200 of 1,200) while a leaf-lib edit re-tests only its dependents (21) — a ~57× blast spread (1,200 / 21); `--filter=...<lib>` (the git-free `--affected` stand-in) selects exactly that set. (The cold wall-clocks — 14.3s for the 1,200 vs 3.0s for the 21 — are over trivial smoke bodies, so they bound Turbo orchestration + `node --test` startup, not real suite runtime; the count is the evidence.) Remote cache only helps the *second* consumer of an artifact — someone still computes the cold rebuild, and `--affected` cannot help when everything is affected: a fresh runner restores **486 of 500** tasks from a remote cache after a *leaf* edit, but **0 of 500** after a *universal-foundation* edit (`bench/ci-cache-bench.json`, 300:100; see "Remote cache: amortizing the O(repo) cold start" below). The lever for the unavoidable whole-repo case is sharding the independent test tasks across machines (1,200 → 150/shard at 8 shards, arithmetic). This is organizational (change foundations rarely), not a technical fix.

4. **Materializing the whole tree (inodes/disk).** Installing all 20k apps creates a `node_modules` per package. Isolated-linker symlinks measured 4,211 at 300/100 (full-tree) → hundreds of thousands at 20k, plus the `.pnpm` store. Building all apps' output: 40 Next apps = 156 MB → 20k ≈ 78 GB of `.next`; inodes can exhaust a modest filesystem. Focus (prune/deploy) avoids this per-app, but a full local checkout or a build-everything CI job pays it. Levers: `node-linker=pnp` (no `node_modules`), don't build everything.

5. **Editor / language server.** Opening *one app* is O(closure), not O(repo) — measured: the language server's project-load tracks the opened app's dependency closure (65 libs / 1,123 files), flat as the repo grows 8× (see "Editor / language server, measured" below; tsgo's native LSP opens that closure ~19× faster than tsserver — 86ms vs 1.6s — and with ~30% less memory). But opening the *whole* workspace as a single project at 20k is genuinely O(repo): a multi-GB program with slow cross-package IntelliSense/go-to-def. Mitigations (open a sub-tree, sparse-checkout, pnp + editor SDK) scope it back to a closure; they are partial only if you must hold the whole graph open at once.

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

"No-cache cold" is pure compute with no remote configured — what every runner pays without a shared cache. "Remote-restore" is a fresh runner (empty local cache, no build outputs) restoring everything from the remote-only cache. Restore is essentially the fully-cached warm run (this bench's warm-local floor is 1.8s / 5.2s vs restore 1.9s / 5.9s at the two scales; the small gap is the ≤0.5 MB download), and §2 shows that floor is itself O(repo): restore skips task *execution* but still pays Turbo's per-command graph-load + hashing (a fully-cached typecheck reaches 20.5s at 4,000 apps). So restore grows with the repo too (1.9s → 5.9s, 300 → 1,000 apps), and stays ~11–12× under the cold compute because it skips execution — not because it is byte-bound. The speedup therefore **holds** (12.5× → 11.4×) rather than widening as the repo grows, while the absolute time saved grows (21.7s → 61.3s). (typecheck is the realistic CI job here: `typecheck dependsOn ^build`, so a cold typecheck also builds the lib dists; its cached artifacts are those dists plus empty typecheck markers — 0.2–0.5 MB. A `build` run also caches every app's `.next`, so a fresh runner downloads 247 MB for 400 packages; the build cell's cold is a single sample, the typecheck cells medians of two.)

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

## Editor / language server, measured

Opening the monorepo in an editor pays a cost the build benches don't capture: before it can answer a keystroke, the language server loads a project. This races the two servers a developer actually uses — `tsserver` (what VS Code ships) and `tsgo --lsp` (TypeScript's native-preview LSP) — opening one app's `page.tsx` (which imports several libs) and timing the felt cold open (spawn → first go-to-definition, startup included), the warm keystroke loop, and peak memory. Cross-package navigation resolves to source build-free (tsconfig `paths` → `packages/*/src`, no `baseUrl`), so opening the app pulls its real dependency closure (65 libs / 1,123 files at 4,000:300) into the server — the heavy case, not declaration stubs (`bench/editor-loop-bench.json`; tsgo `7.0.0-dev.20260614.1`, TypeScript 5.9.3; 64-core box; cold open the median of 3 fresh-process runs, warm ops the median of 5):

| metric                        | tsserver | tsgo LSP | ratio |
| ----------------------------- | -------- | -------- | ----- |
| cold open (spawn → first def) | 1,620ms  | 86ms     | 18.8× |
| peak RSS                      | 380MB    | 275MB    | 1.4×  |
| warm go-to-def                | 1ms      | 0ms      | —     |
| warm hover                    | 1ms      | 2ms      | —     |

(4,000 apps / 300 libs.) The whole difference is in the **cold open**: tsgo loads the same closure ~19× faster and with ~30% less memory. Once warm, both answer go-to-def and hover in ≤2ms — the per-keystroke ops are not the bottleneck, project load is. Both resolve the cross-package definition to the exact lib source (`packages/lib-026/src/index.ts`) with zero fatal diagnostics, so this is a working editor, not a broken one. (Completion is not a like-for-like latency race — at the same position the servers return different completion-set sizes, tsgo 6,247 items vs tsserver 1,009 — so it is recorded with its item count, not scored.)

**It is O(closure), not O(repo) — the same shape as the rest of the stack**, shown from both sides:

- **Apps grow, closure fixed** (300 libs; 500 → 4,000 apps): the opened app's closure stays 65 libs / 1,123 files (asserted identical across the sweep), and the cost is flat — tsserver cold open 1,619 → 1,614 → 1,620ms, RSS ~380MB; tsgo 84 → 86ms. 8× the repo, ~1.0× the cost ⇒ the editor does **not** load the repo.
- **Closure grows** (2,000 apps; 100 → 200 → 300 libs): the opened app's closure grows 628 → 1,033 → 1,123 files, and the cost rises with it — tsserver cold open 1,393 → 1,561 → 1,614ms, peak RSS 355 → 380MB; tsgo 80 → 84ms, 238 → 272MB. Cost tracks the closure ⇒ O(closure).

So the editor's project-load cost is bounded by what one app imports, not by repo size — the same lever as everywhere else: scope the open to one app's closure, and a faster server (tsgo's native LSP) cuts the one cost that scales by ~19×. The ceiling (§1, item 5) is unchanged: opening the *whole* workspace as a single project at 20k still means a multi-GB, repo-sized program — the escape is to not open it all at once.

## What we should still quantify

Measured so far: gen, install (cold/warm/truly-cold; pnpm-isolated/hoisted/bun/yarn-nm/yarn-PnP; plus the five-way frozen CI-runner install incl. npm in fresh podman containers, `container-install-bench.json`), typecheck (cold/warm), focus build, prune, deploy, publish, diamond, dev-sim, Next-vs-Vite build, tsc-vs-tsgo, spec-form/node-linker, remote-cache restore-vs-rebuild, editor project-load + RSS (tsserver vs tsgo LSP). Gaps:

1. Direct lockfile measurement at 10k/20k — lines, MB, and pnpm parse time per install. Lockfile *size* is measured through 4,000 apps (`results.json`); the resolve-vs-verify split (`lockfile-bench`) goes to 2,000; the 20k figure in §1 is extrapolated from the 200→4,000 trend.
2. Turbo graph-load in isolation — `turbo run build --dry` time (planning only, no execution or cache restore) vs scale, distinct from §2's measured fully-cached floor (which also pays the cache restore).
3. Foundation-change rebuild *time*: the `test`-task selection is measured by COUNT (`bench/test-axis-bench.json`: foundation re-tests 1,200 vs a leaf's 21 at 1,000:200), and its cold wall-clock bounds Turbo orchestration + node startup (14.3s vs 3.0s) — but over trivial smoke bodies; the remote-cache side is measured at 300:100 (a universal-foundation edit restores 0 of 500 and recomputes the lot, ~26s — see "Remote cache: amortizing the O(repo) cold start"). Still open: real test-suite runtime, the *build* wall-clock (count 1,080), and the cold wall-clock at the 1,080-package scale.
4. `pnpm install --filter app...` at scale. Its materialization scoping is confirmed (1 of 80 apps linked, `focus-install-bench`); the open part is install time + footprint vs `turbo prune` at 10k/20k.
5. PnP tooling compatibility, and pnpm's own `node-linker=pnp`. Yarn PnP's install time + footprint are measured (TOOLING.md: 3.2s cold at 2,000 apps, 64 materialized entries + a 3.5 MB `.pnp.cjs`); still open are how the repo's toolchain (Next, tsc/tsgo, editors) behaves under PnP resolution, and pnpm's pnp linker.
6. Cold onboarding — fresh `git clone` + `pnpm install` for a new dev at 10k/20k.
7. Peak memory under `--concurrency=100%` typecheck/build (OOM risk: 64 × tsc/next workers).

## Gotchas this build hit

- Turbo input hashing **and** `turbo prune` respect `.gitignore`; generated, gitignored source is invisible to both (`--use-gitignore=false` for prune; move `.gitignore` aside for dev-sim).
- `catalog:` entries in `pnpm-workspace.yaml` are read only by pnpm — Vercel's framework detector, npm, bun, and yarn do not read them ("No Next.js version detected"; bun ignores it). bun and yarn 4 have their own catalog support, authored in `package.json` (bun measured in `bench/wave-rollout-bench.json`; yarn's is not exercised here).
- `turbo prune` does not copy root configs packages reference via `../../` (e.g. `tsconfig.base.json`).
- `pnpm install --filter app...` scopes what it *materializes* (1 of 80 apps linked, `focus-install-bench`) but still resolves the one shared, whole-workspace lockfile; for a self-contained per-app lockfile use `pnpm deploy` / `turbo prune`.
- `workspace:*` deploys the in-tree source at its local version, not a published version (rewrite happens only on `pnpm publish`).
- bun ignores `pnpm-workspace.yaml` (needs `package.json` "workspaces") and uses a hoisted layout.
- Don't carry `eslint: { ignoreDuringBuilds: true }` from webpack-era configs — the generated Next 16 config omits the `eslint` key entirely; if you want lint, run it as a separate Turbo task, not inside `next build`.
- `spawnSync` buffers child output in memory → ENOBUFS at scale; pipe to a file instead.
- Even a fully-cached `turbo run` is O(repo) (graph load + hashing).

# Tooling comparisons: install and build

## Install: bun vs pnpm vs yarn 4 (`scripts/install-bench.mjs`)

Environment in `bench/env.json` (Neoverse-V1, 64 cores, 135 GB). Each manager runs at its own workspace default plus, for pnpm and yarn, the alternate linker: pnpm-isolated (pnpm's default) and pnpm-hoisted (flat); bun's workspace default, which since bun 1.3 is the isolated layout (a `node_modules/.bun` store — its entry counts land near pnpm-isolated's, not the flat layouts'); yarn 4.17.0 under `node-modules` (flat — the layout match for pnpm-hoisted) and under PnP (yarn's default: no `node_modules` at all, a `.pnp.cjs` resolution table over global-cache zips, with only native packages materialized under `.yarn/unplugged`).

The three states: **cold** = no lockfile present (full resolve + link against the warm content store — package content is already local, though the network is not blocked and each tool may still revalidate registry metadata per its own policy); **warm** = lockfile present, `node_modules` removed (relink); **truly-cold** (the pass below the table) = the network-cold case.

Reset discipline: each scale is generated fresh, the whole `node_modules` tree (root + every per-package dir), yarn's `.pnp.*`/`.yarn` project state, and the lockfile are removed before each measurement, and each tool's global store is pre-warmed once so a "cold" install reflects warm-store work rather than a cache-order artifact. Each tool's ambient config env (`YARN_*`, `BUN_*`, `PNPM_*`, `npm_config_*`) is stripped for its timed runs so a stray host setting can't silently move or disable its cache. Every install is verified complete afterward — every app and lib must resolve all its declared dependencies and devDependencies (for PnP, through the `.pnp.cjs` resolver, with each resolved zip present and non-empty on disk) — or the bench throws.

Columns: CPU% and peak RSS are from `/usr/bin/time -v`; `nm entries` is the full-tree `node_modules` footprint (root virtual store + every per-package tree). yarn-PnP's 64 entries are its unplugged native packages (sharp, `@img/*`, `@next/swc`); its resolution table `.pnp.cjs` is 0.8–3.5 MB across these scales.

| scale | manager | cold | warm | CPU | peak RSS | nm entries |
|---|---|---|---|---|---|---|
| 200 / 100 | pnpm isolated | 47.8s | 2.3s | 130% | 779 MB | 15,691 |
| | pnpm hoisted | 46.7s | 1.4s | 131% | 903 MB | 12,246 |
| | bun | 0.13s | 0.12s | 225% | 43 MB | 15,409 |
| | yarn node-modules | 3.2s | 2.8s | 152% | 933 MB | 11,210 |
| | yarn PnP | 1.7s | 1.3s | 143% | 610 MB | 64 |
| 1,000 / 200 | pnpm isolated | 229.5s | 7.3s | 134% | 938 MB | 31,123 |
| | pnpm hoisted | 227.3s | 3.0s | 133% | 992 MB | 16,578 |
| | bun | 2.2s | 2.6s | 42% | 73 MB | 29,941 |
| | yarn node-modules | 4.4s | 4.0s | 158% | 1,017 MB | 12,110 |
| | yarn PnP | 2.3s | 2.1s | 151% | 666 MB | 64 |
| 2,000 / 300 | pnpm isolated | 471.2s | 15.2s | 141% | 1,023 MB | 50,159 |
| | pnpm hoisted | 456.7s | 4.7s | 142% | 1,161 MB | 21,914 |
| | bun | 7.5s | 9.5s | 26% | 97 MB | 47,877 |
| | yarn node-modules | 6.2s | 5.9s | 153% | 1,093 MB | 13,210 |
| | yarn PnP | 3.2s | 2.9s | 149% | 723 MB | 64 |

Truly-cold (each tool's content store and registry metadata redirected to a fresh scratch dir, real network — and no lockfile, so this includes the full resolve) at 200/100: pnpm-hoisted 24.0s, bun 1.2s, yarn node-modules 9.3s, yarn PnP 7.7s. This downloads every package and its metadata, so it is network-bound and a single sample per tool, taken sequentially in the fixed order pnpm → bun → yarn-nm → yarn-PnP — a network path warmed by the earlier tools' downloads can favor the later ones. It is a different starting state from the warm-store cold column above (which links from the host's shared store), and not directly comparable to it. bun is fastest here; treat the exact multiples as approximate.

Reading it:
- pnpm cold install is ~linear in package count (47.8s → 471.2s, 10× apps); bun has a far smaller constant (0.13s → 7.5s) — roughly 357× faster cold than pnpm's default isolated at 200/100, ~103× at 1,000, ~62× at 2,000 (pnpm-hoisted is within ~3% of isolated, so its ratios track). The gap isn't just a warm cache: truly-cold (fresh store + metadata, real network) bun stays faster (1.2s vs 24.0s in one sample), though that path is network-bound — see the note above.
- yarn's cold cost grows much more slowly than pnpm's (3.2s → 6.2s node-modules; 1.7s → 3.2s PnP), so the bun-vs-yarn ordering flips with scale: bun is faster at 200 apps (0.13s vs 1.7s) and effectively tied with yarn-PnP at 1,000 (2.24s vs 2.32s), while at 2,000 apps **yarn is the fastest cold install** — PnP 3.2s and node-modules 6.2s vs bun's 7.5s.
- Warm relink (lockfile present) is where the linker shows up: pnpm-hoisted relinks in 4.7s at 2,000 vs pnpm-isolated's 15.2s — recreating the isolated symlink farm is a real warm-relink cost. bun's warm (9.5s) lands above its cold (7.5s) at 2,000. yarn-PnP's warm is the fastest at 1,000 and 2,000 apps (2.1s, 2.9s) — with no `node_modules` to materialize, warm is mostly rewriting `.pnp.cjs`.
- Cold install time is within ~3% across pnpm isolated/hoisted (resolution-bound); the isolated layout's costs are footprint (50,159 vs 21,914 `node_modules` entries at 2,000) and that warm-relink time, not cold-install time.
- Footprint: yarn-PnP materializes almost nothing per project (64 unplugged entries + a 0.8–3.5 MB `.pnp.cjs`; packages stay zipped in the shared global cache). Among the `node_modules` layouts at 2,000 apps, yarn-nm writes the fewest entries (13,210), pnpm-hoisted 21,914, bun/pnpm-isolated ~48–50k.
- bun's cold CPU% collapses with scale (225% → 42% → 26%): at 2,000 apps most of bun's cold wall time is blocked on filesystem work, consistent with materializing its isolated layout (its ~48k `node_modules` entries at 2,000 apps sit near pnpm-isolated's 50k). Its warm single samples land slightly above its cold at 1,000 and 2,000 apps (2.6s vs 2.2s; 9.5s vs 7.5s) — sub-10s single runs whose ordering is within run-to-run variation.
- pnpm shows a reverse surprise: its truly-cold install below (24.0s — empty store, empty metadata cache, real downloads) undercuts its warm-store cold here (46.7s, same scale and linker). The difference tracks the registry-metadata cache, not the content store: a no-lockfile resolve against a warm metadata cache re-parses large cached full packuments (the cached `next` packument alone is 25 MB) at full CPU, while a metadata-cold resolve fetches the far smaller abbreviated packuments from the registry. With the lockfile committed (the warm row and every frozen install) no resolve happens and none of this cost is paid.
- pnpm and yarn use ~1.3–1.6 cores (install is largely serial) with ~0.6–1.2 GB peak RSS; bun stays under 100 MB. Each figure is a single measured run (large installs are measured once), taken in a fixed per-scale order — pnpm isolated, pnpm hoisted, bun, yarn nm, yarn PnP — recorded in the JSON.

Methodology:
- bun and yarn ignore `pnpm-workspace.yaml` and the pnpm `catalog:` protocol, so the bench runs a decataloged copy carrying both a `pnpm-workspace.yaml` (which pnpm reads) and a `package.json` `"workspaces"` field (which bun and yarn read) — a like-for-like dependency set.
- Two layout families are in play: isolated stores that prevent phantom dependencies (pnpm-isolated's symlinked virtual store; bun's `node_modules/.bun`, its workspace default) and flat trees (pnpm-hoisted, yarn-nm). yarn PnP is stricter still — no `node_modules`, resolution only through declared edges — and that contract is also its compatibility cost, measured below ("yarn PnP toolchain compatibility, priced"): tsc/turbo/oxlint run under PnP on this stack; tsgo and `next build` do not. pnpm also ships its own pnp linker, not measured here (LIMITS gap #5).
- yarn is the pinned 4.17.0 standalone CLI from the `@yarnpkg/cli-dist` tarball run as `node yarn.js`, with `enableImmutableInstalls`/`enableHardenedMode` pinned off (both are CI-conditional defaults that would change the measured work), `enableGlobalCache` pinned on (its default), and `enableScripts: false` pinned (yarn 4's own default). Dependency build scripts are blocked by default on pnpm 10 and yarn 4 alike; bun blocks them except for its built-in allowlist.
- Install only; Next/Vite/tsc run on Node either way.

## yarn PnP toolchain compatibility, priced (`scripts/pnp-compat-bench.mjs`)

The PnP compatibility cost stated qualitatively above, measured on this repo's own stack: one
generated workspace (20 apps / 10 libs) installed twice by the same pinned yarn — PnP and
node-modules (the control) — with every tool run through yarn in both trees. A tool that fails
both trees is a scaffold problem (the bench hard-fails); a tool that passes the control and
fails under PnP is the finding (`bench/pnp-compat-bench.json`).

| tool | under PnP | under node-modules (control) |
|---|---|---|
| oxlint (whole tree) | works | works |
| tsc (lib build; yarn's builtin TypeScript patch) | works | works |
| turbo focused typecheck (build closure + typecheck) | works | works |
| tsgo | **fails** (`TS2503: Cannot find namespace 'React'` and `TS2307: Cannot find module '@demo/lib-06'` — neither `@types` discovery nor workspace-import resolution goes through PnP) | works |
| `next build` | **fails** (`We couldn't find the Next.js package (next/package.json) from the project directory` — Turbopack cannot locate the next package in a tree with no node_modules to walk; the failure persists with `turbopack.root` explicitly pinned in both trees) | works |

So yarn-PnP's install wins carry a concrete boundary on this stack: the classic pipeline
(tsc + turbo + oxlint) runs unchanged, and the stock optimal-stack tools (the pinned tsgo,
Next's default Turbopack build) do not run under PnP — under yarn's node-modules linker no
such caveat applies.

### Closing the gap: native PnP for tsgo, and Next under PnP (`scripts/tsgo-pnp-bench.mjs`)

The two failures above are the native binary and the native bundler: neither loads Yarn's
runtime `require()` shim, so neither resolves through PnP. Both have a path to green,
measured on a workspace installed at Yarn's PnP defaults (the manifest inlined in `.pnp.cjs`,
no `.pnp.data.json` sidecar) with the node-modules linker as the control
(`bench/tsgo-pnp-bench.json`). The app imports a workspace lib, a leaf npm package (`react`,
a plain cache zip), and a package Yarn virtualizes for its peer dependency (`react-dom`, under
`.yarn/__virtual__`), so all three resolution shapes are exercised.

**tsgo:** a native PnP resolver added to tsgo ([microsoft/typescript-go#460](https://github.com/microsoft/typescript-go/issues/460))
reads the manifest, keeps package locations in Yarn's `__virtual__` space (so the resolver
identifies the owning package of an import made from inside a virtualized package), and serves
package files straight from the cache `.zip` archives, dereferencing `__virtual__` paths at the
filesystem read. Same tree, same tsconfig:

| checker | under PnP | under node-modules (control) |
|---|---|---|
| stock tsgo (`@typescript/native-preview`) | **fails** — 3× `TS2307`, 67 files in program (react, react-dom, the workspace lib unresolved) | 0 errors, 83 files |
| tsgo + PnP resolver (the PR) | 0 errors, 83 files — matches the control | 0 errors, 83 files |

A seeded type error still surfaces (`TS2322`) under PnP, so the checker type-checks through
PnP-resolved modules rather than skipping them.

**Next.js:** `next build` succeeds under PnP on the **webpack builder** (`next build --webpack`,
run through yarn so the PnP runtime is injected — webpack 5 resolves PnP natively). Turbopack,
the Next 16 default, has no PnP resolver ([vercel/next.js#42651](https://github.com/vercel/next.js/issues/42651),
"not planned") and fails with the `next/package.json` resolution error. Measured:

| `next build` | PnP | node-modules (control) |
|---|---|---|
| webpack builder | builds | builds |
| Turbopack (default) | **fails** (`couldn't find the Next.js package`) | builds |

So the fully-green PnP configuration is **tsgo-with-PnP + `next build --webpack`**; teams that
require Turbopack use Yarn's node-modules (or pnpm) linker, under which both the stock tsgo and
Turbopack already work.

### Specifier form and node-linker (`scripts/perf-matrix.mjs`)

Does the `workspace:` spec form or the linker mode change install perf? Cold install at 300/100:

| variant | install | nm entries | symlinks |
|---|---|---|---|
| `workspace:*`, isolated (baseline) | 71.4s | 18,081 | 4,211 |
| `workspace:^x.y.z`, isolated | 71.8s (+0.5%) | 18,081 | 4,211 |
| `workspace:*`, hoisted | 69.0s (−3.4%) | 13,304 | 1,459 |

The specifier form is install-neutral (a 0.5% single-run difference; identical `node_modules` and lockfile line count, the versioned variant's lockfile marginally larger in bytes from its explicit version strings). node-linker barely changes install *time* here (resolution-bound), but the isolated layout has ~3× more symlinks (4,211 vs 1,459, full-tree) and ~36% more `node_modules` entries — the inode cost that grows with package count. So choose the form for publish semantics and the linker for strictness/footprint, not for install speed.

## The CI-runner install: frozen, in a fresh container (`scripts/container-install-bench.mjs`)

What a real CI runner actually pays — a checkout carrying the **committed lockfile**, installed frozen
(`pnpm --frozen-lockfile`, `bun --frozen-lockfile`, `yarn --immutable`, `npm ci`) — measured in true
isolation: every sample runs in a fresh rootless-podman container (hermetic env, digest-pinned node
image with the pinned toolchain baked in), at 1,000 apps / 200 libs, median of 5 samples in a
round-rotated tool order (every tool takes every position once). Two variants: **fresh runner** =
empty caches, real network (registry metadata + downloads); **cache restored** = the tool's
store/cache persisted in a volume across samples, pre-warmed once and asserted populated. npm is
included as the baseline (npm has no `workspace:` protocol, so its tree carries `*` for internal
deps; its lockfile is asserted to link them locally, not from the registry). pnpm runs its
default isolated linker here; install-bench's warm rows show the hoisted linker relinks faster
at this scale, and it is not measured in containers.

| tool | fresh runner | cache restored | fresh CPU | fresh peak RSS |
|---|---|---|---|---|
| bun | **0.9s** | **0.4s** | 420% | 288 MB |
| yarn PnP | 4.4s | 2.2s | 269% | 3,087 MB |
| yarn node-modules | 6.5s | 4.2s | 233% | 3,133 MB |
| pnpm | 8.9s | 7.0s | 189% | 1,392 MB |
| npm | 10.4s | 9.7s | 131% | 387 MB |

Reading it:
- **bun wins this case outright** — 0.9s fresh (10× pnpm, 12× npm) and 0.4s with a restored
  cache. The warm-store yarn-overtakes-bun crossover in the table above does not appear here.
  Across the two harnesses at 1,000 apps, yarn-PnP and pnpm reproduce (2.1s↔2.2s;
  9.2s↔8.9s) while bun's container cells land well below its host warm row (0.4s vs 2.6s) —
  both datasets stand as recorded; the frozen flag and the container filesystem differ from
  the host warm pass.
- A restored dependency cache helps each tool differently: bun −56%, yarn-PnP −51%, yarn-nm −35%,
  pnpm −21%, npm −7%. The lockfile (not the cache) is what removes the resolve; the cache only
  removes downloads.
- The **fail-closed contract holds on all five**: a drift rung mutates a manifest and every
  tool rejects it (exit 1) with the lockfile untouched (`failClosed`).
- pnpm's 8.9s fresh corroborates `install-modes-bench`'s host-side "frozen, cold store" 9.2s at
  the same scale — two independent harnesses, one number.
- Spreads are tight (bun 890–900ms; pnpm 8.7–9.0s across 5 network-live samples), and the samples
  share a warmed CDN edge after the first fetch — a genuinely different network path can be slower
  than these medians.

Methodology: the workspace and the tool's store/cache are **subdirectories of one mounted volume**
— `link(2)`/`FICLONE` fail `EXDEV` across two mounts even on one backing filesystem, so any
two-mount geometry silently forces pnpm/bun into their per-file copy fallback (pnpm's own
copy-fallback warning is captured per cell as evidence the link path held: `copyFallbackSeen:
false` everywhere). Lockfiles are authored in-container by the pinned tools, so no host tool
version or rc file can shape them. Lifecycle scripts run at each tool's default (npm runs them;
pnpm 10 and yarn 4 block; bun allowlists) — disclosed in the JSON notes; the timed window is
measured inside the container by GNU time, with the tree copy, verification (the shared
`_verify-install.cjs` contract), and lockfile-hash check outside it.

## Build: Next vs Vite (`scripts/build-bench.mjs`)

Full `turbo run build` of 40 apps + 24 libs, concurrency 12, 64-core machine. Next is App Router (SSR/RSC); Vite is a client SPA, so this compares build tooling and output, not equivalent features.

| framework | build (all 40 apps) | CPU | peak RSS | total output |
|---|---|---|---|---|
| Next (App Router) | 17.2s | 2798% (~28 cores) | 741 MB | 156.8 MB (`.next`) |
| Vite (SPA) | 7.6s | 1187% (~12 cores) | 193 MB | 7.7 MB (`dist`) |

Vite builds ~2.3x faster and emits ~20x less output for these tiny apps. That is expected: `.next` includes server/RSC bundles and per-route artifacts, while Vite emits a static client bundle; Next also parallelizes across more cores. If you need SSR/RSC/server actions you pick Next regardless. At thousands of apps the framework's per-build time matters less than not building unchanged apps — the affected-closure rule applies the same way to both.

## Lint: ESLint vs oxlint (`scripts/lint-bench.mjs`)

oxlint (native Rust, from oxc) reimplements a large subset of the ESLint ecosystem's rules, and this repo uses it as the linter. This races it against ESLint on one generated corpus (800 `.ts`/`.tsx` modules), matched so the number reflects engine speed, not coverage breadth. oxlint runs **standalone** at its full native capability — all plugins + all categories (and, for the type-aware row, `--type-aware` via `oxlint-tsgolint`). ESLint is pointed at *oxlint's own rule set*: `eslint-plugin-oxlint` publishes the exact map of which ESLint rules oxlint covers, and the bench inverts it to turn those rules on in ESLint with the matching plugins registered. ESLint runs a **strict subset** of what oxlint covers — the 524 rules with an ESLint port that aren't type-checked — so it does no *more* work than oxlint, which keeps the ratio conservative. (The two rule counts, 524 ESLint-side and oxlint's own 567, are recorded but aren't a like-for-like tally: an oxlint rule and an ESLint rule don't map 1:1, so the load-bearing claim is "ESLint runs a subset," not "567 > 524.")

Two things shape the wall-clock:

- **oxlint is multithreaded; ESLint is single-process.** These are wall-clock numbers on a 64-core box (`bench/env.json`), so the ratio is amplified by core count — on fewer cores the gap narrows. Parallelism is a real oxlint capability, not a measurement artifact, but the *magnitude* of the speedup is core-dependent.
- **The type-aware row is mostly a type-checker comparison, not a linter comparison** (detailed below): both tools build a TypeScript program to get type information, and the speedup is dominated by tsgo-vs-tsc.

(`oxlint` 1.71.0, `eslint` 9.39.4, `typescript-eslint` 8.62.0, `oxlint-tsgolint` 0.23.0.)

| pass                        | ESLint               | oxlint                | ratio |
| --------------------------- | -------------------- | --------------------- | ----- |
| syntactic, no cache         | 12,032ms (524 rules) | **190ms** (567 rules) | 63.3x |
| syntactic, ESLint `--cache` | 1,923ms              | **190ms**             | 10.1x |
| type-aware                  | 4,489ms              | **397ms**             | 11.3x |

A like-for-like parity proof gates the run: a fixture seeded with five rules both tools implement, and the run hard-fails unless both flag *exactly* that set — so the speed numbers can't come from one tool quietly doing less. Each timed run is also checked to have exited with a lint code and linted all 800 files.

**Syntactic.** oxlint lints the 800-file tree in **190ms**; ESLint, running the smaller matched set, takes **12.0s** without `--cache` and **1.9s** with its persistent `--cache` warmed. oxlint has no persistent cache — its single run is **10.1x** faster than even ESLint's warm-cache run and **63.3x** faster than ESLint without `--cache`. Both are wall-clock on a 64-core box, and oxlint's parallelism is part of why it wins, so the ratio would be smaller on fewer cores. (oxlint reported 18,793 findings to ESLint's 22,349 — different rule sets, so the counts are recorded, not raced.)

**Type-aware — the gap that closed.** The rules that need type information (`no-floating-promises`, `no-misused-promises`, `await-thenable`, …) used to be ESLint-only; `tsc` does not flag an un-awaited promise. oxlint now does them too, through `oxlint-tsgolint` (alpha; **59 of 61** typescript-eslint type-aware rules; requires TypeScript 7+). `oxlint --type-aware` checks the tree — its full native set *plus* the type-aware rules — in **397ms**; ESLint's type-checked pass takes **4.5s**, **11.3x** slower. The gap here is mostly the **type-checker underneath, not the lint engine**: both tools must build the TypeScript program to get type information — `oxlint-tsgolint` builds it with tsgo (TS7), typescript-eslint builds it with tsc 5.9, and tsgo alone is ~12x faster than tsc at whole-program typecheck (`bench/typecheck-bench.json`, [TYPECHECKERS](TYPECHECKERS.md)). So this row largely re-measures that substrate difference; ESLint is not uniquely slow at building the program. Both flag the seeded floating promise (asserted). `oxlint-tsgolint` is alpha — pin it, and treat its coverage as a moving target.

**What ESLint is still for.** Run `eslint-plugin-oxlint` to turn off the rules oxlint covers, and ESLint lints only the *residual* — rules with no oxlint port. On this corpus the residual found **0** (its seeded violations are all oxlint-covered). In practice that residual is the handful of plugin rules oxlint has not ported yet; the layered setup — oxlint on the hot path, a thin ESLint pass for the rest — is the migration path, and with the type-aware alpha covering 59/61 type-aware rules it keeps shrinking.


## Vite+ (`vp`): the task runner and tool layer, priced (`scripts/vite-task-bench.mjs`, `scripts/vite-plus-tools-bench.mjs`)

Vite+ is VoidZero's unified toolchain CLI — one `vp` binary wrapping Rolldown-powered Vite,
Vitest, Oxlint, and **Vite Task**, a Rust monorepo task runner that competes directly with
Turborepo. It went MIT with the March 2026 alpha and stayed MIT through Cloudflare's
acquisition of VoidZero ([beta announcement](https://voidzero.dev/posts/announcing-vite-plus-beta),
[license](https://voidzero.dev/posts/voidzero-cloudflare)); v0.2.2 (beta) is measured here.
Remote caching is on its 1.0 roadmap and unshipped, so nothing below compares against
`ci-cache-bench`'s remote-restore economics.

### Task orchestration: Vite Task vs Turborepo (`bench/vite-task-bench.json`)

The two runners execute the identical dep-free `typecheck:tsgo` task set (same generated
DAG, same tsgo binary, same pnpm-installed tree, concurrency pinned to 64 on both,
cold/warm asserted from each runner's own summary). The mechanism difference is the
finding: turbo hashes **declared inputs** and respects `.gitignore` (its rungs run under
the source-visibility workaround); Vite Task **fs-traces what each task actually reads**
(LD_PRELOAD/seccomp) — it cached the fully gitignored generated tree with zero config
(probed with `git check-ignore`, all-cached warm asserted).

| rung (whole repo / focused) | turbo 2.9.18 | vp 0.2.2 |
|---|---|---|
| whole cold, 300:100 (400 tasks) | **8.7s** | 27.0s (~3.1× — tracing overhead is per-task) |
| whole cold, 1,000:200 (1,200 tasks) | **31.5s** | 117.3s (~3.7×) |
| whole warm, 300:100 / 1,000:200 | **1.8s / 5.0s** | 3.7s / 10.8s (~2×) |
| focused cold (one app + closure) | 2.2s / 3.4s | **1.8s / 1.8s** |
| focused warm, 300:100 / 1,000:200 | 1.2s / 3.0s | **0.85s / 0.86s** |
| whole-repo `test` (node --test), cold / warm at 1,000:200 | 15.3s / 4.9s | **12.9s / 0.95s** |

The split is clean. Whole-repo typecheck, turbo wins by 2–3.7×: vp pays fs-tracing and
fingerprint verification per task, and that cost scales with each task's traced read set
(the tsgo tasks read their whole source closure; the tiny `test` tasks read almost
nothing, and there vp's warm whole-repo run is 5× *faster* than turbo's). Focused, vp
wins and stays **flat across a 3× repo growth** (400 → 1,200 tasks; 0.85s → 0.86s) while turbo's focused
warm grows with the repo (1.2s → 3.0s — the graph-load + hashing floor LIMITS.md
documents as O(repo)); vp's focused loop behaves O(closure).

**Cache correctness on a cross-package edit** (1,000:200, both caches warm, one lib
source file edited): vp recomputed exactly the 559 tasks whose traced reads contain the
edited file — correct closure invalidation with zero task configuration. turbo recomputed
1 of 1,200 — only the edited lib, its 558 dependents left stale — because with the
dep-free task shape both runners compare on, turbo's package-scoped input hashing has no
cross-package edge to propagate through. That is a structural property of the shape, not
a turbo bug: turbo's native mechanisms are `dependsOn: ["^build"]` (propagates through
the build chain, at the price of scheduling builds) or `globalDependencies` (invalidates
everything); per-dependent propagation without one of those is not expressible.

**The tracer's boundary — self-mutating tasks:** vp refuses to cache any task that
writes a file it also read. `next build` is structurally uncacheable under vp (recorded:
`Not cached: read and wrote 'apps/app-0501/.next/server/chunks/...'`), and `vite build`
hits the same refusal under the task cache — while turbo caches the same Next build via
declared outputs (cold 11.0s → warm 3.6s for one app's closure). `tsc --noEmit` with
`incremental: true` is likewise refused (it rewrites its own `.tsbuildinfo`); the bench
strips `incremental` so the compared task is side-effect-clean on both runners.

### The tool layer: `vp check` and `vp build` (`bench/vite-plus-tools-bench.json`)

**`vp check --no-fmt`** (oxlint + tsgolint type errors in one pass) vs the same pinned
engines run separately, on a 920-file source-only corpus (positive control: all engines
flag a seeded type error; file counts asserted per run for vp check and oxlint, the tsgo
program's corpus completeness once via an untimed `--listFiles` pass):

| invocation | median |
|---|---|
| `vp check --no-fmt` (one pass) | 2.44s |
| `oxlint --type-aware --type-check` (identical engines, standalone) | **1.88s** |
| this repo's gate shape: `oxlint` + one whole-program `tsgo --noEmit` | **0.77s** (0.34 + 0.43) |

The one-pass wrapper is *slower* than its own engines run standalone, and 3.2× slower
than the optimal-gate shape (a different type-check model — one tsgo program over lib
source vs per-file typed lint — reported as context, not like-for-like).

**`vp build` vs `vite build`** on one generated Vite app (40:24): byte-identical `dist`
(pnpm resolved the core's vite range to the same 8.0.16), so the 856ms-vs-546ms delta is
the `vp` wrapper itself (~1.6×). The task-cached build (`vp run --cache build`) is
refused for input modification — the same tracer boundary as Next.

Net: on this repo's stack the Vite+ integration layer costs time at every measured point
except the focused loop (cold and warm, both scales) and small-read-set tasks, where Vite Task's O(closure)
behavior beats turbo's O(repo) warm floor — and its fs-traced cache is the first measured
runner that is both correct on gitignored source with zero config and correct on
cross-package edits with zero task config, at the price of refusing self-mutating tasks
(both frameworks' bundler builds) and 2–3.7× whole-repo cold/warm overhead.

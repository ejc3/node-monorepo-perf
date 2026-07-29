# The Fleet Preset: a Measured Production Shape

`--preset fleet` generates the workspace shape measured on a production fleet of ~30,000 small Next.js apps sharing 460 TypeScript libraries. The standard generated workspace is uniform by design (every app imports the same number of libs, every lib layer looks the same); the measured fleet is skewed on every axis that drives benchmark behavior. This preset reproduces that skew deterministically: the tree-agnostic operations (`make install/build/typecheck/graph/focus/prune`) and the gate bench run against a real-world shape at real-world scale and stay reproducible (the self-generating bench scripts still scaffold their own layered trees). Sources of record: `bench/fleet-shape.json` (shape targets vs the generated tree), `bench/fleet-gate-bench.json` (the optimal-stack gate on this shape, once run).

```bash
make gen-fleet                 # 30,000 apps / 460 libs, ~1.03M files
make gen-fleet APPS=3000       # same lib graph, scaled-down app count
make fleet-verify              # recompute the tree's graph metrics vs the targets
make fleet-gate-bench          # bun install + tsgo whole-program gate + turbo + oxlint
```

## The Shape

Four structural properties separate the fleet from the uniform `layered` workspace (`--shape skewed` implements them; `--preset fleet` sets the measured scale):

1. **A universal foundation tier that is universal for apps only.** Five libs are imported by ≥97% of apps, while libs average only 1.7 lib deps. (`--universal` under `layered` injects the tier into every lib; `skewed` never force-injects it — a lib imports a foundation lib only through its own dep picks, which is why the foundation carries the highest lib in-degree without being in every lib.)
2. **A popular tier with flat-then-cliff adoption.** 13 libs are imported by more than half the apps, with adoption declining ~93%→50% across the tier, then falling off a cliff into a long tail — a curve a zipf slope cannot produce. Modeled as a per-app bernoulli draw over 10 semi-universal libs (`--popular`).
3. **A bimodal lib graph.** ~40% of libs are dependency-less sinks, while a dense region forms deep, narrow chains — depth up to exactly 15, fat in the 8–15 range — that converge on a small trunk of high-in-degree libs. Modeled with an index-ramped sink rate, near-neighbor chain deps, zipf trunk picks, and a depth cap at the measured max.
4. **Variable app fanout, moderate app size.** Apps take a median of 14 workspace deps (p90 17) with a median dependency closure of 43 libs — tight, because most closures share the same popular core. Apps are ~30 TS files (`--app-modules 28`), not the two-file stubs of the standard workspace, so whole-repo typecheck and lint pay for ~1.03M files at full scale.

`scripts/fleet-shape-verify.mjs --expect fleet` recomputes every metric from the generated `package.json` files on disk and gates them against the measured targets; the committed `bench/fleet-shape.json` shows the current match (15/15 inside tolerance: package counts, fanout median, depth max, and the >25% adoption count land exact; the >50% adoption count is +2; most distribution metrics sit within 15% and the top lib in-degree runs +32% against its ±40% band).

| metric | measured fleet | generated |
| --- | --- | --- |
| apps / libs | 30,000 / 460 | 30,000 / 460 |
| workspace deps per app (median / p90) | 14 / 17 | 14 / 16 |
| app closure (p25 / median / p75) | 41 / 43 / 44 | 35 / 40 / 45 |
| libs imported by >50% / >25% / >10% of apps | 13 / 16 / 21 | 15 / 16 / 18 |
| lib deps per lib (mean) / sink libs | 1.71 / 40.4% | 1.72 / 42.8% |
| lib graph depth (median / max) | 2 / 15 | 1 / 15 |
| top lib in-degree (from libs) | 130 | 171 |

(Generated column from `bench/fleet-shape.json`; the committed file is the full-scale run.)

## What the Preset Deliberately Does Not Model

Divergences from the measured fleet, recorded in `bench/fleet-shape.json` `fleetContext`:

- **The fleet is not one workspace today.** It runs ~30,000 independent per-app installs with per-app lockfiles; libs are linked by relative-path `file:` deps. This preset models the single-workspace conversion of that fleet — the thing the rest of this repo benchmarks. A conversion also has two mechanical prerequisites the generator sidesteps by construction: the measured lib graph contains 3 small dependency cycles (largest ≤6 nodes) and 2 duplicate package names, both of which a workspace tool rejects; the generated graph is an acyclic tree of unique names.
- **Source-linked libs.** 421 of the 460 measured libs point `main`/`types` at `src/*.ts`, and apps transpile lib source directly — there is no per-lib build step in the fleet. The whole-program tsgo gate (which reads lib source via `tsconfig.whole.json` paths) mirrors the fleet's actual typecheck semantics; the turbo `^build` path prices the per-package orchestration the fleet does not have yet.
- **External dependency breadth.** The fleet's apps collectively depend on 1,430 distinct external packages (1,710 with devDeps); the generated workspace holds the external surface at the repo's standard pinned set so install benches measure workspace shape, not registry breadth or third-party postinstall behavior.
- **Version spread.** Two ranges of the framework dependency dominate the fleet at roughly 73%/25% (a rollout mid-flight), with long-tail spec divergence on most popular externals. The generated tree models the post-catalog end state; `--skew 25` approximates the two-version split (on react rather than next).
- **Per-package scripts.** Nearly every fleet app has a lint script (98.7%, ESLint 9 flat config) but only 11.7% of apps and 36.3% of libs have a test setup (vitest where present). The generated tree emits `typecheck` everywhere and `test` only under `--test-task`, which emits it for every package; scale test-axis results accordingly.

## Running the Gate at This Shape

`node scripts/optimal-gate-bench.mjs fleet` runs the same scenario as the 4000:400 gate — bun installs the workspace, a foundation lib revs, one tsgo program checks every app from source, a breaking signature must turn all 30,000 apps red, turbo prices the orchestrated per-package path, oxlint sweeps the tree — and writes `bench/fleet-gate-bench.json` (the canonical `bench/optimal-gate-bench.json` stays the 4000:400 record). `fleet:<apps>` scales the app count while keeping the lib graph at its measured size, for machines that cannot hold the full shape.

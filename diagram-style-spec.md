# Diagram system spec (PR C) — distilled from ejc3.github.io/cmux

Goal: make the markdown reports diagram-heavy. GitHub renders SVGs through camo as
<img>: internal CSS + `@media (prefers-color-scheme: dark)` work, JS does not. So the
system is DETERMINISTIC SVG GENERATORS from bench JSONs (existing chart contract:
byte-gated in charts.yml, svg + 300dpi png in one step, no hand numbers, missing
fields throw), in the cmux page's visual language, embedded as figures with numbered
captions.

## Visual language (from the cmux page, verified in its source)

- Canvas: viewBox 660 wide (scale height to content), `role="img"` + aria-label
  stating the mechanism. system-ui text. Figure caption lives in the DOC under the
  image: "**Figure N.** <one-sentence mechanism>" — the caption explains the
  mechanism, never restates the data.
- Boxes: rounded rects rx=6–8. Tinted fill + matching border, semantic:
  - blue `#eef3fb`/`#b9cdec` = component/neutral
  - green `#f0faf5`/`#a9d8bd` = fast path / green verdict
  - rust `#fdf3ef`/`#e4b9a6` = slow path / red verdict / blast radius
  - amber `#fbf6e9`/`#eee3bb` = caveat / incident window (dark: translucent amber,
    fill #c9a13b opacity .14 — never solid olive)
- Ink `#1c2330`, muted `#6b7885`, accent `#1a73e8`, grid `#e4e8ec`.
- Edges: 1.5px lines with marker-end arrowheads; dashed (`stroke-dasharray:3 3` or
  `6 5`) = optional/soft/planned path; solid = measured path. Edge labels 11px muted.
- Dark mode INSIDE each SVG: a <style> block with attribute-selector recolors, copied
  from the cmux page's table (svg text[fill="#1c2330"]→#e2e7ec, line/rect
  #e4e8ec→#2b333c/#39424c, the three box tints → dark equivalents
  #1f2f45/#3d5a85 · #173029/#2e6b52 · #331f18/#7a4630). Series colors already read
  on dark.
- Node sizing may encode magnitude (the cmux PR-graph sizes nodes by lines added) —
  e.g. box area ∝ package count or wall time, always labeled with the real number.
- Provenance: one muted footer line inside the SVG: `bench/<file>.json · <field>`
  (the doc's number-tracing rule made visible). The cmux page's collapsible
  provenance <details> works in GH markdown as plain `<details>` under the figure —
  use for the exact field list when a figure reads >3 fields.

## Figure inventory (what replaces word-heavy sections)

1. **O(repo) vs O(closure)** (README): two-panel flow — whole-repo
   fan-out (30,708 tasks, rust tint) vs one app's closure (green), task counts
   labeled. Data: fleet-gate-bench.json + results.json.
2. **The sliced gate** (FLEET): fan-out diagram — one program (53GB, 7–14 cores,
   rust) vs K slices (green, max-slice RSS labels), converging into the union check
   box (30,171 = 30,171). Data: sliced-gate-bench.json + .pbox.json.
3. **Fleet blast radius** (FLEET): foundation lib at the base, 30,000 apps grid above,
   breaking rev turning the grid rust; leaf edit shading the leaf gate's share of
   the task set. Data: fleet-gate-bench.json + sliced-gate-bench.json + dev-sim.json.
4. **Save loop by mechanic** (TYPECHECKERS): timeline lanes (CLI incremental / watch /
   LSP pull / Flow server) from edit to verdict at 1M modules, bar length = measured ms
   on a log axis. Data: tsgo-scale-bench + lsp-scale-bench.
5. **Types-first vs inference closure** (TYPECHECKERS, the isolatedDeclarations
   story): two-panel — annotated boundary stops propagation (green wall) vs inference
   chain crossing files (dashed rust edges). Mechanism figure, no data fields; caption
   carries the trace.
6. **Linker layouts** (TOOLING): three-panel node_modules geometry — hoisted / pnpm
   isolated (symlink store) / PnP (no node_modules tree, .pnp.cjs table). Data:
   install-bench (nmEntries, pnpCjsBytes at its largest scale).
7. **Freshness gate loop** (TYPECHECKERS): cycle diagram — codegen → git status →
   green/red fork, with measured costs on edges (3.0s @10k, 9.5s @30k). Data:
   relay-codegen-bench.json.
8. **Remote cache economics** (LIMITS): seed-once/restore-many fan; cold-vs-restore
   bars and the leaf-vs-foundation partial-invalidation split from ci-cache-bench.
9. **Next under PnP by node version** (TOOLING): builder × linker/node outcome matrix,
   cells tinted by outcome with the failure kind. Data: rspack-pnp-bench.json.

Styles beyond the cmux page worth adding (each maps to a real section):
- **Grid/treemap** for blast radius (3) — the 30k-apps-red moment IS the thesis.
- **Timeline lanes** for save loops (4) — mechanics differ in kind, not just ms.
- **Small multiples** row for cross-box (64c vs 192c) — same figure twice, shared
  scale, per the chart conventions' one-column-order rule.

## Contract (unchanged repo rules that bind these)

- One generator per figure family (`scripts/fig-*.mjs` or one `figures.mjs`),
  registered in AGENTS.md Data of Record, wired into charts.yml byte-gate + PNG
  commit-back, added to chart.mjs external set, Makefile target, embedded SVG with
  PNG link below.
- Deterministic: no Date, no hand numbers; need() every field; outcome-shape asserts
  (e.g. the sliced figure REQUIRES matchesWholeProgram:true).
- Heat-table conventions still govern tabular figures (×N grammar, green best cell,
  ceiling/crash/near-tie rules).

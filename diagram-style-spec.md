# Diagram system spec (PR C) — distilled from ejc3.github.io/cmux

Goal: make the markdown reports diagram-heavy. GitHub renders SVGs through camo as
<img>: internal CSS + `@media (prefers-color-scheme: dark)` work, JS does not. So the
system is DETERMINISTIC SVG GENERATORS from bench JSONs (existing chart contract:
byte-gated in charts.yml, svg + 300dpi png in one step, no hand numbers, missing
fields throw), in the cmux page's visual language, embedded as figures with numbered
captions.

## Visual language (v2; the code in `scripts/_chartstyle.mjs` is the reference)

- Canvas: each figure is laid out on a 660-wide grid placed at the shared 20px outer
  margin (a 668 canvas), height to content, `role="img"` + an aria-label stating the
  mechanism. system-ui text, tabular numerals. The caption lives in the DOC under the
  image: "**Figure N.** <the mechanism in one or two sentences>"; it explains the
  mechanism and does not restate the data.
- One type scale for every chart and figure (`TYPE`; the figures' `FIG` uses the same
  sizes): title 17/650, lede 12, labels 11.5–12/600, values 13/650, notes and edge
  labels 10. Text inside a figure box is at least 11px (`MIN_BOX_TEXT`); nothing is
  under 9px (`MIN_TEXT`). Secondary text inside a box is `CELL_INK2` (#46505b), which
  clears 4.5:1 on every tint; muted `#6b7885` is for text on the page only.
- Boxes: rounded rects, light tint + quieter border, semantic (`TINT`, each pair with a
  dark twin in `TINT_DARK` from which the dark rules are generated):
  - blue = component / neutral; green = fast path / green verdict;
    rust = slow path / red verdict; amber = caveat / incident window
  - repo / scope = the REPO / SCOPE pair's tints: a whole-repo selection vs one closure
- Marks: the whole-repo vs scoped-closure pair `REPO` (charcoal) / `SCOPE` (cyan), off
  the heat ramp's hues and every tool hue, separable by lightness; `SLATE` for a
  neutral series; `MACHINE_SERIES` for the same run on two machines (no winner tint).
  Every mark clears 3:1 against the page in both themes.
- Edges: 1.25px `EDGE` lines with explicit triangle heads (ImageMagick drops
  `<marker>`); dashed edges are explicit segments (ImageMagick underlines a
  `stroke-dasharray`). An edge ends on a node. Durations sit inside the node that
  spends them, never on an edge.
- Dark mode INSIDE each SVG: the `@media (prefers-color-scheme: dark)` block retargets
  the palette constants by attribute selector; tints and marks have dark twins.
- A figure that contrasts unlike things (different trees, a whole-program verdict vs an
  open-file one, two machines) carries its caveat as a muted line inside the SVG and in
  the aria-label, because the PNG is linked and shared standalone.
- Provenance: one grey footer line, `data: bench/<file>.json · …`, shared with the line
  charts (the heat charts carry per-section source links instead).
- The figure's numbers are also written as markdown into the embedding doc between
  `chart-data` markers (the phone-readable text alternative).
- `scripts/chartstyle-selftest.mjs` audits every committed SVG in both themes for the
  floors and contrast above.

## Figure inventory (what replaces word-heavy sections)

1. **O(repo) vs O(closure)** (README): two-panel flow — whole-repo
   fan-out (30,708 tasks, REPO tiles) vs one app's closure (SCOPE tiles), task counts
   labeled, with its different-trees caveat in the figure. Data: fleet-gate-bench.json + results.json.
2. **The sliced gate** (FLEET): the workspace feeds one program (51–53GB, 8–14 cores,
   rust) or K slices (green, max-slice RSS labels); both feed the union check box
   (30,171 = 30,171). Data: sliced-gate-bench.json + .pbox.json.
3. **Fleet blast radius** (FLEET): the turbo task set as two schematic grids in one
   unit: the foundation rev re-runs every task (REPO), the leaf edit its share (SCOPE). Data: fleet-gate-bench.json + sliced-gate-bench.json + dev-sim.json.
4. **Save loop by mechanic** (TYPECHECKERS): timeline lanes (CLI incremental / watch /
   LSP pull / Flow server) from edit to verdict at 1M modules: a dot per edit and a
   hollow dot for the one-time entry cost on a log axis (no connector, which would
   read as a range), with the LSP lane's open-file scope stated in the figure. Data: tsgo-scale-bench + lsp-scale-bench.
5. **Types-first vs inference closure** (TYPECHECKERS, the isolatedDeclarations
   story): two-panel — annotated boundary stops propagation (green wall) vs inference
   chain crossing files (dashed rust edges). Mechanism figure, no data fields; caption
   carries the trace.
6. **Linker layouts** (TOOLING): three-panel node_modules geometry — hoisted / pnpm
   isolated (symlink store) / PnP (no node_modules tree, .pnp.cjs table). Data:
   install-bench (nmEntries, pnpCjsBytes at its largest scale).
7. **Freshness gate loop** (TYPECHECKERS): cycle diagram — codegen → git status →
   green/red fork, each step's measured time inside its node (9.5s and 38ms at 30k);
   one gate pass 3.0s @10k, 9.5s @30k. Data:
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
- Heat-table conventions still govern tabular figures (the value-first cell, its standing
  against the row's fastest, the ceiling/crash/near-tie rules).
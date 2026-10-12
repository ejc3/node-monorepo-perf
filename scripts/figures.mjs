#!/usr/bin/env node
// Mechanism figures for the diagram-heavy reports (diagram-style-spec.md):
//   fig-sliced-gate     — one-program gate vs the K-slice fan vs the union check (FLEET.md)
//   fig-blast-radius    — foundation rev turns the whole fleet red; a leaf rev doesn't (FLEET.md)
//   fig-orepo-oclosure  — the thesis: a whole-repo selection vs one app's closure (README.md)
//   fig-save-loop       — one edit to a verdict at 1M modules, a dot per mechanic + its entry cost (TYPECHECKERS.md)
//   fig-freshness-gate  — codegen, then git status, then the green/red fork (TYPECHECKERS.md)
//   fig-linker-layouts  — what hoisted / isolated / PnP linkers materialize (TOOLING.md)
//   fig-next-pnp-node   — next build under PnP: builder x linker/node outcome matrix (TOOLING.md)
//   fig-remote-cache    — one runner seeds the shared cache, the rest restore (LIMITS.md)
// Deterministic from the cited bench JSONs (no Date, no hand numbers; missing or
// renamed fields throw) -> bench/charts/fig-*.svg + a 300 DPI PNG each, one step,
// plus each figure's text alternative (its values and fields as markdown) written
// into the embedding doc's chart-data block. Drawn in the figure grammar of
// scripts/_chartstyle.mjs (FIG type scale, node/edge/dot helpers); caveats live in
// the doc captions, not in the SVGs.
//
//   node scripts/figures.mjs                  (make figures: every figure)
//   node scripts/figures.mjs fig-save-loop    (only the named figures, while iterating)

import { readFileSync } from "node:fs";
import {
  BG,
  MUTED,
  GRID,
  EDGE,
  TINT,
  TOOL_COLORS,
  box,
  txt,
  arrow,
  dashes,
  footer as footerLine,
  svgDoc as svgDocW,
  emitChart,
  assertComparable,
  bareVer,
  NEAR_TIE_MAX,
  FIG,
  figTitle,
  node,
  edgeLabel,
  dot,
  CELL_INK2,
  REPO,
  SCOPE,
  SLATE,
  rampRGB,
  rgbCss,
  mdTable,
  mdDetails,
  writeDocBlock,
  wrapPx,
  approxW,
} from "./_chartstyle.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const SLICED = read("bench/sliced-gate-bench.json");
const SLICED_PBOX = read("bench/sliced-gate-bench.pbox.json");
const FLEET = read("bench/fleet-gate-bench.json");
const RESULTS = read("bench/results.json");
const DEVSIM = read("bench/dev-sim.json");
const TSCALE = read("bench/tsgo-scale-bench.json");
const LSPSCALE = read("bench/lsp-scale-bench.json");
const RELAY = read("bench/relay-codegen-bench.json");
const INSTALL = read("bench/install-bench.json");
const RSPACK_PNP = read("bench/rspack-pnp-bench.json");
const CI_CACHE = read("bench/ci-cache-bench.json");

// every number a figure renders, pulled once and validated (a stale or reshaped
// dataset must throw here, not render a plausible box)
const need = (o, path) => {
  let v = o;
  for (const k of path.split(".")) {
    v = v?.[k];
    if (v == null) throw new Error(`missing field ${path} in a cited bench JSON`);
  }
  return v;
};

// typed reads: a field that changed type (a timeout object where a time was, a
// string where a flag was) must throw, not coerce into a plausible label
const num = (o, path) => {
  const v = need(o, path);
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`field ${path} is not a number in a cited bench JSON`);
  return v;
};
const flag = (o, path) => {
  const v = need(o, path);
  if (typeof v !== "boolean")
    throw new Error(`field ${path} is not a boolean in a cited bench JSON`);
  return v;
};
const str = (o, path) => {
  const v = need(o, path);
  if (typeof v !== "string" || v === "")
    throw new Error(`field ${path} is not a non-empty string in a cited bench JSON`);
  return v;
};
// a measured wall time: a positive number of milliseconds
const posMs = (o, path) => {
  const v = num(o, path);
  if (v <= 0) throw new Error(`field ${path} is not a positive time in a cited bench JSON`);
  return v;
};
// a count: a non-negative integer
const count = (o, path) => {
  const v = num(o, path);
  if (!Number.isInteger(v) || v < 0)
    throw new Error(`field ${path} is not a count in a cited bench JSON`);
  return v;
};
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
// sub-second times stay in ms (a 324ms recheck is not "0.3s")
const dur = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : secs(ms));
const gb = (mb) => `${(mb / 1000).toFixed(1)}GB`;
const int = (n) => n.toLocaleString("en-US");

// the shared visual language lives in scripts/_chartstyle.mjs (palette, dark-mode
// block, box/txt/arrow grammar, emit). Each figure is laid out on a 660-wide grid
// whose left edge is x=16; the document places that grid 4px in, on a 668 canvas,
// so every figure has the same 20px outer margin as the heat and line charts.
const W = 660;
const GRID_SHIFT = 4;
const svgDoc = (h, aria, body) =>
  svgDocW(W + 2 * GRID_SHIFT, h, aria, [
    `<g transform="translate(${GRID_SHIFT} 0)">`,
    ...body,
    "</g>",
  ]);
const footer = (y, sources) => footerLine(W, y, sources, 16);
// secondary text inside a figure box: the AA-clearing ink at the box-text floor
const boxNote = { size: FIG.body, fill: CELL_INK2 };
const emit = (name, svg) => emitChart(name, svg, { strict: true });
// the mobile text alternative: the figure's numbers as a table + the fields it
// reads, written between the doc's chart-data markers for this figure
const writeFigData = (doc, id, summary, { head, rows, fields, lead, align }) =>
  writeDocBlock(
    doc,
    id,
    mdDetails(
      summary,
      [lead, mdTable(head, rows, align), `Fields: ${fields}`].filter(Boolean).join("\n\n"),
    ),
  );

// ============================================================================
// Figure: fig-sliced-gate — the sliced-gate fan-out (FLEET.md "The Sliced Gate")
// ============================================================================
function figSlicedGate() {
  const rows = [SLICED, SLICED_PBOX].map((rec) => {
    const bestK = need(rec, "summary.bestK");
    const r = {
      cores: need(rec, "machine.cores"),
      wholeMs: need(rec, "whole.cleanMs"),
      wholeRssMB: need(rec, "whole.rssMB"),
      wholeCpuPct: need(rec, "whole.cpuPct"),
      bestK,
      bestKWallMs: need(rec, "summary.bestKWallMs"),
      sliceRssMB: need(rec, `ks.${bestK}.maxSliceRssMB`),
      unionK: need(rec, "unionCheck.k"),
      unionLocations: need(rec, "unionCheck.locations"),
      wholeLocations: need(rec, "whole.breakingLocations"),
    };
    // the record's best K is the strict minimum of single-sample walls; when a
    // smaller K is a near-tie (the chart convention's 5%), the figure says so
    const tied = Object.keys(need(rec, "ks"))
      .map(Number)
      .sort((a, b) => a - b)
      .find((k) => k < bestK && need(rec, `ks.${k}.wallMs`) <= r.bestKWallMs * NEAR_TIE_MAX);
    r.tieNote =
      tied == null
        ? null
        : `K=${tied} within ${((need(rec, `ks.${tied}.wallMs`) / r.bestKWallMs - 1) * 100).toFixed(1)}% of K=${bestK} (${r.cores}c)`;
    // outcome-shape asserts: the figure's story is "identical verdict, sliced"
    if (need(rec, "unionCheck.matchesWholeProgram") !== true)
      throw new Error("unionCheck.matchesWholeProgram is not true — the figure is invalid");
    if (r.unionLocations !== r.wholeLocations)
      throw new Error("union locations != whole-program locations");
    if (r.unionK !== r.bestK) throw new Error("union check did not run at the best K");
    return r;
  });
  const [c64, c192] = rows;
  if (c192.cores <= c64.cores) throw new Error("pbox record is not the bigger box");
  // the figure draws the two records as a machine contrast: same tree, same
  // checker and node on the timed path (slices spawn the checker directly)
  assertComparable(
    SLICED,
    SLICED_PBOX,
    {
      fields: ["apps", "libs", "shape", "machine.arch", "whole.breakingLocations"],
      versions: ["tsgo", "node"],
    },
    "sliced-gate 64- vs 192-core",
  );
  const apps = need(SLICED, "apps");
  const tsgoVer = bareVer(need(SLICED, "versions.tsgo"));

  const T = [];
  T.push(...figTitle(16, 24, "The sliced gate: one program or K concurrent slices").parts);

  // the workspace (source) feeds two alternatives: one program over everything, or
  // K concurrent slices; both feed the union check that compares their verdicts
  const top = 50;
  const SX = 16;
  const SW = 150;
  const PX = 226;
  const PWID = 214;
  const UX = 486;
  const UW = 158;
  const progH = 116;
  const sliceH = 24;
  const sgap = 6;
  const slicesTop = top + progH + 30;
  const labels = ["slice 1", "slice 2", "slice 3", "slice 4", null, "slice K"];
  const stackH = 5 * (sliceH + sgap) + 16 - sgap;
  const bottom = slicesTop + stackH;

  // source node, centred between the two alternatives
  const srcH = 58;
  const srcY = Math.round((top + bottom) / 2 - srcH / 2);
  T.push(
    ...node(SX, srcY, SW, srcH, "blue", "the workspace", [`${int(apps)} apps +`, "all lib source"]),
  );

  // alternative 1: one program (rust: most of either box sits idle)
  T.push(box(PX, top, PWID, progH, "rust"));
  T.push(txt(PX + 12, top + 19, "one tsgo program", { size: FIG.label, weight: "600" }));
  [
    [`${secs(c64.wholeMs)} · ${c64.cores} cores`, { size: FIG.value, weight: "650" }],
    [`${secs(c192.wholeMs)} · ${c192.cores} cores`, { size: FIG.value, weight: "650" }],
    [`peak RSS ${gb(c64.wholeRssMB)} / ${gb(c192.wholeRssMB)}`, boxNote],
    [`CPU ${c64.wholeCpuPct}% of ${int(c64.cores * 100)}% on ${c64.cores}`, boxNote],
    [`CPU ${int(c192.wholeCpuPct)}% of ${int(c192.cores * 100)}% on ${c192.cores}`, boxNote],
  ].forEach(([t, o], i) => T.push(txt(PX + 12, top + 40 + i * 17, t, o)));
  const srcMid = srcY + srcH / 2;
  T.push(arrow(SX + SW + 2, srcMid - 8, PX - 2, top + progH / 2));
  T.push(edgeLabel(PX - 8, top + progH / 2 - 8, "one process", "end"));

  // alternative 2: the slice stack, fanned out from the workspace
  const sliceYs = [];
  let yy = slicesTop;
  for (const lab of labels) {
    if (lab === null) {
      T.push(
        txt(PX + PWID / 2, yy + 9, "· · ·", { size: FIG.body, fill: MUTED, anchor: "middle" }),
      );
      yy += 16;
      continue;
    }
    T.push(box(PX, yy, PWID, sliceH, "green", 4));
    T.push(txt(PX + 10, yy + 16, lab, { size: FIG.body }));
    T.push(txt(PX + PWID - 10, yy + 16, "libs + 1/K apps", { ...boxNote, anchor: "end" }));
    sliceYs.push(yy + sliceH / 2);
    yy += sliceH + sgap;
  }
  for (const sy of sliceYs) T.push(arrow(SX + SW + 2, srcMid + 8, PX - 2, sy));
  T.push(edgeLabel(PX - 8, bottom + 16, "split K ways", "end"));

  // the union check: slice error locations against the whole program's
  T.push(box(UX, top, UW, bottom - top, "green"));
  const um = top + (bottom - top) / 2 - 34;
  T.push(txt(UX + 12, um, "union check", { size: FIG.label, weight: "600" }));
  T.push(txt(UX + 12, um + 18, "breaking-rev", boxNote));
  T.push(txt(UX + 12, um + 32, "error locations", boxNote));
  T.push(
    txt(UX + 12, um + 54, `${int(c64.unionLocations)} = ${int(c64.wholeLocations)}`, {
      size: FIG.value,
      weight: "650",
    }),
  );
  T.push(txt(UX + 12, um + 72, "slices vs whole", { size: FIG.body }));
  T.push(txt(UX + 12, um + 87, "program: identical", { size: FIG.body }));
  T.push(arrow(PX + PWID + 2, top + progH / 2, UX - 2, top + progH / 2));
  for (const sy of sliceYs) T.push(arrow(PX + PWID + 2, sy, UX - 2, sy));

  // values under the slice stack
  const vy = bottom + 30;
  T.push(
    txt(PX, vy, `${secs(c64.bestKWallMs)} · ${c64.cores} cores (K=${c64.bestK})`, {
      size: FIG.value,
      weight: "650",
    }),
  );
  T.push(
    txt(PX, vy + 19, `${secs(c192.bestKWallMs)} · ${c192.cores} cores (K=${c192.bestK})`, {
      size: FIG.value,
      weight: "650",
    }),
  );
  T.push(
    txt(PX, vy + 38, `max slice RSS ${gb(c64.sliceRssMB)} / ${gb(c192.sliceRssMB)}`, {
      size: FIG.note,
      fill: MUTED,
    }),
  );
  const tieNotes = rows.map((r) => r.tieNote).filter(Boolean);
  tieNotes.forEach((t, i) => T.push(txt(PX, vy + 54 + i * 14, t, { size: FIG.note, fill: MUTED })));

  // the 64- and 192-core records are one run each on different machines
  const caveat =
    "One run per machine: 64 vs 192 cores is a cross-machine observation, not a controlled core-scaling experiment.";
  const cy = vy + 54 + tieNotes.length * 14;
  T.push(txt(SX, cy + 6, caveat, { size: FIG.note, fill: MUTED }));
  const y = cy + 34;
  T.push(
    ...footer(
      y,
      `bench/sliced-gate-bench.json · bench/sliced-gate-bench.pbox.json · tsgo ${tsgoVer}`,
    ),
  );
  writeFigData("FLEET.md", "fig-sliced-gate", "The figure's numbers as a table", {
    head: ["", `${c64.cores} cores`, `${c192.cores} cores`],
    rows: [
      ["one program: wall", secs(c64.wholeMs), secs(c192.wholeMs)],
      ["one program: peak RSS", gb(c64.wholeRssMB), gb(c192.wholeRssMB)],
      [
        "one program: CPU",
        `${c64.wholeCpuPct}% of ${int(c64.cores * 100)}%`,
        `${int(c192.wholeCpuPct)}% of ${int(c192.cores * 100)}%`,
      ],
      ["best K", String(c64.bestK), String(c192.bestK)],
      ["sliced: wall at best K", secs(c64.bestKWallMs), secs(c192.bestKWallMs)],
      ["sliced: max slice RSS", gb(c64.sliceRssMB), gb(c192.sliceRssMB)],
      [
        "union check: error locations",
        `${int(c64.unionLocations)} = ${int(c64.wholeLocations)}`,
        `${int(c192.unionLocations)} = ${int(c192.wholeLocations)}`,
      ],
    ],
    lead: tieNotes.length ? tieNotes.join("; ") + "." : null,
    fields:
      "`bench/sliced-gate-bench.json` and `bench/sliced-gate-bench.pbox.json`: `machine.{cores,arch}`, `whole.{cleanMs,rssMB,cpuPct,breakingLocations}`, `summary.{bestK,bestKWallMs}`, `ks.<K>.{wallMs,maxSliceRssMB}`, `unionCheck.{k,locations,matchesWholeProgram}`, `apps`, `libs`, `shape`, `versions.{tsgo,node}`.",
  });
  return svgDoc(
    y + 12,
    `The sliced gate: one tsgo program over the whole workspace versus K concurrent slices, with a union check proving the sliced verdict identical to the whole-program one. On ${c64.cores} cores the one program takes ${secs(c64.wholeMs)} (${gb(c64.wholeRssMB)} RSS, ${c64.wholeCpuPct}% CPU) and ${c64.bestK} slices take ${secs(c64.bestKWallMs)} at up to ${gb(c64.sliceRssMB)} each; on ${c192.cores} cores the one program takes ${secs(c192.wholeMs)} (${gb(c192.wholeRssMB)} RSS) and ${c192.bestK} slices take ${secs(c192.bestKWallMs)} at up to ${gb(c192.sliceRssMB)} each. ${caveat}`,
    T,
  );
}

// ============================================================================
// Figure: fig-blast-radius — the fleet blast radius (FLEET.md)
// ============================================================================
function figBlastRadius() {
  const apps = need(FLEET, "apps");
  const breakMs = need(FLEET, "breakingChange.ms");
  const breakApps = need(FLEET, "breakingChange.appsWithErrors");
  const foundationLib = need(FLEET, "foundationLib");
  const leafLib = need(FLEET, "leafLib");
  const turboTotal = need(FLEET, "turboGate.total");
  const leafRan = need(FLEET, "leafGate.ran");
  const slicedBreakMs = need(SLICED, "summary.breakingSlicedMs");
  if (need(FLEET, "breakingChange.caught") !== true)
    throw new Error("dataset says the breaking change was not caught");
  if (breakApps !== apps)
    throw new Error("breaking rev did not turn every app red — the all-rust grid is invalid");
  // the verdict line puts the batch and the sliced time side by side as one
  // box's two mechanisms: same tree shape, same machine size and arch, same
  // checker and node. (The two records count the breaking rev differently —
  // raw TS2554 occurrences vs distinct error locations — so those counts are
  // not compared here.)
  assertComparable(
    FLEET,
    SLICED,
    {
      fields: ["apps", "libs", "shape", "machine.cores", "machine.arch"],
      versions: ["tsgo", "node"],
    },
    "fleet-gate vs sliced-gate (blast radius)",
  );
  if (need(SLICED, "unionCheck.matchesWholeProgram") !== true)
    throw new Error("sliced verdict does not match the whole program — its time can't stand in");
  if (leafRan !== need(FLEET, "leafGate.total"))
    throw new Error("leaf gate did not run its full task set");
  // the leaf-dependents count: dev-sim's blast rung records dependentsClosure per
  // lib — take its smallest (the leaf), and label it with its own tree's scale
  const blast = need(DEVSIM, "blast");
  const leafBlast = blast.reduce((a, b) =>
    need(b, "dependentsClosure") < need(a, "dependentsClosure") ? b : a,
  );
  const devSimLeafDeps = need(leafBlast, "dependentsClosure");
  const devSimApps = need(DEVSIM, "apps");

  // both grids are the fleet gate's turbo task set as a schematic grid (NOT one cell
  // per task): the foundation rev selects every task, the leaf edit its own share
  const COLS = 30;
  const ROWS = 20;
  const CELLS = COLS * ROWS;
  const tasksPerCell = Math.round(turboTotal / CELLS);
  if (need(FLEET, "turboGate.ran") !== turboTotal)
    throw new Error(
      "the foundation gate did not run its full task set — the all-hit grid is invalid",
    );
  const leafCells = Math.max(1, Math.round((CELLS * leafRan) / turboTotal));

  const cell = 8;
  const cgap = 1.6;
  const gridW = COLS * cell + (COLS - 1) * cgap;
  const gridH = Math.round(ROWS * cell + (ROWS - 1) * cgap);

  // a re-run task is a filled cell in the selection's colour (REPO for the whole-repo
  // selection, SCOPE for a closure); a task not re-run is an empty outline
  const grid = (x0, y0, hot, mark) => {
    const out = [];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        // hit cells sit in the bottom-left corner, next to the edited lib
        const isHot = hot === "all" || (r === ROWS - 1 && c < hot);
        const at = `x="${(x0 + c * (cell + cgap)).toFixed(1)}" y="${(y0 + r * (cell + cgap)).toFixed(1)}" width="${cell}" height="${cell}" rx="1.5"`;
        out.push(
          isHot
            ? `<rect ${at} fill="${mark}"/>`
            : `<rect ${at} fill="none" stroke="${EDGE}" stroke-width="0.75"/>`,
        );
      }
    return out;
  };

  const T = [];
  T.push(...figTitle(16, 24, "Blast radius: the tasks one lib edit re-runs").parts);
  const hy = 58;
  const gy = 70;
  const LX = 16;
  const RX = 358;

  // left panel: a foundation-lib edit — turbo selects every task; a breaking rev of it
  // (a separate run) turns every app red
  T.push(txt(LX, hy, "foundation-lib edit", { size: FIG.label, weight: "600" }));
  T.push(...grid(LX, gy, "all", REPO.mark));
  // right panel: the leaf edit — a corner of the grid
  T.push(txt(RX, hy, "leaf-lib edit", { size: FIG.label, weight: "600" }));
  T.push(...grid(RX, gy, leafCells, SCOPE.mark));

  // the edited lib at the base of each panel; its edge ends on the grid
  const lby = gy + gridH + 30;
  const libBox = (x0, tint, name, sub) => {
    const cx = x0 + Math.round(gridW / 2);
    T.push(arrow(cx, lby - 2, cx, gy + gridH + 4));
    T.push(box(x0 + 30, lby, gridW - 60, 40, tint));
    T.push(txt(cx, lby + 17, name, { size: FIG.body, weight: "600", anchor: "middle" }));
    T.push(txt(cx, lby + 32, sub, { ...boxNote, anchor: "middle" }));
  };
  libBox(LX, "repo", `foundation lib (${foundationLib})`, "imported by every app");
  libBox(RX, "scope", `leaf lib (${leafLib})`, "imported by almost nothing");

  // the result under each panel
  const vy = lby + 66;
  T.push(
    txt(LX, vy, `${int(turboTotal)} of ${int(turboTotal)} tasks re-run`, {
      size: FIG.value,
      weight: "650",
    }),
  );
  // the verdict, two clauses on their own lines, each wrapped to the panel's width (the
  // gap to the right panel) so no reader's system-ui face runs it into that panel
  const panelW = RX - LX - 16;
  const verdict = [
    `a breaking rev turns all ${int(breakApps)} apps red:`,
    `${secs(breakMs)} batch · ${secs(slicedBreakMs)} sliced`,
  ].flatMap((part) => wrapPx(part, FIG.body, panelW));
  verdict.forEach((ln, i) => T.push(txt(LX, vy + 18 + i * 14, ln, { size: FIG.body })));
  const ly = vy + 18 + (verdict.length - 1) * 14 + 15;
  T.push(
    txt(LX, ly, "every broken call site, with file and line", { size: FIG.note, fill: MUTED }),
  );
  T.push(
    txt(RX, vy, `${int(leafRan)} of ${int(turboTotal)} tasks re-run`, {
      size: FIG.value,
      weight: "650",
    }),
  );
  T.push(
    txt(RX, vy + 18, `at ${int(devSimApps)} apps a leaf lib has ${devSimLeafDeps} dependents`, {
      size: FIG.body,
    }),
  );
  T.push(txt(RX, vy + 33, "dev-sim's smaller tree", { size: FIG.note, fill: MUTED }));

  const y = Math.max(ly, vy + 33) + 34;
  T.push(
    ...footer(y, "bench/fleet-gate-bench.json · bench/sliced-gate-bench.json · bench/dev-sim.json"),
  );
  writeFigData("FLEET.md", "fig-blast-radius", "The figure's numbers as a table", {
    align: ["l", "l", "l"],
    head: ["edit", "reach", "verdict"],
    rows: [
      [
        `foundation-lib edit (\`${foundationLib}\`)`,
        `${int(turboTotal)} of ${int(turboTotal)} tasks re-run`,
        `a breaking rev turns all ${int(breakApps)} apps red: ${secs(breakMs)} batch · ${secs(slicedBreakMs)} sliced`,
      ],
      [
        `leaf-lib edit (\`${leafLib}\`)`,
        `${int(leafRan)} of ${int(turboTotal)} tasks re-run`,
        `a leaf lib has ${devSimLeafDeps} dependents at ${int(devSimApps)} apps (dev-sim)`,
      ],
    ],
    lead: `The grids are schematic: each cell stands for about ${tasksPerCell} of the ${int(turboTotal)} turbo tasks; an edit to the foundation lib re-runs all of them, a leaf edit its share.`,
    fields:
      "`bench/fleet-gate-bench.json`: `apps`, `libs`, `shape`, `foundationLib`, `leafLib`, `breakingChange.{ms,appsWithErrors,caught}`, `turboGate.{total,ran}`, `leafGate.{ran,total}`, `machine.{cores,arch}`, `versions.{tsgo,node}`. `bench/sliced-gate-bench.json`: `summary.breakingSlicedMs`, `unionCheck.matchesWholeProgram`. `bench/dev-sim.json`: `apps`, `blast[].dependentsClosure`.",
  });
  return svgDoc(
    y + 12,
    `Fleet blast radius in turbo tasks: an edit to the foundation lib re-runs all ${int(turboTotal)} tasks, and a breaking rev of it turns all ${int(apps)} apps red, caught in ${secs(breakMs)} (batch) or ${secs(slicedBreakMs)} (sliced); a leaf-lib edit re-runs ${leafRan} of ${int(turboTotal)} tasks. The grids are schematic.`,
    T,
  );
}

// ============================================================================
// Figure: fig-orepo-oclosure — the thesis (README)
// ============================================================================
function figOrepoOclosure() {
  const fleetApps = need(FLEET, "apps");
  // the O(repo) side is the fleet gate's turbo run: optimal-gate-bench.mjs times
  // `turbo run typecheck:tsgo --filter=...<foundationLib>`, whose selection is the
  // foundation lib plus every dependent — labeled as that command, not as "no filter"
  const foundation = need(FLEET, "foundationLib");
  const turboKind = need(FLEET, "turboGate.kind");
  const turboMs = need(FLEET, "turboGate.ms");
  const turboTasks = need(FLEET, "turboGate.total");
  if (need(FLEET, "turboGate.ran") !== turboTasks)
    throw new Error("the whole-repo gate did not run its full task set");
  // the focused side: the largest measured scale in results.json
  const largest = RESULTS.reduce((a, b) => (need(b, "apps") > need(a, "apps") ? b : a));
  const rApps = need(largest, "apps");
  const rLibs = need(largest, "libs");
  const focusMs = need(largest, "phases.focus.ms");
  const focusApp = need(largest, "phases.focus.app");
  const focusTasks = need(largest, "phases.graph.focusTasks");
  const totalTasks = need(largest, "phases.graph.totalBuildTasks");
  if (need(largest, "phases.focus.ok") !== true)
    throw new Error("the focused build did not succeed at the largest scale");

  const T = [];
  T.push(...figTitle(16, 24, "What a turbo command selects").parts);

  // two panels, each: the command (blue node) -> edges into the selected task
  // nodes -> the measured count and wall time
  const PW = 300;
  const panels = [
    {
      x: 16,
      head: "O(repo): a whole-repo selection",
      cmd: "turbo run typecheck:tsgo",
      arg: `--filter=...${foundation}`,
      mark: REPO.mark,
      nodes: 14,
      more: true,
      value: `${int(turboTasks)} tasks · ${secs(turboMs)}`,
      sub: [turboKind, `${int(fleetApps)}-app fleet tree`],
    },
    {
      x: 344,
      head: "O(closure): a scoped command",
      cmd: "turbo run build",
      arg: `--filter=${focusApp}...`,
      mark: SCOPE.mark,
      nodes: 3,
      more: false,
      value: `${int(focusTasks)} tasks · ${secs(focusMs)}`,
      sub: [
        `one app's closure: ${int(focusTasks)} of ${int(totalTasks)} build tasks`,
        `${int(rApps)}-app tree, ${rLibs} libs`,
      ],
    },
  ];
  const hy = 58;
  const cy = hy + 12;
  const ch = 44;
  const ty = cy + ch + 46; // task-node row
  const tn = 14; // task node size
  for (const p of panels) {
    T.push(txt(p.x, hy, p.head, { size: FIG.label, weight: "600" }));
    T.push(box(p.x, cy, PW, ch, "blue"));
    T.push(txt(p.x + 12, cy + 18, p.cmd, { size: FIG.body, weight: "600" }));
    T.push(txt(p.x + 12, cy + 34, p.arg, { size: FIG.body }));
    // the selected task nodes, centered under the command; every edge ends on one
    const pitch = tn + 6;
    const slots = p.nodes + (p.more ? 1 : 0);
    const rowW = slots * pitch - 6;
    const x0 = p.x + (PW - rowW) / 2;
    const ox = p.x + PW / 2;
    for (let i = 0; i < p.nodes; i++) {
      const nx = x0 + i * pitch;
      T.push(arrow(ox, cy + ch + 1, nx + tn / 2, ty - 1.5));
      T.push(
        `<rect x="${nx.toFixed(1)}" y="${ty}" width="${tn}" height="${tn}" rx="2.5" fill="${p.mark}"/>`,
      );
    }
    if (p.more)
      T.push(
        txt(x0 + p.nodes * pitch + tn / 2 - 3, ty + tn - 3, "…", {
          size: FIG.label,
          fill: MUTED,
          anchor: "middle",
        }),
      );
    const vy = ty + tn + 26;
    T.push(txt(p.x, vy, p.value, { size: FIG.value, weight: "650" }));
    p.sub.forEach((ln, i) =>
      T.push(txt(p.x, vy + 17 + i * 14, ln, { size: FIG.note, fill: MUTED })),
    );
  }

  // the figure is linked as a standalone PNG, so it carries its own caveat
  const CAVEAT =
    "Different trees and tasks: the contrast is the selection, not a time ratio. Task tiles are schematic.";
  const cvy = ty + tn + 26 + 17 + 14 + 24;
  T.push(txt(16, cvy, CAVEAT, { size: FIG.note, fill: MUTED }));
  const y = cvy + 34;
  T.push(...footer(y, "bench/fleet-gate-bench.json · bench/results.json"));

  writeFigData("README.md", "fig-orepo-oclosure", "The figure's numbers as a table", {
    align: ["l", "l", "r", "r", "l"],
    head: ["", "command", "tasks", "wall time", "tree"],
    rows: [
      [
        "O(repo)",
        `\`turbo run typecheck:tsgo --filter=...${foundation}\``,
        int(turboTasks),
        secs(turboMs),
        `${int(fleetApps)}-app fleet tree`,
      ],
      [
        "O(closure)",
        `\`turbo run build --filter=${focusApp}...\``,
        `${int(focusTasks)} of ${int(totalTasks)}`,
        secs(focusMs),
        `${int(rApps)} apps / ${rLibs} libs`,
      ],
    ],
    fields:
      "`bench/fleet-gate-bench.json`: `apps`, `foundationLib`, `turboGate.{kind,ms,total,ran}`. `bench/results.json`, the largest-scale row: `apps`, `libs`, `phases.focus.{ms,app,ok}`, `phases.graph.{focusTasks,totalBuildTasks}`.",
  });
  return svgDoc(
    y + 12,
    `What a turbo command selects: a filter on the foundation lib selects every dependent, ${int(turboTasks)} tasks on the ${int(fleetApps)}-app fleet, while a command scoped to one app runs that app's dependency closure (${focusTasks} tasks at the largest measured layered scale). ${CAVEAT}`,
    T,
  );
}

// ============================================================================
// Figure: fig-save-loop — one edit to a verdict at a million modules, a lane per
// mechanic (TYPECHECKERS.md "Behavior at a Million Files")
// ============================================================================
function figSaveLoop() {
  const N = 1000000;
  const pt = need(TSCALE, `points.${N}`);
  const lp = need(LSPSCALE, "results").find((r) => r.modules === N);
  if (!lp) throw new Error(`lsp-scale-bench has no ${N}-module point — the figure is invalid`);
  // the lanes come from two records and share one axis: same machine size, same
  // corpus depth, same checker build invoked the same way (the records keep these
  // under different keys; lsp-scale records no arch, mount or node version, so
  // those cannot be compared)
  assertComparable(
    {
      cores: need(TSCALE, "cores"),
      layers: need(TSCALE, "layers"),
      tsgoInvocation: need(TSCALE, "tsgoInvocation"),
      versions: { tsgo: need(TSCALE, "versions.tsgo") },
    },
    {
      cores: need(LSPSCALE, "meta.cores"),
      layers: need(LSPSCALE, "meta.layers"),
      tsgoInvocation: need(LSPSCALE, "meta.tsgoInvocation"),
      versions: { tsgo: need(LSPSCALE, "meta.tsgoVersion") },
    },
    { fields: ["cores", "layers", "tsgoInvocation"], versions: ["tsgo"] },
    "save loop: tsgo-scale vs lsp-scale",
  );
  const cores = count(TSCALE, "cores");
  const tsgoVer = bareVer(str(TSCALE, "versions.tsgo"));
  // the Flow lane is labeled as the main-branch build (released 0.321's server
  // wedges at this scale); a dataset whose flow provenance changes must force a
  // deliberate figure update, the same rule scale-chart.mjs applies
  if (!str(TSCALE, "versions.flow").includes("flow main"))
    throw new Error("expected the flow rows to be a flow-main build — update the figure's label");
  // a batch-bench row: must have completed (a killed/timed-out/skipped row has no
  // medianMs, or says killed) and carry a positive median
  const rowMs = (checker, row) => {
    if (flag(pt, `${checker}.${row}.killed`) !== false)
      throw new Error(`${checker}.${row} was killed at ${N} — not a measurement`);
    return posMs(pt, `${checker}.${row}.medianMs`);
  };

  const lanes = [
    {
      name: "tsgo CLI, incremental rerun",
      how: "relaunch + tsbuildinfo re-read",
      ms: rowMs("tsgo", "incrOneEdit"),
      entryMs: posMs(pt, "tsgo.incrPrimeMs"),
      entry: "incremental prime",
      tool: "tsgo",
    },
    {
      name: "tsgo --watch",
      how: "resident; rebuilds the program",
      ms: posMs(lp, "tsgoWatch.oneEditRecheckMs"),
      entryMs: posMs(lp, "tsgoWatch.firstBuildMs"),
      entry: "first build",
      tool: "tsgo",
    },
    {
      name: "tsgo --lsp squiggle",
      how: "didChange → error appears",
      ms: posMs(lp, "tsgoLsp.warm.errorAppearsMs"),
      entryMs: posMs(lp, "tsgoLsp.cold.coldOpenMs"),
      entry: "cold open",
      tool: "tsgo",
    },
    {
      name: "Flow server (main build)",
      how: "live server: notify + status",
      ms: rowMs("flow", "incrOneEdit"),
      entryMs: posMs(pt, "flow.serverInitMs"),
      entry: "server init",
      tool: "flow",
    },
  ];
  const [cli, watch, lsp, flow] = lanes.map((l) => l.ms);
  // outcome-shape assert: the lanes are drawn (and captioned) as relaunch slowest,
  // the rebuilding watcher next, and both resident servers fastest
  if (!(Math.max(lsp, flow) < watch && watch < cli))
    throw new Error(
      "save-loop ordering changed (expected resident servers < --watch < CLI relaunch) — the figure's story is invalid",
    );

  // the lane layout labels the per-edit value left of its dot and the entry cost
  // right of its hollow dot, which needs the entry to be the larger time
  for (const l of lanes)
    if (!(l.entryMs > l.ms))
      throw new Error(`${l.name}: one-time entry is not slower than one edit — relabel the lanes`);

  // log axis over whole decades that bracket every drawn time (per-edit and entry)
  const times = lanes.flatMap((l) => [l.ms, l.entryMs]);
  const lo = 10 ** Math.floor(Math.log10(Math.min(...times)));
  const hi = 10 ** Math.ceil(Math.log10(Math.max(...times)));
  const decades = Math.round(Math.log10(hi / lo));
  if (decades < 1 || decades > 6)
    throw new Error(`save-loop times span ${decades} decades — the axis layout does not fit`);
  const X0 = 236;
  const X1 = 506;
  const xOf = (ms) => +(X0 + (Math.log10(ms / lo) / decades) * (X1 - X0)).toFixed(1);
  const tickLabel = (ms) => (ms < 1000 ? `${ms}ms` : `${int(ms / 1000)}s`);

  const T = [];
  T.push(...figTitle(16, 24, `One edit to a verdict at ${int(N)} modules`).parts);
  // key
  const ky = 46;
  T.push(dot(20, ky - 3.5, MUTED, { r: 4 }));
  T.push(txt(29, ky, "per edit", { size: FIG.note, fill: MUTED }));
  T.push(dot(92, ky - 3.5, MUTED, { r: 4, hollow: true }));
  T.push(txt(101, ky, "one-time entry cost", { size: FIG.note, fill: MUTED }));
  T.push(txt(X1, ky, "log scale", { size: FIG.note, fill: MUTED, anchor: "end" }));

  const laneY0 = 84;
  const pitch = 44;
  const axisTop = laneY0 - 14;
  const axisBot = laneY0 + lanes.length * pitch - 18;
  for (let d = 0; d <= decades; d++) {
    const gx = xOf(lo * 10 ** d);
    T.push(`<line x1="${gx}" y1="${axisTop}" x2="${gx}" y2="${axisBot}" stroke="${GRID}"/>`);
    T.push(
      txt(gx, axisTop - 6, tickLabel(lo * 10 ** d), {
        size: FIG.note,
        fill: MUTED,
        anchor: "middle",
      }),
    );
  }
  lanes.forEach((l, i) => {
    const y = laneY0 + i * pitch;
    const c = TOOL_COLORS[l.tool];
    T.push(txt(16, y + 4, l.name, { size: FIG.label, weight: "600" }));
    T.push(txt(16, y + 18, l.how, { size: FIG.note, fill: MUTED }));
    const x = xOf(l.ms);
    const ex = xOf(l.entryMs);
    // no connector between the two dots: a line would read as a range
    T.push(dot(ex, y, c, { hollow: true }));
    T.push(dot(x, y, c));
    T.push(txt(x - 9, y + 4, dur(l.ms), { size: FIG.body, weight: "650", anchor: "end" }));
    T.push(txt(ex + 9, y + 4, `${dur(l.entryMs)} ${l.entry}`, { size: FIG.note, fill: MUTED }));
  });

  // the figure is linked as a standalone PNG, so it carries its own caveat
  // the lanes time different edits over different scopes; both differences are stated
  const CAVEATS = [
    "CLI, --watch and Flow: a valid one-module edit, verdict over the whole program.",
    "LSP: an edit that seeds a type error, verdict for the open file only.",
  ];
  const CAVEAT = CAVEATS.join(" ");
  CAVEATS.forEach((c, i) =>
    T.push(txt(16, axisBot + 22 + i * 15, c, { size: FIG.note, fill: MUTED })),
  );
  const y = axisBot + 69;
  T.push(
    ...footer(
      y,
      `bench/tsgo-scale-bench.json · bench/lsp-scale-bench.json · tsgo ${tsgoVer} · ${cores} cores`,
    ),
  );
  writeFigData("TYPECHECKERS.md", "fig-save-loop", "The figure's numbers as a table", {
    align: ["l", "r", "l"],
    head: ["mechanic", "one edit → verdict", "one-time entry"],
    rows: lanes.map((l) => [`${l.name} (${l.how})`, dur(l.ms), `${dur(l.entryMs)} ${l.entry}`]),
    fields:
      "`bench/tsgo-scale-bench.json`, `points.1000000`: `tsgo.incrOneEdit.{killed,medianMs}`, `tsgo.incrPrimeMs`, `flow.incrOneEdit.{killed,medianMs}`, `flow.serverInitMs`; `versions.tsgo`, `versions.flow`, `cores`, `layers`, `tsgoInvocation`. `bench/lsp-scale-bench.json`, the `results` entry whose `modules` is 1,000,000: `tsgoWatch.oneEditRecheckMs`, `tsgoWatch.firstBuildMs`, `tsgoLsp.warm.errorAppearsMs`, `tsgoLsp.cold.coldOpenMs`; `meta.cores`, `meta.layers`, `meta.tsgoInvocation`, `meta.tsgoVersion`. The two records share one axis on the fields they share (cores, corpus depth, tsgo version and invocation); `lsp-scale-bench.json` records no architecture, mount or node version.",
  });
  return svgDoc(
    y + 12,
    `The save loop by mechanic at ${int(N)} modules, on a log time axis: tsgo's CLI incremental rerun relaunches and returns a verdict in ${dur(cli)}, its --watch rebuild in ${dur(watch)}, its LSP shows a seeded error in the open file in ${dur(lsp)}, and Flow's resident server rechecks one edit in ${dur(flow)}; each lane also marks its one-time entry cost. ${CAVEAT}`,
    T,
  );
}

// ============================================================================
// Figure: fig-freshness-gate — the checked-in-artifacts loop (TYPECHECKERS.md
// "The daemons and codegen")
// ============================================================================
function figFreshnessGate() {
  const comps = count(RELAY, "components");
  const samples = count(RELAY, "samples");
  const gateMs = posMs(RELAY, "freshness.gateMedianMs");
  const gateSamples = need(RELAY, "freshness.gateSamplesMs");
  if (!Array.isArray(gateSamples) || gateSamples.length !== samples)
    throw new Error("freshness.gateSamplesMs does not hold one time per recorded sample");
  gateSamples.forEach((_, i) => posMs(gateSamples, String(i)));
  // the headline is labeled "median of N samples": hold the record to that
  const sortedGate = [...gateSamples].sort((a, b) => a - b);
  const midGate = sortedGate.length >> 1;
  const medianGate =
    sortedGate.length % 2
      ? sortedGate[midGate]
      : (sortedGate[midGate - 1] + sortedGate[midGate]) / 2;
  if (medianGate !== gateMs)
    throw new Error("freshness.gateMedianMs is not the median of freshness.gateSamplesMs");
  const fleetComps = count(RELAY, "fleetPoint.components");
  const fleetSamples = count(RELAY, "fleetPoint.samples");
  const fleetCodegenMs = posMs(RELAY, "fleetPoint.codegenNoChangeMs");
  const fleetStatusMs = posMs(RELAY, "fleetPoint.statusMs");
  const fleetGateMs = posMs(RELAY, "fleetPoint.freshnessMs");
  const cores = count(RELAY, "cores");
  const relayVer = bareVer(str(RELAY, "versions.relayCompiler"));
  // outcome-shape asserts: the green branch is drawn as "byte-stable, nothing
  // dirty" and the red branch as "an edited query dirties the artifacts"
  if (flag(RELAY, "freshness.byteStable") !== true)
    throw new Error("freshness.byteStable is not true — the green branch is invalid");
  if (flag(RELAY, "freshness.driftDetected") !== true)
    throw new Error("freshness.driftDetected is not true — the red branch is invalid");
  if (flag(RELAY, "fleetPoint.byteStable") !== true)
    throw new Error("fleetPoint.byteStable is not true — the fleet anchor is not a green pass");
  // the two edge costs are drawn as the parts of the fleet-anchor total
  if (Math.abs(fleetCodegenMs + fleetStatusMs - fleetGateMs) > 1)
    throw new Error("fleetPoint codegen + status does not sum to freshnessMs");
  if (fleetComps <= comps) throw new Error("the fleet anchor is not the larger tree");
  // the record carries no canonical flag; relay-codegen-bench.mjs promotes only
  // this knob tuple (its `canonical` condition), and TYPECHECKERS.md cites it, so a
  // renamed partial must not render here
  const CANON = { components: 10000, samples: 3, schemaTypes: 100, fleetComponents: 30000 };
  if (
    comps !== CANON.components ||
    samples !== CANON.samples ||
    count(RELAY, "schemaTypes") !== CANON.schemaTypes ||
    fleetComps !== CANON.fleetComponents
  )
    throw new Error(
      `relay-codegen-bench is not the canonical record (${JSON.stringify(CANON)}) — update the figure and TYPECHECKERS.md together`,
    );

  const T = [];
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  T.push(...figTitle(16, 24, "The freshness gate for checked-in codegen artifacts").parts);

  // row 1: the gate's two steps, left to right; each step's measured time at the
  // fleet anchor sits inside its node (an edge label would read as a hand-off)
  const ry = 50;
  const rh = 74;
  const fleetAt = `at ${int(fleetComps)}`;
  const step = (x, w, label, lines, time) => {
    T.push(...node(x, ry, w, rh, "blue", label, lines));
    if (time) T.push(txt(x + 11, ry + 18 + 15 + 2 * 14 + 2, time, boxNote));
  };
  step(16, 160, "PR head", ["components + committed", "__generated__ artifacts"]);
  step(
    230,
    182,
    "relay-compiler",
    ["no-change run, re-validates", "every document"],
    `${dur(fleetCodegenMs)} ${fleetAt}`,
  );
  step(
    464,
    180,
    "git status --porcelain",
    ["-- src/__generated__", "lists untracked paths too"],
    `${dur(fleetStatusMs)} ${fleetAt}`,
  );

  const my = ry + rh / 2;
  T.push(arrow(178, my, 228, my));
  T.push(edgeLabel(203, my - 7, "in CI"));
  T.push(arrow(414, my, 462, my));

  // row 2: the fork. Green under the status node, red to its left so the dashed
  // return into the PR head stays short.
  const fy = ry + rh + 52;
  const fh = 60;
  T.push(
    ...node(444, fy, 200, fh, "green", "clean: the gate passes", [
      "byte-stable on every timed",
      "no-change rerun",
    ]),
  );
  T.push(
    ...node(206, fy, 206, fh, "rust", "dirty: the gate fails", [
      "an edited query changes its",
      "artifact: the drift is caught",
    ]),
  );

  T.push(arrow(555, ry + rh + 2, 555, fy - 2));
  T.push(edgeLabel(563, ry + rh + 28, "nothing listed", "start"));
  T.push(arrow(486, ry + rh + 2, 344, fy - 2));
  T.push(edgeLabel(374, ry + rh + 16, "a changed or", "end"));
  T.push(edgeLabel(374, ry + rh + 29, "untracked path", "end"));

  // the red branch's way back: regenerate, commit, and the gate runs again
  // (dashed: the conditional path, not a timed one)
  const by = fy + fh / 2;
  T.push(dashes(204, by, 96, by));
  T.push(arrow(96, by, 96, ry + rh + 2, true));
  T.push(edgeLabel(104, ry + rh + 30, "regenerate,", "start"));
  T.push(edgeLabel(104, ry + rh + 43, "commit", "start"));

  // the measured cost of one pass
  const vy = fy + fh + 30;
  T.push(txt(16, vy, "one gate pass", { size: FIG.label, weight: "600" }));
  T.push(
    txt(140, vy, `${secs(gateMs)} at ${int(comps)} components`, { size: FIG.value, weight: "650" }),
  );
  T.push(
    txt(140, vy + 16, samples === 1 ? "one sample" : `median of ${plural(samples, "sample")}`, {
      size: FIG.note,
      fill: MUTED,
    }),
  );
  T.push(
    txt(400, vy, `${secs(fleetGateMs)} at ${int(fleetComps)}`, { size: FIG.value, weight: "650" }),
  );
  T.push(
    txt(400, vy + 16, `fleet anchor, ${plural(fleetSamples, "sample")}`, {
      size: FIG.note,
      fill: MUTED,
    }),
  );

  const y = vy + 16 + 34;
  T.push(
    ...footer(y, `bench/relay-codegen-bench.json · relay-compiler ${relayVer} · ${cores} cores`),
  );
  writeFigData("TYPECHECKERS.md", "fig-freshness-gate", "The figure's numbers as a table", {
    head: ["tree", "one gate pass", "codegen", "git status", "samples"],
    rows: [
      [
        `${int(comps)} components`,
        secs(gateMs),
        "— (not split at this size)",
        "— (not split at this size)",
        `${samples} (median)`,
      ],
      [
        `${int(fleetComps)} components (fleet anchor)`,
        secs(fleetGateMs),
        dur(fleetCodegenMs),
        dur(fleetStatusMs),
        String(fleetSamples),
      ],
    ],
    lead: "Artifacts byte-stable on every timed no-change rerun, and an edited query is detected as drift (both asserted by the bench).",
    fields:
      "`bench/relay-codegen-bench.json`: `components`, `samples`, `schemaTypes`, `freshness.{gateMedianMs,gateSamplesMs,byteStable,driftDetected}`; `fleetPoint.{components,samples,codegenNoChangeMs,statusMs,freshnessMs,byteStable}`; `versions.relayCompiler`, `cores`.",
  });
  return svgDoc(
    y + 12,
    `The freshness gate for checked-in codegen artifacts: a no-change relay-compiler run, then git status over the generated directory; nothing listed means the artifacts are byte-stable and the gate passes, a changed or untracked path means an edited query drifted from its artifact and the gate fails. One pass costs ${secs(gateMs)} at ${int(comps)} components and ${secs(fleetGateMs)} at ${int(fleetComps)}.`,
    T,
  );
}

// ============================================================================
// Figure: fig-linker-layouts — what each linker materializes for the same
// workspace (TOOLING.md "Install")
// ============================================================================
function figLinkerLayouts() {
  const scales = need(INSTALL, "scales");
  if (!Array.isArray(scales) || scales.length === 0)
    throw new Error("install-bench has no scales — the figure is invalid");
  // the record carries no canonical flag; install-bench promotes only this scale
  // matrix, and TOOLING.md cites its largest row, so a truncated record must not
  // render a smaller scale here
  const CANON_SCALES = "200:100 1000:200 2000:300";
  if (scales.map((s) => `${count(s, "apps")}:${count(s, "libs")}`).join(" ") !== CANON_SCALES)
    throw new Error(
      `install-bench scales are not the canonical "${CANON_SCALES}" — update the figure and TOOLING.md together`,
    );
  const sc = scales.reduce((a, b) => (count(b, "apps") > count(a, "apps") ? b : a));
  const apps = count(sc, "apps");
  const libs = count(sc, "libs");
  const major = (path) => bareVer(str(INSTALL, path)).split(".")[0];
  const pnpm = `pnpm ${major("pnpmVersion")}`;
  const yarn = `yarn ${major("yarnVersion")}`;
  const n = {
    pnpmHoisted: count(sc, "pnpmHoisted.nmEntries"),
    yarnNm: count(sc, "yarnNm.nmEntries"),
    pnpmIsolated: count(sc, "pnpmIsolated.nmEntries"),
    bun: count(sc, "bun.nmEntries"),
    yarnPnp: count(sc, "yarnPnp.nmEntries"),
  };
  const pnpCjsBytes = count(sc, "yarnPnp.pnpCjsBytes");
  // outcome-shape asserts: PnP is drawn as "no node_modules tree" (its count is
  // the unplugged packages only, the smallest by far), the isolated tree as the
  // one that adds per-package symlink trees on top of the flat one
  const others = [n.pnpmHoisted, n.yarnNm, n.pnpmIsolated, n.bun];
  if (!(n.yarnPnp < Math.min(...others)))
    throw new Error(
      "yarn PnP no longer has the fewest node_modules entries — the figure is invalid",
    );
  if (!(n.pnpmIsolated > n.pnpmHoisted))
    throw new Error(
      "pnpm isolated no longer materializes more than hoisted — the figure is invalid",
    );
  if (pnpCjsBytes <= 0) throw new Error("yarnPnp.pnpCjsBytes is empty — no .pnp.cjs was written");
  const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

  const PW = 196; // panel width
  const PX = [16, 232, 448];
  const TOP = 34; // the figure title band; the panels are drawn below it
  const T = [...figTitle(16, 24, "What each linker writes for the same workspace").parts];
  T.push(`<g transform="translate(0 ${TOP})">`);
  const CHIP = FIG.body; // chip label size: a chip is a bordered box (MIN_BOX_TEXT)
  const chip = (x, y, w, label) => {
    T.push(
      `<rect x="${x}" y="${y}" width="${w}" height="20" rx="4" fill="${BG}" stroke="${TINT.blue[1]}" stroke-width="1"/>`,
    );
    T.push(txt(x + w / 2, y + 14, label, { size: CHIP, anchor: "middle" }));
  };
  const head = (x, title, sub) => {
    T.push(txt(x, 22, title, { size: FIG.label, weight: "600" }));
    T.push(txt(x, 38, sub, { size: FIG.note, fill: MUTED }));
  };
  const mid = (x) => x + PW / 2;
  const BOT = 220; // every panel's diagram ends on this line
  const B3 = BOT - 26; // the top of the bottom box in panels 2 and 3
  // a row of chips across the panel's inner width (PW - 20): each chip its label's
  // measured width plus padding, the leftover shared evenly, so no label meets its edge
  const chipRow = (x, y, labels) => {
    const cg = 5.5;
    const inner = PW - 20;
    const ws = labels.map((l) => approxW(l, CHIP) + 10);
    const extra =
      (inner - ws.reduce((a, b) => a + b, 0) - cg * (labels.length - 1)) / labels.length;
    if (extra < 0) throw new Error(`chips ${labels.join(", ")} do not fit the ${inner}px panel`);
    let cx = x + 10;
    labels.forEach((l, i) => {
      const w = +(ws[i] + extra).toFixed(1);
      chip(cx, y, w, l);
      cx = +(cx + w + cg).toFixed(1);
    });
  };
  // split a path after its slashes into lines that fit `maxW` at `size` (a path has no
  // spaces for wrapPx to break at)
  const pathLines = (path, size, maxW) => {
    const out = [];
    let line = "";
    for (const part of path.match(/[^/]*\/|[^/]+$/g)) {
      if (line && approxW(line + part, size) > maxW) {
        out.push(line);
        line = part;
      } else line += part;
    }
    out.push(line);
    for (const l of out)
      if (approxW(l, size) > maxW) throw new Error(`"${l}" does not fit ${maxW}px`);
    return out;
  };

  // panel 1: hoisted — every package once, one level, at the workspace root
  {
    const x = PX[0];
    head(x, "hoisted: one flat tree", "pnpm hoisted · yarn node-modules");
    T.push(box(x, 52, PW, 28, "blue"));
    T.push(txt(x + 10, 70, "apps/<app> imports react", { size: FIG.body }));
    T.push(arrow(mid(x), 83, mid(x), 107));
    T.push(txt(mid(x) + 8, 99, "walks up to the root", { size: FIG.edge, fill: MUTED }));
    T.push(box(x, 110, PW, BOT - 110, "blue"));
    T.push(txt(x + 10, 128, "root node_modules/", { size: FIG.body, weight: "600" }));
    // grouped so each row fits the panel at the box-text size
    chipRow(x, 138, ["next", "react", "@demo libs"]);
    chipRow(x, 164, ["react-dom", "typescript", "· · ·"]);
    T.push(txt(x + 10, BOT - 8, "every package on one level", boxNote));
  }
  // panel 2: isolated — a per-package symlink tree over the virtual store, whose
  // files are linked from the content-addressable store
  {
    const x = PX[1];
    head(x, "isolated: symlink tree", "pnpm default (bun: node_modules/.bun)");
    T.push(box(x, 52, PW, 36, "blue"));
    T.push(txt(x + 10, 67, "apps/<app>/node_modules/", { size: FIG.body, weight: "600" }));
    T.push(txt(x + 10, 81, "react: a symlink", { size: FIG.body }));
    T.push(arrow(mid(x), 91, mid(x), 117, true));
    T.push(txt(mid(x) + 8, 108, "symlink", { size: FIG.edge, fill: MUTED }));
    const store = pathLines("react@<ver>/node_modules/react", FIG.body, PW - 20);
    const b2 = 8 + 14 * (1 + store.length); // the box's height for its lines
    T.push(box(x, 120, PW, b2, "blue"));
    T.push(txt(x + 10, 135, "node_modules/.pnpm/", { size: FIG.body, weight: "600" }));
    store.forEach((l, i) => T.push(txt(x + 10, 149 + 14 * i, l, { size: FIG.body })));
    T.push(arrow(mid(x), 120 + b2 + 3, mid(x), B3 - 3));
    T.push(
      txt(mid(x) + 8, (120 + b2 + B3) / 2 + 4, "files linked from", {
        size: FIG.edge,
        fill: MUTED,
      }),
    );
    T.push(box(x, B3, PW, BOT - B3, "blue"));
    T.push(txt(x + 10, B3 + 17, "content-addressable store", { size: FIG.body, weight: "600" }));
  }
  // panel 3: PnP — no node_modules; one resolver table over the cache zips
  {
    const x = PX[2];
    head(x, "Plug'n'Play: one table", "yarn default · no node_modules tree");
    T.push(box(x, 52, PW, 28, "blue"));
    T.push(txt(x + 10, 70, "apps/<app> imports react", { size: FIG.body }));
    T.push(arrow(mid(x), 83, mid(x), 103));
    T.push(txt(mid(x) + 8, 97, "PnP loader", { size: FIG.edge, fill: MUTED }));
    T.push(box(x, 106, PW, 52, "blue"));
    T.push(txt(x + 10, 123, ".pnp.cjs: one resolver table", { size: FIG.body, weight: "600" }));
    T.push(txt(x + 10, 137, "react → its cache zip", { size: FIG.body }));
    T.push(txt(x + 10, 150, "native pkg → unplugged dir", { size: FIG.body }));
    T.push(arrow(mid(x), 161, mid(x), B3 - 3));
    T.push(box(x, B3, PW, BOT - B3, "blue"));
    T.push(txt(x + 10, B3 + 17, "global cache: package zips", { size: FIG.body, weight: "600" }));
  }

  // measured footprint under each panel: node_modules entries on one shared
  // linear scale (the largest count spans the panel)
  const cy = BOT + 22;
  const maxN = Math.max(...others, n.yarnPnp);
  const MIN_BAR = 1.5;
  // a bar too thin to see is drawn at MIN_BAR, and the scale line says so
  const clamped = [...others, n.yarnPnp].some((v) => (v / maxN) * PW < MIN_BAR);
  T.push(
    txt(
      16,
      cy,
      `node_modules entries at ${int(apps)} apps / ${int(libs)} libs, one linear scale` +
        (clamped ? ` (a bar under ${MIN_BAR}px is drawn at ${MIN_BAR}px)` : ""),
      { size: FIG.note, fill: MUTED },
    ),
  );
  const row = (x, y, label, v, tool) => {
    T.push(txt(x, y, label, { size: FIG.body, weight: "600" }));
    T.push(txt(x + PW, y, int(v), { size: FIG.body, weight: "650", anchor: "end" }));
    const w = Math.max(MIN_BAR, +((v / maxN) * PW).toFixed(1));
    T.push(
      `<rect x="${x}" y="${y + 6}" width="${w}" height="8" rx="${Math.min(3, w / 2)}" fill="${TOOL_COLORS[tool]}"/>`,
    );
  };
  const r1 = cy + 22;
  const r2 = r1 + 32;
  row(PX[0], r1, `${pnpm} hoisted`, n.pnpmHoisted, "pnpm");
  row(PX[0], r2, `${yarn} node-modules`, n.yarnNm, "yarn");
  row(PX[1], r1, `${pnpm} isolated`, n.pnpmIsolated, "pnpm");
  row(PX[1], r2, "bun", n.bun, "bun");
  row(PX[2], r1, `${yarn} PnP`, n.yarnPnp, "yarn");
  // PnP's count is files inside the unplugged native packages, not a tree
  T.push(txt(PX[2], r2, "all inside unplugged native", { size: FIG.note, fill: MUTED }));
  T.push(
    txt(PX[2], r2 + 13, `packages · .pnp.cjs ${mb(pnpCjsBytes)}`, { size: FIG.note, fill: MUTED }),
  );
  T.push("</g>");

  const y = TOP + r2 + 46;
  T.push(
    ...footer(
      y,
      `bench/install-bench.json · pnpm ${str(INSTALL, "pnpmVersion")} · bun ${str(INSTALL, "bunVersion")} · yarn ${str(INSTALL, "yarnVersion")}`,
    ),
  );
  writeFigData("TOOLING.md", "fig-linker-layouts", "The figure's numbers as a table", {
    align: ["l", "l"],
    head: ["linker", "node_modules entries"],
    rows: [
      [`${pnpm} hoisted`, int(n.pnpmHoisted)],
      [`${yarn} node-modules`, int(n.yarnNm)],
      [`${pnpm} isolated`, int(n.pnpmIsolated)],
      ["bun (isolated)", int(n.bun)],
      [
        `${yarn} PnP`,
        `${int(n.yarnPnp)} (inside unplugged native packages; .pnp.cjs ${mb(pnpCjsBytes)})`,
      ],
    ],
    lead: `At ${int(apps)} apps / ${int(libs)} libs. An entry is a path under any \`node_modules\` directory.`,
    fields:
      "`bench/install-bench.json`: `scales[].apps` and `scales[].libs` (the scale matrix; the figure draws the largest), and at that scale `pnpmHoisted.nmEntries`, `yarnNm.nmEntries`, `pnpmIsolated.nmEntries`, `bun.nmEntries`, `yarnPnp.nmEntries`, `yarnPnp.pnpCjsBytes`; `pnpmVersion`, `bunVersion`, `yarnVersion`.",
  });
  return svgDoc(
    y + 12,
    `What each linker materializes for the same ${int(apps)}-app workspace: a hoisted linker writes one flat node_modules at the root (${int(n.pnpmHoisted)} entries under pnpm, ${int(n.yarnNm)} under yarn), pnpm's isolated linker writes a per-package symlink tree over a virtual store linked from the content-addressable store (${int(n.pnpmIsolated)} entries), and yarn Plug'n'Play writes no node_modules tree, only a .pnp.cjs resolver table over cache zips and unplugged native packages (${int(n.yarnPnp)} entries, all inside the unplugged packages).`,
    T,
  );
}

// ============================================================================
// Figure: fig-next-pnp-node — next build under PnP, builder × linker/node
// (TOOLING.md "yarn PnP toolchain compatibility")
// ============================================================================
function figNextPnpNode() {
  if (flag(RSPACK_PNP, "canonical") !== true)
    throw new Error("rspack-pnp-bench record is not canonical — the figure is invalid");
  const nodeVer = bareVer(str(RSPACK_PNP, "versions.node"));
  const ctlVer = bareVer(str(RSPACK_PNP, "versions.controlNode"));
  if (nodeVer === ctlVer) throw new Error("the control node is the bench's node — no contrast");
  if (str(RSPACK_PNP, "matrix.pnpControlNode.node") !== str(RSPACK_PNP, "versions.controlNode"))
    throw new Error("the control-node group did not run on the recorded control node");
  const nextVer = str(RSPACK_PNP, "versions.next");
  const yarnVer = str(RSPACK_PNP, "versions.yarn");

  // classify one cell from the record's own evidence; anything that does not fit
  // exactly one of the three drawn outcomes throws
  const PROOF = {
    turbopack: "turbopackBanner",
    webpack: "webpackCompilationSpan",
    rspack: "rspackBanner",
  };
  const classify = (group, linker, builder) => {
    const at = `matrix.${group}.${builder}`;
    const c = need(RSPACK_PNP, at);
    const bad = (why) => new Error(`${at}: ${why} — the figure is invalid`);
    if (str(c, "linker") !== linker || str(c, "builder") !== builder)
      throw bad("linker/builder do not match the cell's position");
    const exit = num(c, "exit");
    const ok = flag(c, "ok");
    const crash = flag(c, "configLoadCrash");
    const resolve = flag(c, "pnpResolveFailure");
    const output = flag(c, "outputPresent");
    const ran = Object.fromEntries(Object.entries(PROOF).map(([b, k]) => [b, flag(c, k)]));
    const ranOnly = (b) => Object.entries(ran).every(([k, v]) => v === (k === b));
    if (ok) {
      if (exit !== 0 || !output || crash || resolve) throw bad("ok, with failure evidence");
      if (!ranOnly(builder)) throw bad("built, but the compiler proof names another bundler");
      return "builds";
    }
    if (exit === 0 || output) throw bad("failed, with a clean exit or a populated .next");
    if (crash && !resolve) {
      if (Object.values(ran).some(Boolean) || flag(c, "dotNextPresent"))
        throw bad("config-load crash, yet a bundler started");
      return "configLoad";
    }
    if (resolve && !crash) {
      if (builder !== "turbopack" || !ranOnly("turbopack"))
        throw bad("a next/package.json resolution failure outside Turbopack");
      if (!str(c, "pnpResolveFailureLine").includes("next/package.json"))
        throw bad("resolution-failure line does not name next/package.json");
      return "resolve";
    }
    throw bad("failure matches neither recorded signature");
  };

  // the middle column is labeled "the same PnP trees": the record must say each
  // tree was unchanged between the bench-node build and the control-node build
  for (const b of Object.keys(PROOF))
    if (flag(RSPACK_PNP, `matrix.pnp.${b}.treeUnchanged`) !== true)
      throw new Error(
        `matrix.pnp.${b}.treeUnchanged is not true — "the same PnP trees" is invalid`,
      );

  const BUILDERS = [
    ["turbopack", "Turbopack", "next build"],
    ["webpack", "webpack", "next build --webpack"],
    ["rspack", "rspack", "next-rspack"],
  ];
  // every cell must be on the side the figure draws (the column notes below state
  // these outcomes in words)
  const GROUPS = [
    {
      key: "pnp",
      linker: "pnp",
      title: "Yarn PnP",
      sub: `node ${nodeVer} (the bench's node)`,
      expect: { turbopack: "configLoad", webpack: "configLoad", rspack: "configLoad" },
      note: ["one crash for all three, before", "a bundler is selected"],
    },
    {
      key: "pnpControlNode",
      linker: "pnp",
      title: "the same PnP trees",
      sub: `node ${ctlVer} (control node)`,
      expect: { turbopack: "resolve", webpack: "builds", rspack: "builds" },
      note: ["the bundlers separate: Turbopack", "has no PnP resolver"],
    },
    {
      key: "nm",
      linker: "nm",
      title: "node-modules linker",
      sub: `node ${nodeVer}`,
      expect: { turbopack: "builds", webpack: "builds", rspack: "builds" },
      note: ["control: the same app builds,", "so the failures are PnP's"],
    },
  ];
  const DRAW = {
    builds: { tint: "green", main: "builds", sub: "exit 0, .next populated" },
    configLoad: { tint: "rust", main: "fails at config load", sub: "crash loading next.config" },
    resolve: { tint: "rust", main: "fails in Turbopack", sub: "next/package.json not found" },
  };

  const T = [];
  T.push(
    ...figTitle(
      16,
      24,
      "next build under Yarn PnP: the node version decides",
      `one App Router app, three builders · next ${nextVer} · yarn ${yarnVer}`,
    ).parts,
  );
  const CX = [134, 306, 478];
  const CW = 166;
  const y0 = 96;
  // each cell: a bold first line, then its note wrapped to the cell's inner width; every
  // cell is as tall as the most lines any outcome needs
  const inner = CW - 24;
  for (const d of Object.values(DRAW)) {
    if (approxW(d.main, FIG.body, true) > inner)
      throw new Error(`"${d.main}" does not fit the ${inner}px cell`);
    d.lines = wrapPx(d.sub, FIG.body, inner);
  }
  const ch = 33 + 15 * Math.max(...Object.values(DRAW).map((d) => d.lines.length));
  const gap = 6;
  BUILDERS.forEach(([, label, how], r) => {
    const y = y0 + r * (ch + gap);
    T.push(txt(16, y + 21, label, { size: FIG.label, weight: "600" }));
    T.push(txt(16, y + 36, how, { size: FIG.note, fill: MUTED }));
  });
  GROUPS.forEach((g, c) => {
    const x = CX[c];
    T.push(txt(x, 70, g.title, { size: FIG.label, weight: "600" }));
    T.push(txt(x, 85, g.sub, { size: FIG.note, fill: MUTED }));
    BUILDERS.forEach(([builder], r) => {
      const kind = classify(g.key, g.linker, builder);
      if (kind !== g.expect[builder])
        throw new Error(
          `matrix.${g.key}.${builder} is "${kind}", the figure draws "${g.expect[builder]}" — update the figure`,
        );
      const d = DRAW[kind];
      const y = y0 + r * (ch + gap);
      T.push(box(x, y, CW, ch, d.tint));
      T.push(txt(x + 12, y + 21, d.main, { size: FIG.body, weight: "600" }));
      d.lines.forEach((l, i) => T.push(txt(x + 12, y + 36 + 15 * i, l, boxNote)));
    });
    const ny = y0 + BUILDERS.length * (ch + gap) + 10;
    g.note.forEach((line, i) =>
      T.push(txt(x, ny + 4 + i * 13, line, { size: FIG.note, fill: MUTED })),
    );
  });

  const y = y0 + BUILDERS.length * (ch + gap) + 10 + 13 + 34;
  T.push(...footer(y, "bench/rspack-pnp-bench.json · matrix.{pnp,pnpControlNode,nm}"));
  writeFigData("TOOLING.md", "fig-next-pnp-node", "The figure's numbers as a table", {
    align: ["l", "l", "l", "l"],
    head: ["builder", ...GROUPS.map((g) => `${g.title}: ${g.sub}`)],
    rows: BUILDERS.map(([b, label, how]) => [
      `${label} (\`${how}\`)`,
      ...GROUPS.map((g) => DRAW[g.expect[b]].main),
    ]),
    fields:
      "`bench/rspack-pnp-bench.json`: per cell `matrix.{pnp,pnpControlNode,nm}.{turbopack,webpack,rspack}` — `linker`, `builder`, `ok`, `exit`, `outputPresent`, `configLoadCrash`, `pnpResolveFailure`, `turbopackBanner`, `rspackBanner`, `webpackCompilationSpan`; `dotNextPresent` on a config-load cell, `pnpResolveFailureLine` on the resolution-failure cell, `treeUnchanged` on the three `matrix.pnp` cells; `matrix.pnpControlNode.node`, `versions.node`, `versions.controlNode`, `versions.next`, `versions.yarn`, `canonical`.",
  });
  return svgDoc(
    y + 12,
    `next build under Yarn PnP by node version: on node ${nodeVer} Turbopack, webpack and rspack all crash while loading next.config, before a bundler is selected; the same PnP trees on node ${ctlVer} build with webpack and rspack while Turbopack fails to resolve next/package.json; under the node-modules linker on node ${nodeVer} all three build.`,
    T,
  );
}

// ============================================================================
// Figure: fig-remote-cache — one runner seeds the shared cache, the rest restore
// (LIMITS.md "Remote Cache")
// ============================================================================
function figRemoteCache() {
  const cores = count(CI_CACHE, "env.cores");
  const server = str(CI_CACHE, "versions.remoteCacheServer");
  // the figure labels the restore as the localhost floor (no network latency)
  if (!str(CI_CACHE, "remoteCache.transport").startsWith("localhost"))
    throw new Error("remote cache transport is no longer localhost — update the figure's label");
  const headline = need(CI_CACHE, "headline");
  if (!Array.isArray(headline) || headline.length === 0)
    throw new Error("ci-cache-bench has no headline rows — the figure is invalid");
  const rows = headline.map((h, i) => {
    const r = {
      task: str(h, "task"),
      apps: count(h, "apps"),
      libs: count(h, "libs"),
      totalTasks: count(h, "totalTasks"),
      coldMs: posMs(h, "coldNoRemoteMs"),
      seedMs: posMs(h, "coldSeedMs"),
      restoreMs: posMs(h, "restoreMs"),
      speedup: num(h, "speedupVsCold"),
    };
    // outcome-shape asserts: restore is drawn as the short (green) bar, and the
    // printed ×N is the record's own ratio of the two drawn bars
    if (!(r.restoreMs < r.coldMs))
      throw new Error(`headline[${i}]: restore is not faster than no-cache cold — figure invalid`);
    if (Math.abs(r.coldMs / r.restoreMs - r.speedup) > 0.051)
      throw new Error(`headline[${i}]: speedupVsCold is not coldNoRemoteMs / restoreMs`);
    return r;
  });
  const pi = need(CI_CACHE, "partialInvalidation");
  // the record carries no canonical flag and the bench's scale knobs write the
  // same filename; LIMITS.md cites these rows, so another matrix must not render
  const CANON_ROWS = "typecheck@300:100 typecheck@1000:200 build@300:100";
  const CANON_PARTIAL = "typecheck@300:100";
  const rowKey = (o) => {
    const scale = str(o, "scale");
    if (scale !== `${count(o, "apps")}:${count(o, "libs")}`)
      throw new Error(`ci-cache-bench: scale "${scale}" does not match its apps/libs`);
    return `${str(o, "task")}@${scale}`;
  };
  if (headline.map(rowKey).join(" ") !== CANON_ROWS || rowKey(pi) !== CANON_PARTIAL)
    throw new Error(
      `ci-cache-bench rows are not the canonical "${CANON_ROWS}" + partial "${CANON_PARTIAL}" — update the figure and LIMITS.md together`,
    );
  // likewise the bench's default sample counts and concurrency (its other
  // number-moving knobs). The machine is not pinned: it is read and labeled.
  const CANON_KNOBS = { cold: 2, buildCold: 1, restore: 3, concurrency: "100%" };
  if (
    count(CI_CACHE, "samples.cold") !== CANON_KNOBS.cold ||
    count(CI_CACHE, "samples.buildCold") !== CANON_KNOBS.buildCold ||
    count(CI_CACHE, "samples.restore") !== CANON_KNOBS.restore ||
    str(CI_CACHE, "concurrency") !== CANON_KNOBS.concurrency
  )
    throw new Error(
      `ci-cache-bench was not run at the default knobs (${JSON.stringify(CANON_KNOBS)}) — update the figure and LIMITS.md together`,
    );
  const piTotal = count(pi, "totalTasks");
  const edits = ["leaf", "foundation"].map((k) => {
    const e = {
      kind: k,
      lib: str(pi, `${k}.lib`),
      restored: count(pi, `${k}.restored`),
      recomputed: count(pi, `${k}.recomputed`),
    };
    if (count(pi, `${k}.total`) !== piTotal || e.restored + e.recomputed !== piTotal)
      throw new Error(`partialInvalidation.${k}: restored + recomputed != totalTasks`);
    return e;
  });
  const [leaf, foundation] = edits;
  // the contrast the figure draws: a leaf edit still restores most tasks, a
  // foundation edit restores none
  if (foundation.restored !== 0)
    throw new Error("a foundation edit restored tasks — the all-recomputed bar is invalid");
  if (!(leaf.restored > leaf.recomputed))
    throw new Error("a leaf edit no longer restores most tasks — the figure is invalid");

  const T = [];
  T.push(
    ...figTitle(
      16,
      24,
      "A shared cache: one runner seeds, the rest restore",
      `${cores} cores · ${server} on localhost: restore without network latency`,
    ).parts,
  );

  // the mechanism: seed -> cache -> restore fan
  const ay = 62;
  const ah = 70;
  T.push(
    ...node(16, ay, 178, ah, "rust", "runner 1: the seed", [
      "empty local cache: computes",
      "every task, uploads outputs",
    ]),
  );
  T.push(
    ...node(242, ay, 176, ah, "blue", "shared cache", [
      "task outputs, keyed by a",
      "hash of the task's inputs",
    ]),
  );
  const amy = ay + ah / 2;
  T.push(arrow(196, amy, 240, amy));
  T.push(edgeLabel(218, amy - 7, "upload"));
  ["runner 2: restores", "runner 3: restores", null, "runner R: restores"].forEach((label, i) => {
    const yy = ay - 8 + i * 24;
    if (label === null) {
      T.push(txt(555, yy + 12, "· · ·", { size: FIG.body, fill: MUTED, anchor: "middle" }));
      return;
    }
    T.push(box(466, yy, 178, 20, "green", 4));
    T.push(txt(478, yy + 14, label, { size: FIG.body }));
    T.push(arrow(420, amy, 464, yy + 10));
  });

  // per task: no-cache cold compute vs restore, bars on one linear scale
  const BX = 240;
  const BW = 262;
  let y = ay + ah + 34;
  T.push(
    txt(16, y, "per task: no-cache cold compute vs restore", { size: FIG.label, weight: "600" }),
  );
  const maxMs = Math.max(...rows.map((r) => r.coldMs));
  // a bar too thin to see is drawn at MIN_BAR, and the section's scale note says so
  const MIN_BAR = 2;
  const minNote = (widths) =>
    widths.some((w) => w < MIN_BAR) ? ` (a bar under ${MIN_BAR}px is drawn at ${MIN_BAR}px)` : "";
  // the heat charts' grammar: the faster side is the ramp's green, the slower side a
  // neutral slate carrying its ×N; both clear 3:1 against the page in both themes
  const FILL = { fast: rgbCss(rampRGB(1)), slow: SLATE };
  const bar = (x, yy, w, kind) => {
    const bw = +Math.max(MIN_BAR, w).toFixed(1);
    return `<rect x="${x}" y="${yy}" width="${bw}" height="11" rx="${Math.min(2.5, bw / 2)}" fill="${FILL[kind]}"/>`;
  };
  T.push(
    txt(
      644,
      y,
      "one linear scale" +
        minNote(rows.flatMap((r) => [r.coldMs, r.restoreMs]).map((ms) => (ms / maxMs) * BW)),
      { size: FIG.note, fill: MUTED, anchor: "end" },
    ),
  );
  y += 12;
  for (const r of rows) {
    T.push(
      txt(16, y + 12, `${r.task} · ${int(r.apps)} apps / ${int(r.libs)} libs`, {
        size: FIG.body,
        weight: "600",
      }),
    );
    T.push(
      txt(16, y + 27, `${int(r.totalTasks)} tasks · seed run ${secs(r.seedMs)}`, {
        size: FIG.note,
        fill: MUTED,
      }),
    );
    const cw = (r.coldMs / maxMs) * BW;
    const rw = (r.restoreMs / maxMs) * BW;
    T.push(bar(BX, y + 2, cw, "slow"));
    T.push(
      txt(BX + cw + 7, y + 11.5, `${secs(r.coldMs)} cold · ×${r.speedup.toFixed(1)}`, {
        size: FIG.note,
        fill: MUTED,
      }),
    );
    T.push(bar(BX, y + 18, rw, "fast"));
    T.push(
      txt(BX + rw + 7, y + 27.5, `${secs(r.restoreMs)} restore`, {
        size: FIG.body,
        weight: "600",
      }),
    );
    y += 42;
  }

  // partial invalidation: what still restores after an edit
  y += 14;
  T.push(txt(16, y, "after an edit: what still restores", { size: FIG.label, weight: "600" }));
  T.push(
    txt(
      644,
      y,
      `${str(pi, "task")}, ${int(count(pi, "apps"))} apps / ${int(count(pi, "libs"))} libs, ${int(piTotal)} tasks` +
        minNote(
          edits.flatMap((e) =>
            [e.restored, e.recomputed].filter((v) => v > 0).map((v) => (v / piTotal) * BW - 1),
          ),
        ),
      { size: FIG.note, fill: MUTED, anchor: "end" },
    ),
  );
  y += 12;
  for (const e of edits) {
    T.push(txt(16, y + 12, `${e.kind}-lib edit`, { size: FIG.body, weight: "600" }));
    T.push(txt(16, y + 27, e.lib, { size: FIG.note, fill: MUTED }));
    // one bar of all the tasks, split restored (green) | recomputed (rust)
    const gw = +((e.restored / piTotal) * BW).toFixed(1);
    if (e.restored > 0) T.push(bar(BX, y + 6, e.recomputed > 0 ? gw - 1 : gw, "fast"));
    if (e.recomputed > 0)
      T.push(
        bar(e.restored > 0 ? BX + gw + 1 : BX, y + 6, e.restored > 0 ? BW - gw - 1 : BW, "slow"),
      );
    T.push(
      txt(BX + BW + 7, y + 12, `${int(e.restored)} of ${int(piTotal)} restored`, {
        size: FIG.body,
        weight: "600",
      }),
    );
    T.push(
      txt(BX + BW + 7, y + 26, `${int(e.recomputed)} recomputed`, { size: FIG.note, fill: MUTED }),
    );
    y += 40;
  }

  y += 16;
  T.push(...footer(y, "bench/ci-cache-bench.json · headline · partialInvalidation"));
  writeFigData("LIMITS.md", "fig-remote-cache", "The figure's numbers as a table", {
    head: ["task", "tasks", "no-cache cold", "seed run", "restore", "cold / restore"],
    rows: rows.map((r) => [
      `${r.task} · ${int(r.apps)} apps / ${int(r.libs)} libs`,
      int(r.totalTasks),
      secs(r.coldMs),
      secs(r.seedMs),
      secs(r.restoreMs),
      `×${r.speedup.toFixed(1)}`,
    ]),
    lead: `After an edit (${str(pi, "task")}, ${int(count(pi, "apps"))} apps / ${int(count(pi, "libs"))} libs, ${int(piTotal)} tasks): a leaf-lib edit (\`${leaf.lib}\`) leaves ${int(leaf.restored)} restored and ${int(leaf.recomputed)} recomputed; a foundation-lib edit (\`${foundation.lib}\`) leaves ${int(foundation.restored)} restored and ${int(foundation.recomputed)} recomputed. Restore runs against ${server} on localhost, ${cores} cores.`,
    fields:
      "`bench/ci-cache-bench.json`: per `headline` row `task`, `scale`, `apps`, `libs`, `totalTasks`, `coldNoRemoteMs`, `coldSeedMs`, `restoreMs`, `speedupVsCold`; `partialInvalidation` — `task`, `scale`, `apps`, `libs`, `totalTasks`, and per `leaf`/`foundation` `lib`, `restored`, `recomputed`, `total`; `env.cores`, `versions.remoteCacheServer`, `remoteCache.transport`, `samples.{cold,buildCold,restore}`, `concurrency`.",
  });
  const r0 = rows[0];
  return svgDoc(
    y + 12,
    `A shared Turborepo cache: the first runner computes every task and uploads the outputs, and every later runner with the same task inputs restores them instead of recomputing (${r0.task} at ${int(r0.apps)} apps: ${secs(r0.restoreMs)} restore versus ${secs(r0.coldMs)} no-cache cold). After a leaf-lib edit ${int(leaf.restored)} of ${int(piTotal)} tasks still restore; after a foundation-lib edit ${int(foundation.restored)} do.`,
    T,
  );
}

const FIGURES = {
  "fig-sliced-gate": figSlicedGate,
  "fig-blast-radius": figBlastRadius,
  "fig-orepo-oclosure": figOrepoOclosure,
  "fig-save-loop": figSaveLoop,
  "fig-freshness-gate": figFreshnessGate,
  "fig-linker-layouts": figLinkerLayouts,
  "fig-next-pnp-node": figNextPnpNode,
  "fig-remote-cache": figRemoteCache,
};
// no arguments renders every figure (the CI path); naming figures renders only
// those, and an unknown name is an error rather than a silent no-op
const only = process.argv.slice(2);
for (const name of only)
  if (!Object.hasOwn(FIGURES, name))
    throw new Error(`unknown figure "${name}" — one of: ${Object.keys(FIGURES).join(", ")}`);
for (const [name, draw] of Object.entries(FIGURES))
  if (only.length === 0 || only.includes(name)) emit(name, draw());

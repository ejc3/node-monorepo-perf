#!/usr/bin/env node
// Mechanism figures for the diagram-heavy reports (diagram-style-spec.md):
//   fig-sliced-gate     — one-program gate vs the K-slice fan vs the union check (FLEET.md)
//   fig-blast-radius    — foundation rev turns the whole fleet red; a leaf rev doesn't (FLEET.md)
//   fig-orepo-oclosure  — the thesis: a whole-repo selection vs one app's closure (README.md)
//   fig-save-loop       — one edit to a verdict at 1M modules, a lane per mechanic (TYPECHECKERS.md)
//   fig-freshness-gate  — codegen, then git status, then the green/red fork (TYPECHECKERS.md)
//   fig-linker-layouts  — what hoisted / isolated / PnP linkers materialize (TOOLING.md)
//   fig-next-pnp-node   — next build under PnP: builder x linker/node outcome matrix (TOOLING.md)
//   fig-remote-cache    — one runner seeds the shared cache, the rest restore (LIMITS.md)
// Deterministic from the cited bench JSONs (no Date, no hand numbers; missing or
// renamed fields throw) -> bench/charts/fig-*.svg + a 300 DPI PNG each, one step.
//
//   node scripts/figures.mjs                  (make figures: every figure)
//   node scripts/figures.mjs fig-save-loop    (only the named figures, while iterating)

import { readFileSync } from "node:fs";
import {
  BG,
  MUTED,
  GRID,
  TINT,
  TOOL_COLORS,
  box,
  txt,
  arrow,
  dashes,
  approxW,
  footer as footerLine,
  svgDoc as svgDocW,
  emitChart,
  assertComparable,
  bareVer,
  NEAR_TIE_MAX,
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
const secs2 = (ms) => `${(ms / 1000).toFixed(2)}s`;
// sub-second times stay in ms (a 324ms recheck is not "0.3s")
const dur = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : secs(ms));
const gb = (mb) => `${(mb / 1000).toFixed(1)}GB`;
const int = (n) => n.toLocaleString("en-US");

// the shared visual language lives in scripts/_chartstyle.mjs (palette, dark-mode
// block, box/txt/arrow grammar, emit); these figures keep the spec's 660 canvas
const W = 660;
const svgDoc = (h, aria, body) => svgDocW(W, h, aria, body);
const footer = (y, sources) => footerLine(W, y, sources);
const emit = (name, svg) => emitChart(name, svg, { strict: true });

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
  // column headers: the wall-clock headline per mechanism
  T.push(txt(16, 24, "one tsgo program", { size: 13, weight: "600" }));
  T.push(txt(16, 45, `${secs(c64.wholeMs)} · ${c64.cores}c`, { size: 16, weight: "700" }));
  T.push(txt(118, 45, `${secs(c192.wholeMs)} · ${c192.cores}c`, { size: 16, weight: "700" }));
  T.push(txt(258, 24, "K concurrent slices", { size: 13, weight: "600" }));
  T.push(txt(258, 45, `${secs(c64.bestKWallMs)} · ${c64.cores}c`, { size: 16, weight: "700" }));
  T.push(txt(352, 45, `${secs(c192.bestKWallMs)} · ${c192.cores}c`, { size: 16, weight: "700" }));
  T.push(txt(492, 24, "union check", { size: 13, weight: "600" }));
  T.push(txt(492, 45, "verdict identical", { size: 16, weight: "700" }));

  // left: the one-program box (rust: the slow, mostly-idle path)
  const by = 64;
  T.push(box(16, by, 196, 128, "rust"));
  T.push(txt(30, by + 22, "whole workspace, one process", { size: 11.5, weight: "600" }));
  T.push(txt(30, by + 41, `${int(apps)} apps + all lib source`, { size: 11 }));
  T.push(txt(30, by + 60, `${gb(c64.wholeRssMB)} peak RSS`, { size: 11.5, weight: "600" }));
  T.push(
    txt(30, by + 79, `${c64.wholeCpuPct}% CPU of ${int(c64.cores * 100)}% (${c64.cores}c)`, {
      size: 11,
    }),
  );
  T.push(
    txt(30, by + 96, `${int(c192.wholeCpuPct)}% of ${int(c192.cores * 100)}% (${c192.cores}c)`, {
      size: 11,
    }),
  );
  T.push(txt(30, by + 114, "— most of either box idle", { size: 10.5, fill: MUTED }));

  // middle: the slice fan (green: the fast path). Five drawn boxes + an
  // ellipsis stand for the K slices; K is labeled, not drawn one-per-slice.
  const sx = 258;
  const sw = 178;
  const sliceH = 20;
  const gap = 7;
  for (let i = 0; i < 4; i++) {
    const yy = by + i * (sliceH + gap);
    T.push(box(sx, yy, sw, sliceH, "green", 5));
    T.push(
      txt(sx + 10, yy + 14, i === 0 ? "all lib source + 1/K of the apps" : `slice ${i + 1}`, {
        size: 10.5,
      }),
    );
  }
  const elY = by + 4 * (sliceH + gap);
  T.push(
    txt(sx + sw / 2, elY + 10, "· · · K slices, run concurrently", {
      size: 10.5,
      fill: MUTED,
      anchor: "middle",
    }),
  );
  T.push(box(sx, elY + 18, sw, sliceH, "green", 5));
  T.push(txt(sx + 10, elY + 32, "slice K", { size: 10.5 }));
  T.push(
    txt(sx, elY + 58, `max slice RSS ${gb(c64.sliceRssMB)} (K=${c64.bestK}, ${c64.cores}c)`, {
      size: 11,
      weight: "600",
    }),
  );
  T.push(
    txt(sx, elY + 74, `${gb(c192.sliceRssMB)} (K=${c192.bestK}, ${c192.cores}c)`, { size: 11 }),
  );
  const tieNotes = rows.map((r) => r.tieNote).filter(Boolean);
  tieNotes.forEach((t, i) => T.push(txt(sx, elY + 90 + i * 14, t, { size: 10.5, fill: MUTED })));

  // right: the union-check box (green: the verdict matches)
  const ux = 492;
  const uw = 152;
  const uy = by + 24;
  T.push(box(ux, uy, uw, 96, "green"));
  T.push(txt(ux + 12, uy + 22, "breaking-rev union", { size: 11.5, weight: "600" }));
  T.push(
    txt(ux + 12, uy + 44, `${int(c64.unionLocations)} = ${int(c64.wholeLocations)}`, {
      size: 14,
      weight: "700",
    }),
  );
  T.push(txt(ux + 12, uy + 62, "error locations,", { size: 10.5 }));
  T.push(txt(ux + 12, uy + 76, "slices vs whole program", { size: 10.5 }));

  // edges: partition (one program -> slices), then the slices' error-location
  // union -> the check box (which compares it against the whole-program set)
  T.push(arrow(216, by + 56, 252, by + 56));
  T.push(txt(234, by + 48, "split", { size: 9.5, fill: MUTED, anchor: "middle" }));
  T.push(txt(234, by + 72, "K ways", { size: 9.5, fill: MUTED, anchor: "middle" }));
  T.push(arrow(sx + sw + 4, uy + 30, ux - 6, uy + 30));
  T.push(txt(462, uy + 22, "union", { size: 9.5, fill: MUTED, anchor: "middle" }));

  const y = 272 + tieNotes.length * 14;
  T.push(
    ...footer(
      y,
      `bench/sliced-gate-bench.json · bench/sliced-gate-bench.pbox.json · tsgo ${tsgoVer}`,
    ),
  );
  return svgDoc(
    y + 12,
    `The sliced gate: one tsgo program over the whole workspace (${gb(c64.wholeRssMB)} RSS, ${c64.wholeCpuPct}% CPU on ${c64.cores} cores) versus ${c64.bestK} concurrent slices at up to ${gb(c64.sliceRssMB)} each, with a union check proving the sliced verdict identical to the whole-program one.`,
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

  // the 30,000-app fleet as a schematic grid (NOT one cell per app)
  const COLS = 30;
  const ROWS = 20;
  const CELLS = COLS * ROWS;
  const appsPerCell = Math.round(apps / CELLS);
  const leafCells = Math.max(1, Math.round((CELLS * leafRan) / turboTotal));

  const cell = 8;
  const cgap = 1.6;
  const gridW = COLS * cell + (COLS - 1) * cgap;
  const gridH = Math.round(ROWS * cell + (ROWS - 1) * cgap);

  const grid = (x0, y0, hot) => {
    const out = [];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        // hot cells sit in the bottom-left corner, next to the edited lib
        const isHot = hot === "all" || (r === ROWS - 1 && c < hot);
        out.push(
          `<rect x="${(x0 + c * (cell + cgap)).toFixed(1)}" y="${(y0 + r * (cell + cgap)).toFixed(1)}" width="${cell}" height="${cell}" rx="1.5" fill="${isHot ? TINT.rust[1] : GRID}"/>`,
        );
      }
    return out;
  };

  const T = [];
  const gy = 56;
  const LX = 16;
  const RX = 358;

  // left panel: the breaking foundation rev — the whole grid goes rust
  T.push(txt(LX, 22, "breaking foundation rev", { size: 13, weight: "600" }));
  T.push(txt(LX, 42, `all ${int(breakApps)} apps red`, { size: 15, weight: "700" }));
  T.push(...grid(LX, gy, "all"));
  // right panel: the leaf edit — a corner of the grid
  T.push(txt(RX, 22, "leaf-lib edit", { size: 13, weight: "600" }));
  T.push(
    txt(RX, 42, `${int(leafRan)} of ${int(turboTotal)} tasks re-run`, { size: 15, weight: "700" }),
  );
  T.push(...grid(RX, gy, leafCells));

  const schemY = gy + gridH + 18;
  // two short lines, centered between the two up-arrows (a full-width line
  // would cross them). The panels use the grid differently, and say so: the left
  // one counts apps, the right one shades the leaf gate's share of the task set.
  [
    `schematic — left: each cell ≈ ${appsPerCell} of the ${int(apps)} apps`,
    `right: rust cells = the leaf gate's share of ${int(turboTotal)} tasks`,
  ].forEach((line, i) =>
    T.push(txt(W / 2, schemY + i * 13, line, { size: 10, fill: MUTED, anchor: "middle" })),
  );

  // the edited lib at the base of each panel, arrow up into the fleet
  const lby = schemY + 26;
  const libBox = (x0, tint, name, sub) => {
    const cx = x0 + Math.round(gridW / 2);
    T.push(arrow(cx, lby - 4, cx, gy + gridH + 8));
    T.push(box(x0 + 33, lby, 220, 44, tint));
    T.push(txt(x0 + 45, lby + 18, name, { size: 11.5, weight: "600" }));
    T.push(txt(x0 + 45, lby + 34, sub, { size: 10.5 }));
  };
  libBox(LX, "rust", `foundation lib (${foundationLib})`, "imported by every app");
  libBox(RX, "green", `leaf lib (${leafLib})`, "imported by almost nothing");

  // verdict lines under each panel
  const vy = lby + 68;
  T.push(
    txt(LX, vy, `verdict: ${secs(breakMs)} batch · ${secs(slicedBreakMs)} sliced`, {
      size: 12,
      weight: "600",
    }),
  );
  T.push(
    txt(LX, vy + 16, "every broken call site, exact file and line", { size: 10.5, fill: MUTED }),
  );
  T.push(txt(RX, vy, `dependents gate: ${int(leafRan)} tasks`, { size: 12, weight: "600" }));
  T.push(
    txt(
      RX,
      vy + 16,
      `at ${int(devSimApps)} apps a leaf lib has ${devSimLeafDeps} dependents (dev-sim)`,
      {
        size: 10.5,
        fill: MUTED,
      },
    ),
  );

  const y = vy + 44;
  T.push(
    ...footer(y, "bench/fleet-gate-bench.json · bench/sliced-gate-bench.json · bench/dev-sim.json"),
  );
  return svgDoc(
    y + 12,
    `Fleet blast radius: a breaking rev of the foundation lib turns all ${int(apps)} apps red with the verdict in ${secs(breakMs)} (batch) or ${secs(slicedBreakMs)} (sliced), while a leaf-lib edit re-runs ${leafRan} of ${int(turboTotal)} tasks.`,
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
  T.push(txt(16, 22, "O(repo): the whole-repo selection", { size: 13, weight: "600" }));
  T.push(txt(356, 22, "O(closure): the scoped command", { size: 13, weight: "600" }));

  // command boxes (blue: the thing you type)
  const cy = 38;
  T.push(box(16, cy, 288, 46, "blue"));
  T.push(txt(30, cy + 20, "turbo run typecheck:tsgo", { size: 12, weight: "600" }));
  T.push(txt(30, cy + 36, `--filter=...${foundation} — every dependent`, { size: 10.5 }));
  T.push(box(356, cy, 288, 46, "blue"));
  T.push(txt(370, cy + 20, `turbo run build --filter=${focusApp}...`, { size: 11, weight: "600" }));
  T.push(txt(370, cy + 36, "one app + its dependency closure", { size: 10.5 }));

  // left: fan-out arrows to the O(repo) task box; right: one arrow
  const ay = cy + 46;
  const ry = ay + 36;
  for (let i = 0; i < 5; i++) T.push(arrow(160, ay + 2, 46 + i * 57, ry - 6));
  T.push(arrow(500, ay + 2, 500, ry - 6));

  T.push(box(16, ry, 288, 78, "rust"));
  T.push(
    txt(30, ry + 26, `${int(turboTasks)} tasks · ${secs(turboMs)}`, { size: 16, weight: "700" }),
  );
  T.push(txt(30, ry + 46, turboKind, { size: 10.5 }));
  T.push(
    txt(30, ry + 62, `${int(fleetApps)}-app fleet tree — grows with the repo`, { size: 10.5 }),
  );
  T.push(box(356, ry, 288, 78, "green"));
  T.push(
    txt(370, ry + 26, `${int(focusTasks)} tasks · ${secs(focusMs)}`, { size: 16, weight: "700" }),
  );
  T.push(
    txt(370, ry + 46, `the closure: ${int(focusTasks)} of ${int(totalTasks)} build tasks`, {
      size: 10.5,
    }),
  );
  T.push(
    txt(370, ry + 62, `${int(rApps)}-app tree (${rLibs} libs) — tasks track the closure`, {
      size: 10.5,
    }),
  );

  const ny = ry + 102;
  T.push(
    txt(
      16,
      ny,
      "different trees and tasks — the contrast is the task selection, not a like-for-like time ratio",
      { size: 10.5, fill: MUTED },
    ),
  );

  const y = ny + 28;
  T.push(...footer(y, "bench/fleet-gate-bench.json · bench/results.json"));
  return svgDoc(
    y + 12,
    `The thesis: a command whose selection is the whole repo — a filter on the foundation lib selects every dependent — runs ${int(turboTasks)} tasks on the ${int(fleetApps)}-app fleet, while a command scoped to one app runs that app's dependency closure (${focusTasks} tasks at the largest measured layered scale).`,
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
      entry: `${secs(posMs(pt, "tsgo.incrPrimeMs"))} incremental prime`,
      tool: "tsgo",
    },
    {
      name: "tsgo --watch",
      how: "resident; rebuilds the program",
      ms: posMs(lp, "tsgoWatch.oneEditRecheckMs"),
      entry: `${secs(posMs(lp, "tsgoWatch.firstBuildMs"))} first build`,
      tool: "tsgo",
    },
    {
      name: "tsgo --lsp squiggle",
      how: "didChange → error appears",
      ms: posMs(lp, "tsgoLsp.warm.errorAppearsMs"),
      entry: `${secs(posMs(lp, "tsgoLsp.cold.coldOpenMs"))} cold open`,
      tool: "tsgo",
    },
    {
      name: "Flow server (main build)",
      how: "live server: notify + status",
      ms: rowMs("flow", "incrOneEdit"),
      entry: `${secs(posMs(pt, "flow.serverInitMs"))} server init`,
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

  // log axis over whole decades that bracket the data, so every bar ends between
  // two labeled gridlines
  const times = lanes.map((l) => l.ms);
  // (a time sitting exactly on a decade gets the decade below as its floor, so
  // no bar has zero length)
  const minT = Math.min(...times);
  let lo = 10 ** Math.floor(Math.log10(minT));
  if (lo === minT) lo /= 10;
  const hi = 10 ** Math.ceil(Math.log10(Math.max(...times)));
  const decades = Math.round(Math.log10(hi / lo));
  if (decades < 1 || decades > 6)
    throw new Error(`save-loop times span ${decades} decades — the axis layout does not fit`);
  const X0 = 204;
  const X1 = 528;
  const xOf = (ms) => +(X0 + (Math.log10(ms / lo) / decades) * (X1 - X0)).toFixed(1);
  const tickLabel = (ms) => (ms < 1000 ? `${ms}ms` : `${int(ms / 1000)}s`);

  const T = [];
  T.push(
    txt(16, 22, `one edit → verdict at ${int(N)} modules, by mechanic`, {
      size: 13,
      weight: "600",
    }),
  );
  T.push(
    txt(16, 39, "time from the edit to the verdict — log scale, each gridline ×10 the one before", {
      size: 10.5,
      fill: MUTED,
    }),
  );

  const laneY0 = 70;
  const pitch = 48;
  for (let d = 0; d <= decades; d++) {
    const ms = lo * 10 ** d;
    T.push(txt(xOf(ms), laneY0 - 8, tickLabel(ms), { size: 10, fill: MUTED, anchor: "middle" }));
  }
  lanes.forEach((l, i) => {
    const y = laneY0 + i * pitch;
    T.push(txt(16, y + 13, l.name, { size: 11.5, weight: "600" }));
    T.push(txt(16, y + 28, l.how, { size: 10, fill: MUTED }));
    const x = xOf(l.ms);
    const value = dur(l.ms);
    const valueEnd = x + 8 + approxW(value, 12.5, true) + 6;
    // gridline segments only behind the bar row (they never cross the entry
    // line), and none through the value printed after the bar
    for (let d = 0; d <= decades; d++) {
      const gx = xOf(lo * 10 ** d);
      if (gx > x && gx < valueEnd) continue;
      T.push(`<line x1="${gx}" y1="${y}" x2="${gx}" y2="${y + 20}" stroke="${GRID}"/>`);
    }
    T.push(
      `<rect x="${X0}" y="${y + 3}" width="${+(x - X0).toFixed(1)}" height="14" rx="3" fill="${TOOL_COLORS[l.tool]}"/>`,
    );
    T.push(txt(x + 8, y + 14.5, value, { size: 12.5, weight: "700" }));
    T.push(txt(X0, y + 33, `one-time entry: ${l.entry}`, { size: 10, fill: MUTED }));
  });

  const ny = laneY0 + lanes.length * pitch + 12;
  [
    `bars start at the ${tickLabel(lo)} axis floor, not at zero — bar length is the log of the time`,
    "CLI, --watch and Flow: a valid one-module edit, verdict over the whole program",
    "LSP: an edit that seeds a type error, verdict for the open file only",
  ].forEach((line, i) => T.push(txt(16, ny + i * 14, line, { size: 10.5, fill: MUTED })));

  const y = ny + 3 * 14 + 14;
  T.push(
    ...footer(
      y,
      `bench/tsgo-scale-bench.json · bench/lsp-scale-bench.json · tsgo ${tsgoVer} · ${cores} cores`,
    ),
  );
  return svgDoc(
    y + 12,
    `The save loop by mechanic at ${int(N)} modules, on a log time axis: tsgo's CLI incremental rerun relaunches and returns a verdict in ${dur(cli)}, its --watch rebuild in ${dur(watch)}, its LSP shows a seeded error in the open file in ${dur(lsp)}, and Flow's resident server rechecks one edit in ${dur(flow)}.`,
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
  T.push(
    txt(16, 22, "freshness gate: no-change codegen, then git status over __generated__", {
      size: 13,
      weight: "600",
    }),
  );
  const HX = 330;
  T.push(txt(16, 46, `${secs(gateMs)} · ${int(comps)} components`, { size: 16, weight: "700" }));
  T.push(
    txt(HX, 46, `${secs(fleetGateMs)} · ${int(fleetComps)} components`, {
      size: 16,
      weight: "700",
    }),
  );
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  T.push(
    txt(
      16,
      62,
      samples === 1 ? "one gate pass" : `one gate pass, median of ${plural(samples, "sample")}`,
      { size: 10.5, fill: MUTED },
    ),
  );
  T.push(
    txt(HX, 62, `one gate pass at the fleet anchor, ${plural(fleetSamples, "sample")}`, {
      size: 10.5,
      fill: MUTED,
    }),
  );

  // row 1: the gate's two steps, left to right
  const ry = 82;
  const rh = 62;
  T.push(box(16, ry, 160, rh, "blue"));
  T.push(txt(28, ry + 20, "PR head", { size: 11.5, weight: "600" }));
  T.push(txt(28, ry + 36, "components + the committed", { size: 10 }));
  T.push(txt(28, ry + 50, "__generated__ artifacts", { size: 10 }));
  T.push(box(236, ry, 170, rh, "blue"));
  T.push(txt(248, ry + 20, "relay-compiler", { size: 11.5, weight: "600" }));
  T.push(txt(248, ry + 36, "no-change codegen:", { size: 10 }));
  T.push(txt(248, ry + 50, "re-validates every document", { size: 10 }));
  T.push(box(466, ry, 178, rh, "blue"));
  T.push(txt(478, ry + 20, "git status --porcelain", { size: 11.5, weight: "600" }));
  T.push(txt(478, ry + 36, "-- src/__generated__", { size: 10 }));
  T.push(txt(478, ry + 50, "lists untracked artifacts too", { size: 10 }));

  const my = ry + rh / 2;
  const fleetAt = `@ ${int(fleetComps)}`;
  T.push(arrow(180, my, 232, my));
  T.push(txt(206, my - 8, "in CI", { size: 9.5, fill: MUTED, anchor: "middle" }));
  T.push(arrow(410, my, 462, my));
  T.push(txt(436, my - 8, secs2(fleetCodegenMs), { size: 9.5, fill: MUTED, anchor: "middle" }));
  T.push(txt(436, my + 16, fleetAt, { size: 9.5, fill: MUTED, anchor: "middle" }));

  // row 2: the fork. Green sits under the status box, red to its left so the
  // dashed return path into the PR head stays short.
  const fy = ry + rh + 54;
  const fh = 62;
  T.push(box(444, fy, 200, fh, "green"));
  T.push(txt(456, fy + 20, "clean → gate passes", { size: 11.5, weight: "600" }));
  T.push(txt(456, fy + 36, "artifacts byte-stable on every", { size: 10 }));
  T.push(txt(456, fy + 50, "timed no-change rerun", { size: 10 }));
  T.push(box(206, fy, 200, fh, "rust"));
  T.push(txt(218, fy + 20, "dirty → gate fails", { size: 11.5, weight: "600" }));
  T.push(txt(218, fy + 36, "an edited query changes its", { size: 10 }));
  T.push(txt(218, fy + 50, "artifact: the drift is detected", { size: 10 }));

  T.push(arrow(555, ry + rh + 3, 555, fy - 4));
  T.push(txt(563, ry + rh + 24, "nothing listed", { size: 9.5, fill: MUTED }));
  T.push(txt(563, ry + rh + 37, `${secs2(fleetStatusMs)} ${fleetAt}`, { size: 9.5, fill: MUTED }));
  T.push(arrow(486, ry + rh + 3, 344, fy - 4));
  T.push(txt(374, ry + rh + 17, "a changed or", { size: 9.5, fill: MUTED, anchor: "end" }));
  T.push(txt(374, ry + rh + 30, "untracked path", { size: 9.5, fill: MUTED, anchor: "end" }));

  // the red branch's way back: regenerate, commit, and the gate runs again
  // (dashed: the conditional path, not a timed one)
  const by = fy + fh / 2;
  T.push(dashes(202, by, 96, by));
  T.push(arrow(96, by, 96, ry + rh + 3, true));
  T.push(txt(104, ry + rh + 30, "regenerate,", { size: 9.5, fill: MUTED }));
  T.push(txt(104, ry + rh + 43, "commit", { size: 9.5, fill: MUTED }));

  const y = fy + fh + 32;
  T.push(
    ...footer(y, `bench/relay-codegen-bench.json · relay-compiler ${relayVer} · ${cores} cores`),
  );
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
  const T = [];
  const chip = (x, y, w, label) => {
    T.push(
      `<rect x="${x}" y="${y}" width="${w}" height="20" rx="4" fill="${BG}" stroke="${TINT.blue[1]}" stroke-width="1"/>`,
    );
    T.push(txt(x + w / 2, y + 13.5, label, { size: 9.5, anchor: "middle" }));
  };
  const head = (x, title, sub) => {
    T.push(txt(x, 22, title, { size: 12.5, weight: "600" }));
    T.push(txt(x, 38, sub, { size: 10, fill: MUTED }));
  };
  const mid = (x) => x + PW / 2;
  const BOT = 206; // every panel's diagram ends on this line

  // panel 1: hoisted — every package once, one level, at the workspace root
  {
    const x = PX[0];
    head(x, "hoisted: one flat tree", "pnpm hoisted · yarn node-modules");
    T.push(box(x, 52, PW, 28, "blue"));
    T.push(txt(x + 10, 70, "apps/<app> imports react", { size: 10.5 }));
    T.push(arrow(mid(x), 83, mid(x), 107));
    T.push(txt(mid(x) + 8, 99, "walks up to the root", { size: 9.5, fill: MUTED }));
    T.push(box(x, 110, PW, BOT - 110, "blue"));
    T.push(txt(x + 10, 128, "node_modules/ (workspace root)", { size: 10.5, weight: "600" }));
    const cw = 55;
    const cg = 5.5;
    ["next", "react", "react-dom"].forEach((p, i) => chip(x + 10 + i * (cw + cg), 138, cw, p));
    ["typescript", "@demo libs", "· · ·"].forEach((p, i) =>
      chip(x + 10 + i * (cw + cg), 164, cw, p),
    );
    T.push(txt(x + 10, 198, "packages side by side on one level", { size: 9.5, fill: MUTED }));
  }
  // panel 2: isolated — a per-package symlink tree over the virtual store, whose
  // files are linked from the content-addressable store
  {
    const x = PX[1];
    head(x, "isolated: symlink tree", "pnpm default (bun: node_modules/.bun)");
    T.push(box(x, 52, PW, 36, "blue"));
    T.push(txt(x + 10, 67, "apps/<app>/node_modules/", { size: 10.5, weight: "600" }));
    T.push(txt(x + 10, 81, "react: a symlink", { size: 10 }));
    T.push(arrow(mid(x), 91, mid(x), 117, true));
    T.push(txt(mid(x) + 8, 108, "symlink", { size: 9.5, fill: MUTED }));
    T.push(box(x, 120, PW, 36, "blue"));
    T.push(txt(x + 10, 135, "node_modules/.pnpm/", { size: 10.5, weight: "600" }));
    T.push(txt(x + 10, 149, "react@<version>/node_modules/react", { size: 10 }));
    T.push(arrow(mid(x), 159, mid(x), 177));
    T.push(txt(mid(x) + 8, 172, "files linked from", { size: 9.5, fill: MUTED }));
    T.push(box(x, 180, PW, BOT - 180, "blue"));
    T.push(txt(x + 10, 197, "content-addressable store", { size: 10.5, weight: "600" }));
  }
  // panel 3: PnP — no node_modules; one resolver table over the cache zips
  {
    const x = PX[2];
    head(x, "Plug'n'Play: one table", "yarn default · no node_modules tree");
    T.push(box(x, 52, PW, 28, "blue"));
    T.push(txt(x + 10, 70, "apps/<app> imports react", { size: 10.5 }));
    T.push(arrow(mid(x), 83, mid(x), 103));
    T.push(txt(mid(x) + 8, 97, "PnP loader", { size: 9.5, fill: MUTED }));
    T.push(box(x, 106, PW, 52, "blue"));
    T.push(txt(x + 10, 123, ".pnp.cjs: one resolver table", { size: 10.5, weight: "600" }));
    T.push(txt(x + 10, 137, "react → its cache zip", { size: 10 }));
    T.push(txt(x + 10, 150, "native package → unplugged dir", { size: 10 }));
    T.push(arrow(mid(x), 161, mid(x), 177));
    T.push(box(x, 180, PW, BOT - 180, "blue"));
    T.push(txt(x + 10, 197, "global cache: package zips", { size: 10.5, weight: "600" }));
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
      `node_modules entries at ${int(apps)} apps / ${int(libs)} libs — one linear scale` +
        (clamped ? ` (a bar under ${MIN_BAR}px is drawn at ${MIN_BAR}px)` : ""),
      { size: 10.5, fill: MUTED },
    ),
  );
  const row = (x, y, label, v, tool) => {
    T.push(txt(x, y, label, { size: 11, weight: "600" }));
    T.push(txt(x + PW, y, int(v), { size: 11, weight: "700", anchor: "end" }));
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
  // the caveat on PnP's count (amber): its entries are files inside the unplugged
  // native packages, not a dependency tree
  T.push(box(PX[2], r2 - 12, PW, 36, "amber", 6));
  T.push(txt(PX[2] + 10, r2 + 2, `${int(n.yarnPnp)} entries, all inside unplugged`, { size: 9.5 }));
  T.push(txt(PX[2] + 10, r2 + 15, `native packages · .pnp.cjs ${mb(pnpCjsBytes)}`, { size: 9.5 }));

  const y = r2 + 50;
  T.push(
    ...footer(
      y,
      `bench/install-bench.json · pnpm ${str(INSTALL, "pnpmVersion")} · bun ${str(INSTALL, "bunVersion")} · yarn ${str(INSTALL, "yarnVersion")}`,
    ),
  );
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
    txt(16, 22, "next build under Yarn PnP: the outcome depends on the node version", {
      size: 13,
      weight: "600",
    }),
  );
  T.push(
    txt(16, 39, `one App Router app, three builders · next ${nextVer} · yarn ${yarnVer}`, {
      size: 10.5,
      fill: MUTED,
    }),
  );
  const CX = [134, 306, 478];
  const CW = 166;
  const y0 = 88;
  const ch = 48;
  const gap = 6;
  BUILDERS.forEach(([, label, how], r) => {
    const y = y0 + r * (ch + gap);
    T.push(txt(16, y + 21, label, { size: 11.5, weight: "600" }));
    T.push(txt(16, y + 36, how, { size: 10, fill: MUTED }));
  });
  GROUPS.forEach((g, c) => {
    const x = CX[c];
    T.push(txt(x, 62, g.title, { size: 12, weight: "600" }));
    T.push(txt(x, 77, g.sub, { size: 10, fill: MUTED }));
    BUILDERS.forEach(([builder], r) => {
      const kind = classify(g.key, g.linker, builder);
      if (kind !== g.expect[builder])
        throw new Error(
          `matrix.${g.key}.${builder} is "${kind}", the figure draws "${g.expect[builder]}" — update the figure`,
        );
      const d = DRAW[kind];
      const y = y0 + r * (ch + gap);
      T.push(box(x, y, CW, ch, d.tint));
      T.push(txt(x + 12, y + 21, d.main, { size: 11.5, weight: "600" }));
      T.push(txt(x + 12, y + 36, d.sub, { size: 10 }));
    });
    const ny = y0 + BUILDERS.length * (ch + gap) + 10;
    g.note.forEach((line, i) => T.push(txt(x, ny + i * 13, line, { size: 10, fill: MUTED })));
  });

  const y = y0 + BUILDERS.length * (ch + gap) + 10 + 13 + 30;
  T.push(...footer(y, "bench/rspack-pnp-bench.json · matrix.{pnp,pnpControlNode,nm}"));
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
    txt(16, 22, "a shared cache: one runner seeds, the rest restore", { size: 13, weight: "600" }),
  );
  T.push(
    txt(16, 39, `${cores} cores · ${server} on localhost: restore with no network latency`, {
      size: 10.5,
      fill: MUTED,
    }),
  );

  // the mechanism: seed -> cache -> restore fan
  const ay = 54;
  const ah = 70;
  T.push(box(16, ay, 178, ah, "rust"));
  T.push(txt(28, ay + 21, "runner 1: the seed", { size: 11.5, weight: "600" }));
  T.push(txt(28, ay + 38, "empty local cache: computes", { size: 10.5 }));
  T.push(txt(28, ay + 53, "every task, uploads the outputs", { size: 10.5 }));
  T.push(box(242, ay, 176, ah, "blue"));
  T.push(txt(254, ay + 21, "shared cache", { size: 11.5, weight: "600" }));
  T.push(txt(254, ay + 38, "task outputs, keyed by a", { size: 10.5 }));
  T.push(txt(254, ay + 53, "hash of the task's inputs", { size: 10.5 }));
  const amy = ay + ah / 2;
  T.push(arrow(198, amy, 238, amy));
  T.push(txt(218, amy - 8, "upload", { size: 9.5, fill: MUTED, anchor: "middle" }));
  ["runner 2: restores", "runner 3: restores", "· · · runner R: restores"].forEach((label, i) => {
    const yy = ay + i * 24;
    T.push(box(466, yy, 178, 22, "green", 5));
    T.push(txt(478, yy + 15, label, { size: 10.5 }));
    T.push(arrow(422, amy, 462, yy + 11));
  });

  // per task: no-cache cold compute vs restore, bars on one linear scale
  const BX = 240;
  const BW = 262;
  let y = ay + ah + 30;
  T.push(txt(16, y, "per task: no-cache cold compute vs restore", { size: 12, weight: "600" }));
  const maxMs = Math.max(...rows.map((r) => r.coldMs));
  // a bar too thin to see is drawn at MIN_BAR, and the section's scale note says so
  const MIN_BAR = 2;
  const minNote = (widths) =>
    widths.some((w) => w < MIN_BAR) ? ` (a bar under ${MIN_BAR}px is drawn at ${MIN_BAR}px)` : "";
  const bar = (x, yy, w, tint) => {
    const bw = +Math.max(MIN_BAR, w).toFixed(1);
    return box(x, yy, bw, 12, tint, Math.min(3, bw / 2));
  };
  T.push(
    txt(
      644,
      y,
      "bars: wall time on one linear scale" +
        minNote(rows.flatMap((r) => [r.coldMs, r.restoreMs]).map((ms) => (ms / maxMs) * BW)),
      { size: 10, fill: MUTED, anchor: "end" },
    ),
  );
  y += 12;
  for (const r of rows) {
    T.push(
      txt(16, y + 12, `${r.task} · ${int(r.apps)} apps / ${int(r.libs)} libs`, {
        size: 11,
        weight: "600",
      }),
    );
    T.push(
      txt(16, y + 27, `${int(r.totalTasks)} tasks · seed run ${secs(r.seedMs)}`, {
        size: 10,
        fill: MUTED,
      }),
    );
    const cw = (r.coldMs / maxMs) * BW;
    const rw = (r.restoreMs / maxMs) * BW;
    T.push(bar(BX, y + 2, cw, "rust"));
    T.push(txt(BX + cw + 7, y + 12, `${secs(r.coldMs)} no-cache cold`, { size: 10.5 }));
    T.push(bar(BX, y + 18, rw, "green"));
    T.push(
      txt(BX + rw + 7, y + 28, `${secs(r.restoreMs)} restore · ×${r.speedup.toFixed(1)} faster`, {
        size: 10.5,
        weight: "600",
      }),
    );
    y += 42;
  }

  // partial invalidation: what still restores after an edit
  y += 14;
  T.push(txt(16, y, "after an edit: what still restores", { size: 12, weight: "600" }));
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
      { size: 10, fill: MUTED, anchor: "end" },
    ),
  );
  y += 12;
  for (const e of edits) {
    T.push(txt(16, y + 12, `${e.kind}-lib edit`, { size: 11, weight: "600" }));
    T.push(txt(16, y + 27, e.lib, { size: 10, fill: MUTED }));
    // one bar of all the tasks, split restored (green) | recomputed (rust)
    const gw = +((e.restored / piTotal) * BW).toFixed(1);
    if (e.restored > 0) T.push(bar(BX, y + 6, e.recomputed > 0 ? gw - 1 : gw, "green"));
    if (e.recomputed > 0)
      T.push(
        bar(e.restored > 0 ? BX + gw + 1 : BX, y + 6, e.restored > 0 ? BW - gw - 1 : BW, "rust"),
      );
    T.push(
      txt(BX + BW + 7, y + 12, `${int(e.restored)} of ${int(piTotal)} restored`, {
        size: 10.5,
        weight: "600",
      }),
    );
    T.push(txt(BX + BW + 7, y + 26, `${int(e.recomputed)} recomputed`, { size: 10.5 }));
    y += 40;
  }

  y += 16;
  T.push(...footer(y, "bench/ci-cache-bench.json · headline · partialInvalidation"));
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

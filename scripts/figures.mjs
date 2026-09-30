#!/usr/bin/env node
// Mechanism figures for the diagram-heavy reports (diagram-style-spec.md):
//   fig-sliced-gate     — one-program gate vs the K-slice fan vs the union check (FLEET.md)
//   fig-blast-radius    — foundation rev turns the whole fleet red; a leaf rev doesn't (FLEET.md)
//   fig-orepo-oclosure  — the thesis: unscoped O(repo) fan-out vs a scoped closure (README.md)
// Deterministic from the cited bench JSONs (no Date, no hand numbers; missing or
// renamed fields throw) -> bench/charts/fig-*.svg + a 300 DPI PNG each, one step.
//
//   node scripts/figures.mjs        (make figures)

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const SLICED = read("bench/sliced-gate-bench.json");
const SLICED_PBOX = read("bench/sliced-gate-bench.pbox.json");
const FLEET = read("bench/fleet-gate-bench.json");
const RESULTS = read("bench/results.json");
const DEVSIM = read("bench/dev-sim.json");

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

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const gb = (mb) => `${(mb / 1000).toFixed(1)}GB`;
const int = (n) => n.toLocaleString("en-US");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- the shared visual language (diagram-style-spec.md, from the cmux page) ---
const INK = "#1c2330";
const MUTED = "#6b7885";
const TINT = {
  blue: ["#eef3fb", "#b9cdec"], // component / neutral
  green: ["#f0faf5", "#a9d8bd"], // fast path / green verdict
  rust: ["#fdf3ef", "#e4b9a6"], // slow path / red verdict / blast radius
};
// dark-mode attribute-selector recolors, copied from the spec's table — GitHub
// serves SVGs through camo as <img>, where internal CSS + prefers-color-scheme work
const STYLE = `<style>@media (prefers-color-scheme: dark){
rect[fill="#ffffff"]{fill:#0d1117}
text[fill="${INK}"]{fill:#e2e7ec}
text[fill="${MUTED}"]{fill:#9aa6b1}
line[stroke="#e4e8ec"]{stroke:#2b333c}
rect[stroke="#e4e8ec"]{stroke:#39424c}
rect[fill="#e4e8ec"]{fill:#2b333c}
line[stroke="${MUTED}"],path[stroke="${MUTED}"]{stroke:#8b98a4}
path[fill="${MUTED}"]{fill:#8b98a4}
rect[fill="#eef3fb"]{fill:#1f2f45}rect[stroke="#b9cdec"]{stroke:#3d5a85}
rect[fill="#f0faf5"]{fill:#173029}rect[stroke="#a9d8bd"]{stroke:#2e6b52}
rect[fill="#fdf3ef"]{fill:#331f18}rect[stroke="#e4b9a6"]{stroke:#7a4630}
rect[fill="#e4b9a6"]{fill:#7a4630}
}</style>`;

const W = 660;
const svgDoc = (h, aria, body) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(aria)}" font-family="system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif">`,
    STYLE,
    `<rect width="${W}" height="${h}" fill="#ffffff"/>`,
    ...body,
    `</svg>`,
  ].join("\n");

const box = (x, y, w, h, tint, rx = 7) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${TINT[tint][0]}" stroke="${TINT[tint][1]}" stroke-width="1.2"/>`;
const txt = (x, y, s, { size = 11, fill = INK, weight = "", anchor = "" } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${weight ? ` font-weight="${weight}"` : ""}${anchor ? ` text-anchor="${anchor}"` : ""}>${esc(s)}</text>`;
// arrow-ended edge. The head is an explicit triangle, not a <marker>: ImageMagick's
// SVG fallback renderer (what `convert` uses in CI when inkscape is absent) drops
// <marker> elements, so a marker-end head would vanish from every committed PNG.
const arrow = (x1, y1, x2, y2, dashed = false) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const hl = 7; // head length
  const hw = 3; // head half-width
  const bx = x2 - ux * hl;
  const by = y2 - uy * hl;
  const f = (n) => +n.toFixed(1);
  return (
    `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(bx)}" y2="${f(by)}" stroke="${MUTED}" stroke-width="1.5"${dashed ? ` stroke-dasharray="6 5"` : ""}/>` +
    `<path d="M${f(x2)} ${f(y2)}L${f(bx - uy * hw)} ${f(by + ux * hw)}L${f(bx + uy * hw)} ${f(by - ux * hw)}z" fill="${MUTED}"/>`
  );
};
const footer = (y, sources) => [
  `<line x1="16" y1="${y - 14}" x2="${W - 16}" y2="${y - 14}" stroke="#e4e8ec"/>`,
  txt(16, y, `data: ${sources}`, { size: 10, fill: MUTED }),
];

const emit = (name, svg) => {
  mkdirSync("bench/charts", { recursive: true });
  const svgPath = join("bench", "charts", `${name}.svg`);
  const pngPath = join("bench", "charts", `${name}.png`);
  writeFileSync(svgPath, svg + "\n");
  console.log(`wrote ${svgPath}`);
  // 300 DPI raster in the same step (repo chart convention; charts.yml re-renders
  // and fails the job if convert fails, so a stale PNG can't survive)
  const conv = spawnSync("convert", ["-density", "300", svgPath, pngPath], { encoding: "utf8" });
  if (conv.status !== 0 || !existsSync(pngPath) || statSync(pngPath).size === 0) {
    console.error(`convert failed for ${name}: ${(conv.stderr || "").slice(-300)}`);
    process.exit(1);
  }
  console.log(`wrote ${pngPath}`);
};

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
  if (need(SLICED, "apps") !== need(SLICED_PBOX, "apps"))
    throw new Error("the two sliced-gate records are not the same tree");
  const apps = need(SLICED, "apps");

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
    txt(sx, elY + 58, `per-slice RSS ${gb(c64.sliceRssMB)} (K=${c64.bestK}, ${c64.cores}c)`, {
      size: 11,
      weight: "600",
    }),
  );
  T.push(
    txt(sx, elY + 74, `${gb(c192.sliceRssMB)} (K=${c192.bestK}, ${c192.cores}c)`, { size: 11 }),
  );

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

  const y = 272;
  T.push(...footer(y, "bench/sliced-gate-bench.json · bench/sliced-gate-bench.pbox.json"));
  return svgDoc(
    y + 12,
    `The sliced gate: one tsgo program over the whole workspace (${gb(c64.wholeRssMB)} RSS, ${c64.wholeCpuPct}% CPU on ${c64.cores} cores) versus ${c64.bestK} concurrent slices at ${gb(c64.sliceRssMB)} each, with a union check proving the sliced verdict identical to the whole-program one.`,
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
  if (need(SLICED, "apps") !== apps)
    throw new Error("sliced-gate record is not the same fleet scale");
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
          `<rect x="${(x0 + c * (cell + cgap)).toFixed(1)}" y="${(y0 + r * (cell + cgap)).toFixed(1)}" width="${cell}" height="${cell}" rx="1.5" fill="${isHot ? "#e4b9a6" : "#e4e8ec"}"/>`,
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
  T.push(
    txt(
      W / 2,
      schemY,
      `schematic — each cell stands for ~${appsPerCell} of the ${int(apps)} apps`,
      {
        size: 10,
        fill: MUTED,
        anchor: "middle",
      },
    ),
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
  const fleetLibs = need(FLEET, "libs");
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
  T.push(txt(16, 22, "O(repo): the unscoped command", { size: 13, weight: "600" }));
  T.push(txt(356, 22, "O(closure): the scoped command", { size: 13, weight: "600" }));

  // command boxes (blue: the thing you type)
  const cy = 38;
  T.push(box(16, cy, 288, 46, "blue"));
  T.push(txt(30, cy + 20, "turbo run typecheck", { size: 12, weight: "600" }));
  T.push(txt(30, cy + 36, "no filter — every package is selected", { size: 10.5 }));
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
  T.push(txt(30, ry + 46, `a task per package + ${int(fleetLibs)} lib builds`, { size: 10.5 }));
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
    txt(370, ry + 62, `${int(rApps)}-app tree (${rLibs} libs) — grows with the closure`, {
      size: 10.5,
    }),
  );

  const ny = ry + 102;
  T.push(
    txt(
      16,
      ny,
      "different trees and tasks — the contrast is the selection mechanism, not a like-for-like ratio",
      { size: 10.5, fill: MUTED },
    ),
  );

  const y = ny + 28;
  T.push(...footer(y, "bench/fleet-gate-bench.json · bench/results.json"));
  return svgDoc(
    y + 12,
    `The thesis: an unscoped whole-repo command runs a task for every package (${int(turboTasks)} tasks on the ${int(fleetApps)}-app fleet), while a scoped command runs one app's dependency closure (${focusTasks} tasks at the largest measured layered scale).`,
    T,
  );
}

emit("fig-sliced-gate", figSlicedGate());
emit("fig-blast-radius", figBlastRadius());
emit("fig-orepo-oclosure", figOrepoOclosure());

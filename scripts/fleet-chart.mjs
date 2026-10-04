#!/usr/bin/env node
// The fleet-scale infographic: what a change costs in a 30,000-app workspace,
// told for engineers who don't live in monorepo tooling. Three questions, one
// panel each: how far does a change reach (task counts), the worst case run
// two ways (one-command check vs per-package pipeline), and whether a bigger
// machine helps (core counts read from each record's machine field). Drawn in
// the shared box/arrow language (scripts/_chartstyle.mjs): green = the fast
// path, rust = the slow path / blast radius, blue = neutral fact, amber =
// caveat. Deterministic from bench/fleet-gate-bench.json +
// bench/fleet-gate-bench.pbox.json + bench/fleet-shape.json (no hand numbers;
// missing fields throw) -> bench/charts/fleet-gate.svg + a 300 DPI PNG in the
// same run.
//
//   node scripts/fleet-chart.mjs        (make fleet-chart)

import { readFileSync } from "node:fs";
import {
  MUTED,
  ACCENT,
  txt,
  box,
  arrow,
  svgDoc,
  fmtMult,
  wrapText,
  esc,
  emitChart,
  assertComparable,
  bareVer,
  GRID,
} from "./_chartstyle.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const LOCAL = read("bench/fleet-gate-bench.json");
const PBOX = read("bench/fleet-gate-bench.pbox.json");
const SHAPE = read("bench/fleet-shape.json");

// every number the chart renders, pulled once and validated (a stale dataset
// must throw here, not render a plausible cell)
const need = (o, path) => {
  let v = o;
  for (const k of path.split(".")) {
    v = v?.[k];
    if (v == null) throw new Error(`missing field ${path} in a cited bench JSON`);
  }
  return v;
};
const N = {
  apps: need(LOCAL, "apps"),
  libs: need(LOCAL, "libs"),
  files: need(SHAPE, "fleetContext.presetParams.approxFilesFullScale"),
  universalTasks: need(LOCAL, "turboGate.total"),
  leafTasks: need(LOCAL, "leafGate.total"),
  wholeMsLocal: need(LOCAL, "optimalGate.ms"),
  wholeRssMB: need(LOCAL, "optimalGate.maxRssMB"),
  turboMsLocal: need(LOCAL, "turboGate.ms"),
  breakMs: need(LOCAL, "breakingChange.ms"),
  breakApps: need(LOCAL, "breakingChange.appsWithErrors"),
  wholeMsPbox: need(PBOX, "optimalGate.ms"),
  turboMsPbox: need(PBOX, "turboGate.ms"),
  installMs: need(LOCAL, "install.ms"),
  oxlintMs: need(LOCAL, "summary.oxlintMs"),
  bun: need(LOCAL, "versions.bun"),
  bunPbox: need(PBOX, "versions.bun"),
  turbo: need(LOCAL, "versions.turbo"),
  tsgo: need(LOCAL, "versions.tsgo"),
  oxlint: need(LOCAL, "versions.oxlint"),
  node: need(LOCAL, "versions.node"),
  // machine provenance recorded by the bench itself — the cross-box claims
  // must trace to the records, not to file names or memory
  coresLocal: need(LOCAL, "machine.cores"),
  coresPbox: need(PBOX, "machine.cores"),
  // libs imported by 100% of apps, measured from the manifests by fleet-shape-verify
  universalLibs: need(SHAPE, "generated.universalLibs"),
};
// panel 3 draws the two records as a machine contrast: same tree, same task
// sets, and the same recorded checker, orchestrator, and node — or throw. (The
// lib ^builds run each package's own tsc, whose version the gate bench does not
// record, so it cannot be compared here.)
assertComparable(
  LOCAL,
  PBOX,
  {
    fields: [
      "apps",
      "libs",
      "modulesPerLib",
      "shape",
      "foundationLib",
      "leafLib",
      "machine.arch",
      "optimalGate.kind",
      "turboGate.kind",
      "turboGate.total",
      "leafGate.total",
    ],
    versions: ["tsgo", "turbo", "node"],
  },
  "fleet-gate 64- vs 192-core",
);
for (const rec of [LOCAL, PBOX])
  for (const gate of ["turboGate", "leafGate"])
    if (need(rec, `${gate}.ran`) !== need(rec, `${gate}.total`))
      throw new Error(`${gate} did not run its full task set — the task counts are invalid`);
if (!need(LOCAL, "breakingChange.caught"))
  throw new Error("dataset says the breaking change was not caught");
if (N.coresPbox <= N.coresLocal)
  throw new Error("the pbox record is not the bigger box — panel 3's framing is invalid");
if (need(PBOX, "optimalGate.ms") < need(LOCAL, "optimalGate.ms"))
  throw new Error(
    "one-command check got FASTER on the big box — panel 3's verdict prose must be rewritten",
  );
if (need(PBOX, "turboGate.ms") >= need(LOCAL, "turboGate.ms"))
  throw new Error(
    "pipeline did not speed up on the big box — panel 3's verdict prose must be rewritten",
  );

// bun is deliberately outside the guard above: it is on the path of the install
// and of every pipeline task (turbo starts each task through the root
// packageManager binary), not of the one-program check. When the two records
// ran different bun versions the footer and panel 3 say so instead of throwing.
const bunDiffers = N.bun !== N.bunPbox;
const bunLabel = bunDiffers
  ? `bun ${N.bun} (${N.coresLocal}-core) / ${N.bunPbox} (${N.coresPbox}-core)`
  : `bun ${N.bun}`;
const secs = (ms) => (ms >= 100000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;
const int = (n) => n.toLocaleString("en-US");

// --- layout ------------------------------------------------------------------
const W = 900;
const PAD = 28;
const T = [];
let y = 0;

const title = (t, size, dy) => {
  y += dy;
  T.push(txt(PAD, y, t, { size, weight: "600" }));
};
const note = (t, dy, maxChars = 150) => {
  const rows = wrapText(t, maxChars);
  rows.forEach((row, i) => {
    y += i === 0 ? dy : 16;
    T.push(txt(PAD, y, row, { size: 12, fill: MUTED }));
  });
};
// a tinted fact box at the CURRENT y: headline + up to two sub lines
function factBox(x, w, h, tint, big, subs) {
  const lines = Array.isArray(subs) ? subs : [subs];
  T.push(box(x, y, w, h, tint));
  T.push(txt(x + 14, y + 26, big, { size: 17, weight: "700" }));
  lines.forEach((sub, i) => {
    T.push(txt(x + 14, y + 44 + i * 15, sub, { size: 11.5, fill: MUTED }));
  });
}

// ---- title block ----
title(`A ${int(N.apps)}-app workspace: what a change actually costs`, 20, 44);
note(
  `${int(N.apps)} Next.js apps + ${N.libs} shared libs in one workspace — about ${(N.files / 1e6).toFixed(2)} million generated files. Every number below was measured on this tree.`,
  22,
);

// ---- panel 1: blast radius (edit box -> arrow -> outcome box) ----
title("1. How far does a change reach?", 15, 40);
note(
  `${N.universalLibs} of the libs are imported by every app. Change one and the pipeline re-runs a typecheck for every package that depends on it (plus the lib builds); change an ordinary lib and almost nothing runs.`,
  20,
);
y += 14;
const EDIT_W = 268;
const ARROW_W = 46;
const OUT_X = PAD + EDIT_W + ARROW_W;
const OUT_W = W - PAD - OUT_X;
const editRow = (tint, editName, editSub, big, sub) => {
  factBox(PAD, EDIT_W, 56, "blue", editName, editSub);
  T.push(arrow(PAD + EDIT_W + 6, y + 28, OUT_X - 6, y + 28));
  factBox(OUT_X, OUT_W, 56, tint, big, sub);
  y += 56 + 10;
};
editRow(
  "rust",
  "edit a lib EVERY app imports",
  "the universal foundation — the worst case",
  `${int(N.universalTasks)} tasks re-run`,
  "a typecheck per dependent package, plus the lib builds",
);
editRow(
  "green",
  "edit an ordinary leaf lib",
  "imported by almost nothing",
  `${N.leafTasks} tasks re-run`,
  `${int(Math.round(N.universalTasks / N.leafTasks))}× smaller blast radius`,
);
y -= 10;

// ---- panel 2: the worst case, two ways ----
title(`2. The worst case, run two ways (${N.coresLocal}-core box)`, 15, 40);
note(
  "Same question — “did my change break any app?” — two mechanisms. Not like-for-like: the pipeline also builds each lib's dist output; the one command only type-checks.",
  20,
);
y += 14;
const colW = (W - PAD * 2 - 16) / 2;
const m2 = N.turboMsLocal / N.wholeMsLocal;
factBox(PAD, colW, 74, "green", `${secs(N.wholeMsLocal)} — one command`, [
  `a single checker reads the whole workspace's source once`,
  `(peak RSS: ${int(N.wholeRssMB)}MB recorded)`,
]);
factBox(PAD + colW + 16, colW, 74, "rust", `${mins(N.turboMsLocal)} — ${fmtMult(m2)} slower`, [
  `standard pipeline: ${int(N.universalTasks)} tasks — a checker process`,
  `per affected package plus ${N.libs} lib builds`,
]);
y += 74 + 12;
factBox(PAD, W - PAD * 2, 56, "green", `A breaking change is caught in ${secs(N.breakMs)}`, [
  `all ${int(N.breakApps)} affected apps flagged with exact file and line — the fix-list a codemod can consume`,
]);
y += 56;

// ---- panel 3: bigger machine? ----
title("3. Does a bigger machine help?", 15, 40);
note(
  `The same two mechanisms on two different machines (${N.coresLocal} vs ${N.coresPbox} cores, recorded per run). One comparison each — a cross-machine observation, not a controlled core-scaling experiment.${bunDiffers ? ` The pipeline rows also differ in bun version (${N.bun} vs ${N.bunPbox}): turbo starts each task through the package manager.` : ""}`,
  20,
);
y += 14;
const mWhole = N.wholeMsPbox / N.wholeMsLocal;
const mTurbo = N.turboMsLocal / N.turboMsPbox;
// row 1: the one-command check — the fast box (the SMALL machine) green
factBox(PAD, colW, 74, "green", `one command, ${N.coresLocal} cores: ${secs(N.wholeMsLocal)}`, [
  `one process; the smaller box was faster`,
]);
factBox(
  PAD + colW + 16,
  colW,
  74,
  "rust",
  `one command, ${N.coresPbox} cores: ${secs(N.wholeMsPbox)}`,
  [`${fmtMult(mWhole)} slower — this check did not gain from the bigger box`],
);
y += 74 + 12;
// row 2: the pipeline — the fast box (the BIG machine) green
factBox(PAD, colW, 74, "rust", `pipeline, ${N.coresLocal} cores: ${mins(N.turboMsLocal)}`, [
  `${fmtMult(mTurbo)} slower than the big box`,
]);
factBox(
  PAD + colW + 16,
  colW,
  74,
  "green",
  `pipeline, ${N.coresPbox} cores: ${mins(N.turboMsPbox)}`,
  [
    `ran ${mTurbo.toFixed(1)}× faster on this box (${(N.coresPbox / N.coresLocal).toFixed(1)}× the cores)`,
  ],
);
y += 74;

// ---- footer facts + sources ----
y += 34;
T.push(`<line x1="${PAD}" y1="${y - 16}" x2="${W - PAD}" y2="${y - 16}" stroke="${GRID}"/>`);
T.push(
  txt(
    PAD,
    y,
    `also measured (${N.coresLocal}-core box): installing the ${int(N.apps + N.libs)}-package workspace (plus its external deps) takes ${secs(N.installMs)} (bun, warm store) · linting the whole tree takes ${secs(N.oxlintMs)} (oxlint)`,
    { size: 11.5, fill: MUTED },
  ),
);
y += 18;
T.push(
  txt(
    PAD,
    y,
    `toolchain: ${bunLabel} · turbo ${N.turbo} · tsgo ${bareVer(N.tsgo)} · oxlint ${bareVer(N.oxlint)} · node ${bareVer(N.node)}`,
    {
      size: 11.5,
      fill: MUTED,
    },
  ),
);
y += 20;
// each source link is its own positioned <text> (tspan flow inside <a> is not
// reliable across renderers — links overlapped when flowed in one text run)
{
  let lx = PAD;
  const putText = (t) => {
    T.push(txt(lx, y, t, { size: 11, fill: MUTED }));
    lx += Math.round(t.length * 6.1);
  };
  putText("data: ");
  const links = [
    ["fleet-gate-bench.json", "../fleet-gate-bench.json"],
    ["fleet-gate-bench.pbox.json", "../fleet-gate-bench.pbox.json"],
    ["fleet-shape.json", "../fleet-shape.json"],
  ];
  links.forEach(([t, href], i) => {
    T.push(
      `<a href="${href}"><text x="${lx}" y="${y}" font-size="11" fill="${ACCENT}">${esc(t)}</text></a>`,
    );
    lx += Math.round(t.length * 6.1);
    if (i < links.length - 1) putText("  ·  ");
  });
}
y += 26;

const H = y;
emitChart(
  "fleet-gate",
  svgDoc(
    W,
    H,
    `What a change costs in a ${int(N.apps)}-app workspace: a universal-lib edit re-runs ${int(N.universalTasks)} tasks against ${N.leafTasks} for a leaf edit; the worst case runs as one ${secs(N.wholeMsLocal)} whole-program check or a ${mins(N.turboMsLocal)} pipeline; and in a cross-machine observation only the pipeline ran faster on the ${N.coresPbox}-core box.`,
    T,
  ),
  { strict: true },
);

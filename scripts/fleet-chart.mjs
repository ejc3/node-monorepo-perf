#!/usr/bin/env node
// The fleet worst case on two machines: a foundation rev on the 30,000-app fleet,
// checked by one checker process and by the per-package pipeline, each run on the
// 64-core and the 192-core box. Four bars on one linear time axis in two neutral
// machine fills (scripts/_chartstyle.mjs MACHINE_SERIES), so neither machine reads as a
// winner; the change per mechanism is labeled. The blast radius and the O(repo)
// selection are drawn by figures.mjs (fig-blast-radius, fig-orepo-oclosure).
// Deterministic from bench/fleet-gate-bench.json + bench/fleet-gate-bench.pbox.json
// + bench/fleet-shape.json (no hand numbers; missing fields throw) ->
// bench/charts/fleet-gate.svg + a 300 DPI PNG, plus the figure's text alternative
// in FLEET.md (the chart-data:fleet-gate block).
//
//   node scripts/fleet-chart.mjs        (make fleet-chart)

import { readFileSync } from "node:fs";
import {
  MUTED,
  GRID,
  MARGIN,
  MACHINE_SERIES,
  FIG,
  txt,
  figTitle,
  footer,
  approxW,
  svgDoc,
  fmtMult,
  emitChart,
  assertComparable,
  bareVer,
  mdTable,
  mdDetails,
  writeDocBlock,
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
// the figure draws the two records as a machine contrast: same tree, same task
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
  throw new Error("the pbox record is not the bigger box — the figure's framing is invalid");
if (need(PBOX, "optimalGate.ms") < need(LOCAL, "optimalGate.ms"))
  throw new Error(
    "one-command check got FASTER on the big box — the figure's change label must be rewritten",
  );
if (need(PBOX, "turboGate.ms") >= need(LOCAL, "turboGate.ms"))
  throw new Error(
    "pipeline did not speed up on the big box — the figure's change label must be rewritten",
  );

// bun is deliberately outside the guard above: it is on the path of the install
// and of every pipeline task (turbo starts each task through the root
// packageManager binary), not of the one-program check. When the two records
// ran different bun versions the toolchain line and the data block say so instead
// of throwing.
const bunDiffers = N.bun !== N.bunPbox;
const bunLabel = bunDiffers
  ? `bun ${N.bun} (${N.coresLocal}-core) / ${N.bunPbox} (${N.coresPbox}-core)`
  : `bun ${N.bun}`;
const secs = (ms) => (ms >= 100000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;
const int = (n) => n.toLocaleString("en-US");

// --- layout ------------------------------------------------------------------
// The worst case (a foundation rev on the full fleet) asked two ways, each run on
// two machines: four bars on one linear time axis, grouped by mechanism, in two
// neutral machine fills. The cross-machine change is labeled per mechanism; no
// tint marks a winner, because the machines are not a controlled variable.
const W = 668;
const PAD = MARGIN;
const T = [];
T.push(
  ...figTitle(
    PAD,
    24,
    "The worst case on two machines",
    `a foundation rev on the ${int(N.apps)}-app fleet: one checker process vs the per-package pipeline`,
  ).parts,
);
// key
const ky = 64;
const key = (x, fill, label) => {
  T.push(`<rect x="${x}" y="${ky - 9}" width="12" height="10" rx="2" fill="${fill}"/>`);
  T.push(txt(x + 17, ky, label, { size: FIG.note, fill: MUTED }));
  return x + 17 + approxW(label, FIG.note) + 16;
};
key(
  key(PAD, MACHINE_SERIES[0], `${N.coresLocal} cores`),
  MACHINE_SERIES[1],
  `${N.coresPbox} cores`,
);

const LX = PAD; // group labels
const BW = 300; // bar length of the slowest run
const maxMs = Math.max(N.wholeMsLocal, N.wholeMsPbox, N.turboMsLocal, N.turboMsPbox);
const groups = [
  {
    name: "one checker process",
    how: "the whole workspace's source, once",
    runs: [
      [N.coresLocal, N.wholeMsLocal],
      [N.coresPbox, N.wholeMsPbox],
    ],
    change: `${fmtMult(N.wholeMsPbox / N.wholeMsLocal)} slower on ${N.coresPbox} cores`,
  },
  {
    name: "per-package pipeline",
    how: `${int(N.universalTasks)} tasks, incl. ${N.libs} lib builds`,
    runs: [
      [N.coresLocal, N.turboMsLocal],
      [N.coresPbox, N.turboMsPbox],
    ],
    change: `${fmtMult(N.turboMsLocal / N.turboMsPbox)} faster on ${N.coresPbox} cores`,
  },
];
// bar origin (0s): past the widest group label or note, measured, plus a gap
const BX = Math.ceil(
  LX +
    Math.max(
      ...groups.flatMap((g) => [approxW(g.name, FIG.label, true), approxW(g.how, FIG.note)]),
    ) +
    14,
);
const fmtT = (ms) => (ms >= 120000 ? mins(ms) : secs(ms));
let y = 92;
for (const g of groups) {
  T.push(txt(LX, y + 11, g.name, { size: FIG.label, weight: "600" }));
  T.push(txt(LX, y + 26, g.how, { size: FIG.note, fill: MUTED }));
  g.runs.forEach(([, ms], i) => {
    const by = y + i * 18;
    const w = +((ms / maxMs) * BW).toFixed(1);
    T.push(
      `<rect x="${BX}" y="${by}" width="${w}" height="13" rx="2" fill="${MACHINE_SERIES[i]}"/>`,
    );
    // one weight for both machines: neither run is the headline
    T.push(txt(BX + w + 7, by + 10.5, fmtT(ms), { size: FIG.body, weight: "600" }));
  });
  T.push(txt(W - PAD, y + 26, g.change, { size: FIG.note, fill: MUTED, anchor: "end" }));
  y += 58;
}
// the time axis: gridlines at round minutes, labelled under the bars
const TICK_MS = 5 * 60000;
for (let t = 0; t <= maxMs; t += TICK_MS) {
  const tx = +(BX + (t / maxMs) * BW).toFixed(1);
  T.push(`<line x1="${tx}" y1="86" x2="${tx}" y2="${y - 18}" stroke="${GRID}"/>`);
  T.push(
    txt(tx, y - 4, t === 0 ? "0" : `${t / 60000} min`, {
      size: FIG.note,
      fill: MUTED,
      anchor: "middle",
    }),
  );
}

// the figure is linked as a standalone PNG, so it carries its own caveats
const CAVEATS = [
  "Not like-for-like: the pipeline also builds each lib's dist; the one checker process only type-checks.",
  "One run per machine: a cross-machine observation, not a controlled core-scaling experiment.",
  // bun starts every pipeline task, so a bun change is on the pipeline rows' timed path
  ...(bunDiffers
    ? [
        `The pipeline rows also ran different bun versions (${N.bun} / ${N.bunPbox}), which start every task.`,
      ]
    : []),
];
y += 18;
for (const c of CAVEATS) {
  T.push(txt(PAD, y, c, { size: FIG.note, fill: MUTED }));
  y += 15;
}

// the facts the old infographic carried, as two muted lines
y += 7;
T.push(
  txt(
    PAD,
    y,
    `Also on the ${N.coresLocal}-core box: install ${secs(N.installMs)} (bun, warm store) · lint ${secs(N.oxlintMs)} (oxlint) · breaking rev caught in ${secs(N.breakMs)}`,
    { size: FIG.note, fill: MUTED },
  ),
);
y += 15;
T.push(
  txt(
    PAD,
    y,
    `${bunLabel} · turbo ${N.turbo} · tsgo ${bareVer(N.tsgo)} · oxlint ${bareVer(N.oxlint)} · node ${bareVer(N.node)}`,
    { size: FIG.note, fill: MUTED },
  ),
);
y += 34;
T.push(
  ...footer(
    W,
    y,
    "bench/fleet-gate-bench.json · bench/fleet-gate-bench.pbox.json · bench/fleet-shape.json",
  ),
);
y += 12;

emitChart(
  "fleet-gate",
  svgDoc(
    W,
    y,
    `The worst case on two machines: a foundation rev on the ${int(N.apps)}-app fleet checked by one checker process in ${secs(N.wholeMsLocal)} on ${N.coresLocal} cores and ${secs(N.wholeMsPbox)} on ${N.coresPbox}, and by the per-package pipeline in ${mins(N.turboMsLocal)} and ${mins(N.turboMsPbox)}. ${CAVEATS.join(" ")}`,
    T,
  ),
  { strict: true },
);

// the text alternative (FLEET.md, under the figure)
writeDocBlock(
  "FLEET.md",
  "fleet-gate",
  mdDetails(
    "The figure's numbers as a table",
    [
      mdTable(
        ["", `${N.coresLocal} cores`, `${N.coresPbox} cores`],
        [
          ["one checker process", secs(N.wholeMsLocal), secs(N.wholeMsPbox)],
          [
            `per-package pipeline (${int(N.universalTasks)} tasks)`,
            mins(N.turboMsLocal),
            mins(N.turboMsPbox),
          ],
          ["bun", N.bun, N.bunPbox],
        ],
      ),
      `On the ${N.coresLocal}-core box: one checker process peaks at ${int(N.wholeRssMB)}MB RSS; a breaking rev is caught in ${secs(N.breakMs)} with all ${int(N.breakApps)} apps flagged; a leaf-lib edit re-runs ${N.leafTasks} tasks; the ${int(N.apps + N.libs)}-package install takes ${secs(N.installMs)} (bun, warm store) and linting the tree ${secs(N.oxlintMs)} (oxlint). The tree is ${int(N.apps)} apps + ${N.libs} libs, about ${(N.files / 1e6).toFixed(2)} million generated files; ${N.universalLibs} libs are imported by every app. turbo ${N.turbo} · tsgo ${bareVer(N.tsgo)} · oxlint ${bareVer(N.oxlint)} · node ${bareVer(N.node)}.`,
      "Fields: `bench/fleet-gate-bench.json` and `bench/fleet-gate-bench.pbox.json`: `optimalGate.{ms,maxRssMB,kind}`, `turboGate.{ms,total,ran,kind}`, `leafGate.{total,ran}`, `breakingChange.{ms,appsWithErrors,caught}`, `install.ms`, `summary.oxlintMs`, `machine.{cores,arch}`, `versions.{bun,turbo,tsgo,oxlint,node}`, `apps`, `libs`, `modulesPerLib`, `shape`, `foundationLib`, `leafLib`. `bench/fleet-shape.json`: `fleetContext.presetParams.approxFilesFullScale`, `generated.universalLibs`.",
    ].join("\n\n"),
  ),
);

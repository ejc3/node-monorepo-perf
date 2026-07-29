#!/usr/bin/env node
// The fleet-scale infographic: what a change costs in a 30,000-app workspace,
// told for engineers who don't live in monorepo tooling. Three questions, one
// panel each: how far does a change reach (task counts), the worst case run
// two ways (one-command check vs per-package pipeline), and whether a bigger
// machine helps (core counts read from each record's machine field). Deterministic from
// bench/fleet-gate-bench.json + bench/fleet-gate-bench.pbox.json +
// bench/fleet-shape.json (no hand numbers; missing fields throw) ->
// bench/charts/fleet-gate.svg + a 300 DPI PNG in the same run.
//
//   node scripts/fleet-chart.mjs        (make fleet-chart)

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

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
  turbo: need(LOCAL, "versions.turbo"),
  tsgo: need(LOCAL, "versions.tsgo"),
  // machine provenance recorded by the bench itself — the cross-box claims
  // must trace to the records, not to file names or memory
  coresLocal: need(LOCAL, "machine.cores"),
  coresPbox: need(PBOX, "machine.cores"),
  // libs imported by 100% of apps, measured from the manifests by fleet-shape-verify
  universalLibs: need(SHAPE, "generated.universalLibs"),
};
if (need(PBOX, "apps") !== N.apps || need(PBOX, "turboGate.total") !== N.universalTasks)
  throw new Error("local and pbox datasets are not the same shape — refusing to compare");
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

const secs = (ms) => (ms >= 100000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;

// --- the shared visual grammar (same ramp/ink as every chart in this repo) ---
const RAMP = [
  [1, [26, 127, 55]],
  [2, [214, 168, 28]],
  [10, [198, 98, 28]],
  [100, [176, 42, 42]],
];
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const rampRGB = (mult) => {
  if (mult <= 1.0001) return RAMP[0][1];
  const m = Math.min(mult, RAMP[RAMP.length - 1][0]);
  const lm = Math.log10(m);
  for (let i = 0; i < RAMP.length - 1; i++) {
    const [m0, c0] = RAMP[i];
    const [m1, c1] = RAMP[i + 1];
    if (m <= m1) {
      const f = (lm - Math.log10(m0)) / (Math.log10(m1) - Math.log10(m0));
      return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f)];
    }
  }
  return RAMP[RAMP.length - 1][1];
};
const rgbCss = ([r, g, b]) => `rgb(${r},${g},${b})`;
const relLum = ([r, g, b]) => {
  const lin = (c) => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
const DARK_INK_L = relLum([10, 13, 18]);
const inkFor = (rgb) => {
  const L = relLum(rgb);
  return contrast(L, DARK_INK_L) >= contrast(L, 1) ? "#0a0d12" : "#ffffff";
};
const fmtMult = (m) => "×" + (m < 100 ? m.toFixed(1) : Math.round(m));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --- layout ------------------------------------------------------------------
const W = 900;
const PAD = 28;
const T = [];
let y = 0;

const title = (t, size, fill, dy) => {
  y += dy;
  T.push(
    `<text x="${PAD}" y="${y}" font-size="${size}" font-weight="600" fill="${fill}">${esc(t)}</text>`,
  );
};
const note = (t, dy) => {
  // wrap at ~150 chars so a long caption never runs past the viewport
  const words = String(t).split(" ");
  const rows = [""];
  for (const w of words) {
    if ((rows[rows.length - 1] + " " + w).trim().length > 150) rows.push(w);
    else rows[rows.length - 1] = (rows[rows.length - 1] + " " + w).trim();
  }
  rows.forEach((row, i) => {
    y += i === 0 ? dy : 16;
    T.push(`<text x="${PAD}" y="${y}" font-size="12" fill="#57606a">${esc(row)}</text>`);
  });
};
// one wide "fact cell": colored block with a big number + up to two
// explanation lines (subs may be a string or [line1, line2])
function cell(x, w, h, rgb, big, subs) {
  const ink = inkFor(rgb);
  const lines = Array.isArray(subs) ? subs : [subs];
  T.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${rgbCss(rgb)}"/>`);
  T.push(
    `<text x="${x + 14}" y="${y + 26}" font-size="18" font-weight="700" fill="${ink}">${esc(big)}</text>`,
  );
  lines.forEach((sub, i) => {
    T.push(
      `<text x="${x + 14}" y="${y + 44 + i * 15}" font-size="11.5" fill="${ink}" opacity="0.92">${esc(sub)}</text>`,
    );
  });
}
const GREY = [246, 248, 250];
function greyCell(x, w, h, big, sub) {
  T.push(
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="rgb(246,248,250)" stroke="#d0d7de"/>`,
  );
  T.push(
    `<text x="${x + 14}" y="${y + 26}" font-size="18" font-weight="700" fill="#0a0d12">${esc(big)}</text>`,
  );
  T.push(`<text x="${x + 14}" y="${y + 44}" font-size="11.5" fill="#57606a">${esc(sub)}</text>`);
}

// ---- title block ----
title(
  `A ${N.apps.toLocaleString("en-US")}-app workspace: what a change actually costs`,
  20,
  "#0a0d12",
  44,
);
note(
  `${N.apps.toLocaleString("en-US")} Next.js apps + ${N.libs} shared libs in one workspace — about ${(N.files / 1e6).toFixed(2)} million generated files. Every number below was measured on this tree.`,
  22,
);

// ---- panel 1: blast radius ----
title("1. How far does a change reach?", 15, "#0a0d12", 40);
note(
  `${N.universalLibs} of the libs are imported by every app. Change one and the pipeline re-runs a task for every package (plus the lib builds); change an ordinary lib and almost nothing runs.`,
  20,
);
y += 14;
const colW = (W - PAD * 2 - 16) / 2;
cell(
  PAD,
  colW,
  56,
  rampRGB(Math.max(2, N.universalTasks / N.leafTasks)),
  `${N.universalTasks.toLocaleString("en-US")} tasks re-run`,
  "edit a lib that EVERY app imports (the worst case)",
);
cell(
  PAD + colW + 16,
  colW,
  56,
  rampRGB(1),
  `${N.leafTasks} tasks re-run`,
  `edit an ordinary leaf lib — ${Math.round(N.universalTasks / N.leafTasks)}× smaller blast radius`,
);
y += 56;

// ---- panel 2: the worst case, two ways ----
title(`2. The worst case, run two ways (${N.coresLocal}-core box)`, 15, "#0a0d12", 40);
note(
  "Same question — “did my change break any app?” — two mechanisms. Not like-for-like: the pipeline also builds each lib's dist output; the one command only type-checks.",
  20,
);
y += 14;
const m2 = N.turboMsLocal / N.wholeMsLocal;
cell(PAD, colW, 74, rampRGB(1), `${secs(N.wholeMsLocal)} — one command`, [
  `a single checker reads the whole workspace's source once`,
  `(peak memory: ${N.wholeRssMB.toLocaleString("en-US")}MB recorded — a ~50GB-class box)`,
]);
cell(PAD + colW + 16, colW, 74, rampRGB(m2), `${mins(N.turboMsLocal)} — ${fmtMult(m2)} slower`, [
  `standard pipeline: ${N.universalTasks.toLocaleString("en-US")} tasks — a checker process`,
  `per affected package plus ${N.libs} lib builds`,
]);
y += 74 + 12;
greyCell(
  PAD,
  W - PAD * 2,
  56,
  `A breaking change is caught in ${secs(N.breakMs)}`,
  `all ${N.breakApps.toLocaleString("en-US")} affected apps flagged with exact file and line — the fix-list a codemod can consume`,
);
y += 56;

// ---- panel 3: bigger machine? ----
title("3. Does a bigger machine help?", 15, "#0a0d12", 40);
note(
  `The same two mechanisms on two different machines (${N.coresLocal} vs ${N.coresPbox} cores, recorded per run). One comparison each — a cross-machine observation, not a controlled core-scaling experiment.`,
  20,
);
y += 14;
const mWhole = N.wholeMsPbox / N.wholeMsLocal;
const mTurbo = N.turboMsLocal / N.turboMsPbox;
// row 1: the one-command check — fastest cell (the SMALL box) green
cell(PAD, colW, 74, rampRGB(1), `one command, ${N.coresLocal} cores: ${secs(N.wholeMsLocal)}`, [
  `one process; the smaller box was faster`,
]);
cell(
  PAD + colW + 16,
  colW,
  74,
  rampRGB(mWhole),
  `one command, ${N.coresPbox} cores: ${secs(N.wholeMsPbox)}`,
  [`${fmtMult(mWhole)} slower — this check did not gain from the bigger box`],
);
y += 74 + 12;
// row 2: the pipeline — fastest cell (the BIG box) green
cell(PAD, colW, 74, rampRGB(mTurbo), `pipeline, ${N.coresLocal} cores: ${mins(N.turboMsLocal)}`, [
  `${fmtMult(mTurbo)} slower than the big box`,
]);
cell(
  PAD + colW + 16,
  colW,
  74,
  rampRGB(1),
  `pipeline, ${N.coresPbox} cores: ${mins(N.turboMsPbox)}`,
  [
    `ran ${mTurbo.toFixed(1)}× faster on this box (${(N.coresPbox / N.coresLocal).toFixed(1)}× the cores)`,
  ],
);
y += 74;

// ---- footer facts + sources ----
y += 34;
T.push(`<line x1="${PAD}" y1="${y - 16}" x2="${W - PAD}" y2="${y - 16}" stroke="#d0d7de"/>`);
T.push(
  `<text x="${PAD}" y="${y}" font-size="11.5" fill="#57606a">${esc(
    `also measured: installing the ${(N.apps + N.libs).toLocaleString("en-US")}-package workspace (plus its external deps) takes ${secs(N.installMs)} (bun, warm store) · linting the whole tree takes ${secs(N.oxlintMs)} (oxlint)`,
  )}</text>`,
);
y += 18;
T.push(
  `<text x="${PAD}" y="${y}" font-size="11.5" fill="#57606a">${esc(
    `toolchain: bun ${N.bun} · turbo ${N.turbo} · tsgo ${N.tsgo.replace("Version ", "")}`,
  )}</text>`,
);
y += 20;
// each source link is its own positioned <text> (tspan flow inside <a> is not
// reliable across renderers — links overlapped when flowed in one text run)
{
  let lx = PAD;
  const putText = (t, fill) => {
    T.push(`<text x="${lx}" y="${y}" font-size="11" fill="${fill}">${esc(t)}</text>`);
    lx += Math.round(t.length * 6.1);
  };
  putText("data: ", "#57606a");
  const links = [
    ["fleet-gate-bench.json", "../fleet-gate-bench.json"],
    ["fleet-gate-bench.pbox.json", "../fleet-gate-bench.pbox.json"],
    ["fleet-shape.json", "../fleet-shape.json"],
  ];
  links.forEach(([t, href], i) => {
    T.push(
      `<a href="${href}"><text x="${lx}" y="${y}" font-size="11" fill="#0969da">${esc(t)}</text></a>`,
    );
    lx += Math.round(t.length * 6.1);
    if (i < links.length - 1) putText("  ·  ", "#57606a");
  });
}
y += 26;

const H = y;
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">`,
  `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
  ...T,
  `</svg>`,
].join("\n");

mkdirSync("bench/charts", { recursive: true });
const SVG_PATH = join("bench", "charts", "fleet-gate.svg");
const PNG_PATH = join("bench", "charts", "fleet-gate.png");
writeFileSync(SVG_PATH, svg + "\n");
console.log(`wrote ${SVG_PATH} (${W}x${H})`);

// 300 DPI raster in the same step (repo chart convention; charts.yml re-renders
// and fails the job if convert fails, so a stale PNG can't survive)
const conv = spawnSync("convert", ["-density", "300", SVG_PATH, PNG_PATH], { encoding: "utf8" });
if (conv.status !== 0 || !existsSync(PNG_PATH) || statSync(PNG_PATH).size === 0) {
  console.error(`convert failed: ${(conv.stderr || "").slice(-300)}`);
  process.exit(1);
}
console.log(`wrote ${PNG_PATH}`);

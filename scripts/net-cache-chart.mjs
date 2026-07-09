#!/usr/bin/env node
// Renders bench/ci-cache-network-bench.json as a heat table in the house chart
// grammar (same palette/type/ramp as comparison-chart.mjs): rows = tasks, columns =
// cold-compute + the three cache-restore profiles. Per row the fastest cell is green
// and every other cell's headline is its multiple of that best, so the eye reads
// two things at once — every cache profile beats cold compute, and the large build
// cache is the one cell the network ambers. Deterministic from the JSON (no hand
// numbers); missing fields throw. SVG + 300-DPI PNG in one step.
//   node scripts/net-cache-chart.mjs

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA = JSON.parse(readFileSync("bench/ci-cache-network-bench.json", "utf8"));
const need = (v, what) => {
  if (v === undefined || v === null) throw new Error(`ci-cache-network-bench.json missing ${what}`);
  return v;
};

// --- house palette + heat ramp (identical to comparison-chart.mjs) --------------
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
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const secs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`);
// Always MB, matching the bench log; ≥10 MB rounds to integer, sub-MB keeps one decimal.
const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;
// Rough advance-width estimate (px) so the canvas widens to fit prose, never clips.
const approxW = (str, px, bold) => str.length * px * (bold ? 0.58 : 0.53);

// --- columns: cold + each profile, subtitles derived from the JSON's shaping ----
const rateLabel = (rate) => {
  const m = /^(\d+)mbit$/.exec(rate || "");
  if (!m) return rate || "";
  const n = Number(m[1]);
  return n >= 1000 ? `${n / 1000} Gbps` : `${n} Mbps`;
};
const profileSub = (p) =>
  p.rttMs === 0 ? "floor · no network" : `${rateLabel(p.rate)} · ${p.rttMs} ms`;
const COLS = [{ key: "__cold__", head: "cold compute", sub: "no shared cache" }].concat(
  need(DATA.profiles, "profiles").map((p) => ({ key: p.name, head: p.name, sub: profileSub(p) })),
);

const TASK_ORDER = Object.keys(need(DATA.results, "results"));

// --- layout (house constants) --------------------------------------------------
const PAD = 28;
const LABEL_W = 250;
const COL_W = 150;
const HEAD_H = 52;
const ROW_H = 60;
// The one artifact that shows real network cost is the largest cache — derive its
// task + size from the data so the headline can't drift from the cells it summarizes.
const bigTask = TASK_ORDER.reduce((a, b) =>
  need(DATA.results[b].bytesTransferred, `${b}.bytesTransferred`) >
  need(DATA.results[a].bytesTransferred, `${a}.bytesTransferred`)
    ? b
    : a,
);
const bigMB = mb(DATA.results[bigTask].bytesTransferred);
const TITLE = "Remote cache restore: the network cost the localhost floor hides";
const FINDING = `A shared Turborepo cache beats cold compute on every link tested; only the ${bigMB} ${bigTask} cache carries a network cost, and it stays a few seconds — largest cross-region.`;
const LEGEND =
  "Cell: restore time · ×N vs the row's fastest. Cold compute carries no cache — the red baseline every restore beats.";
const srcLine = `Source: bench/ci-cache-network-bench.json — turbo ${DATA.versions?.turbo ?? "?"}, ${DATA.scale}, restore = median of ${DATA.samples}, ${DATA.env?.cores ?? "?"} cores. RTT = 2×netem delay; restores asserted all-cached-from-remote.`;

const tableW = PAD * 2 + LABEL_W + COL_W * COLS.length;
const W = Math.ceil(
  Math.max(
    tableW,
    PAD * 2 + approxW(TITLE, 20, true),
    PAD * 2 + approxW(FINDING, 13, false),
    PAD * 2 + approxW(LEGEND, 11, false),
    PAD * 2 + approxW(srcLine, 11, false),
  ),
);
const T = [];
let y = 128; // below title + finding + legend lines

// title + one-line finding + reading key
T.push(
  `<text x="${PAD}" y="42" font-size="20" font-weight="700" fill="#1f2328">${esc(TITLE)}</text>`,
);
T.push(`<text x="${PAD}" y="70" font-size="13" fill="#57606a">${esc(FINDING)}</text>`);
T.push(`<text x="${PAD}" y="98" font-size="11" fill="#57606a">${esc(LEGEND)}</text>`);

// header row
T.push(
  `<rect x="${PAD}" y="${y}" width="${LABEL_W}" height="${HEAD_H}" fill="#f6f8fa" stroke="#d0d7de"/>`,
);
T.push(
  `<text x="${PAD + 14}" y="${y + HEAD_H / 2 + 5}" font-size="12" font-weight="600" fill="#57606a">task (fresh CI runner)</text>`,
);
COLS.forEach((c, i) => {
  const x = PAD + LABEL_W + i * COL_W;
  T.push(
    `<rect x="${x}" y="${y}" width="${COL_W}" height="${HEAD_H}" fill="#f6f8fa" stroke="#d0d7de"/>`,
  );
  T.push(
    `<text x="${x + COL_W / 2}" y="${y + 22}" font-size="14" font-weight="700" fill="#1f2328" text-anchor="middle">${esc(c.head)}</text>`,
  );
  T.push(
    `<text x="${x + COL_W / 2}" y="${y + 39}" font-size="10" fill="#57606a" text-anchor="middle">${esc(c.sub)}</text>`,
  );
});
y += HEAD_H;

// data rows
for (const task of TASK_ORDER) {
  const r = DATA.results[task];
  const coldMs = need(r.coldNoRemoteMs, `${task}.coldNoRemoteMs`);
  const cells = COLS.map((c) =>
    c.key === "__cold__"
      ? coldMs
      : need(
          need(r.profiles[c.key], `${task}.profiles.${c.key}`).restoreMs,
          `${task}.profiles.${c.key}.restoreMs`,
        ),
  );
  const best = Math.min(...cells); // the row's fastest (a cache restore)

  // row label
  const cacheMB = mb(need(r.bytesTransferred, `${task}.bytesTransferred`));
  const nTasks = need(r.totalTasks, `${task}.totalTasks`);
  T.push(
    `<rect x="${PAD}" y="${y}" width="${LABEL_W}" height="${ROW_H}" fill="#ffffff" stroke="#d0d7de"/>`,
  );
  T.push(
    `<text x="${PAD + 14}" y="${y + ROW_H / 2 - 3}" font-size="15" font-weight="600" fill="#1f2328">${esc(task)}</text>`,
  );
  T.push(
    `<text x="${PAD + 14}" y="${y + ROW_H / 2 + 16}" font-size="11" fill="#57606a">${esc(cacheMB)} cache · ${nTasks} tasks</text>`,
  );

  cells.forEach((ms, i) => {
    const x = PAD + LABEL_W + i * COL_W;
    const mult = ms / best;
    const rgb = rampRGB(mult);
    const ink = inkFor(rgb);
    T.push(
      `<rect x="${x}" y="${y}" width="${COL_W}" height="${ROW_H}" fill="${rgbCss(rgb)}" stroke="#ffffff"/>`,
    );
    T.push(
      `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 - 2}" font-size="17" font-weight="700" fill="${ink}" text-anchor="middle">${esc(secs(ms))}</text>`,
    );
    const sub = mult <= 1.0001 ? "fastest" : `×${mult.toFixed(mult < 10 ? 1 : 0)}`;
    T.push(
      `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 + 16}" font-size="12" font-weight="600" fill="${ink}" text-anchor="middle">${esc(sub)}</text>`,
    );
  });
  y += ROW_H;
}

// source line
y += 26;
T.push(`<text x="${PAD}" y="${y}" font-size="11" fill="#57606a">${esc(srcLine)}</text>`);
y += 22;

const H = y;
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">`,
  `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
  ...T,
  `</svg>`,
].join("\n");

mkdirSync("bench/charts", { recursive: true });
const svgPath = join("bench/charts", "cache-network.svg");
writeFileSync(svgPath, svg);
console.log(`wrote ${svgPath} (${W}×${H})`);

const pngPath = join("bench/charts", "cache-network.png");
const conv = spawnSync(
  "convert",
  ["-density", "300", "-background", "white", svgPath, "-flatten", "-depth", "8", pngPath],
  {
    encoding: "utf8",
  },
);
if (conv.status !== 0 || conv.error)
  console.error(
    `! PNG not rasterized: convert ${conv.error ? "not found" : `exited ${conv.status}`}`,
  );
else console.log(`wrote ${pngPath}`);

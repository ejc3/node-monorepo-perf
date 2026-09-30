#!/usr/bin/env node
// Renders bench/ci-cache-network-bench.json as a heat table in the house chart
// grammar (the shared scripts/_chartstyle.mjs system): rows = tasks, columns =
// cold-compute + the three cache-restore profiles. Per row the fastest cell is green
// and every other cell's headline is its multiple of that best, so the eye reads
// two things at once — every cache profile beats cold compute, and the large build
// cache is the one cell the network ambers. Deterministic from the JSON (no hand
// numbers); missing fields throw. SVG + 300-DPI PNG in one step.
//   node scripts/net-cache-chart.mjs

import { readFileSync } from "node:fs";
import {
  MUTED,
  ACCENT,
  txt,
  svgDoc,
  sectionFrame,
  rampRGB,
  rgbCss,
  inkFor,
  nearTiePct,
  rampLegendItems,
  legendRow,
  heatCell,
  colHeader,
  wrapText,
  approxW,
  esc,
  emitChart,
} from "./_chartstyle.mjs";

const DATA = JSON.parse(readFileSync("bench/ci-cache-network-bench.json", "utf8"));
const need = (v, what) => {
  if (v === undefined || v === null) throw new Error(`ci-cache-network-bench.json missing ${what}`);
  return v;
};

const secs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`);
// Always MB, matching the bench log; ≥10 MB rounds to integer, sub-MB keeps one decimal.
const mb = (bytes) => `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;

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

// --- layout ---------------------------------------------------------------------
const PAD = 24;
const FR = 16;
const LABEL_W = 250;
const COL_W = 150;
const HEAD_H = 52;
const ROW_H = 58;
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
const KEY =
  "cell: restore time (big) · ×N vs the row's fastest (small). Cold compute carries no cache — the baseline every restore beats.";
const srcNote = `turbo ${DATA.versions?.turbo ?? "?"}, ${DATA.scale}, restore = median of ${DATA.samples}, ${DATA.env?.cores ?? "?"} cores. RTT = 2×netem delay; restores asserted all-cached-from-remote.`;

const tableW = PAD * 2 + FR * 2 + LABEL_W + COL_W * COLS.length;
const W = Math.ceil(
  Math.max(tableW, PAD * 2 + approxW(TITLE, 20, true), PAD * 2 + approxW(FINDING, 12.5)),
);
const FRAME_W = W - PAD * 2;
const INNER_W = FRAME_W - FR * 2;
const NOTE_CHARS = Math.floor(INNER_W / (10.5 * 0.53));
const T = [];

// ---- title block + legend band ----
T.push(txt(PAD, 40, TITLE, { size: 20, weight: "700" }));
T.push(txt(PAD, 62, FINDING, { size: 12.5, fill: MUTED }));
{
  const { parts, endX } = legendRow(PAD, 84, rampLegendItems().slice(0, 4));
  T.push(...parts);
  T.push(txt(endX + 8, 85, KEY, { size: 11, fill: MUTED }));
}

let y = 108;
{
  const x0 = PAD + FR;
  const gridX = x0 + LABEL_W;
  const noteLines = wrapText(srcNote, NOTE_CHARS);
  const frameH = FR + HEAD_H + TASK_ORDER.length * ROW_H + 20 + noteLines.length * 14 + FR - 2;
  T.push(sectionFrame(PAD, y, FRAME_W, frameH));

  let sy = y + FR - 8;
  // header row
  T.push(
    txt(x0, sy + HEAD_H / 2 + 4, "task (fresh CI runner)", {
      size: 11.5,
      fill: MUTED,
      weight: "600",
    }),
  );
  COLS.forEach((c, i) => {
    T.push(...colHeader(gridX + i * COL_W, sy, COL_W, HEAD_H, c.head, { sub: c.sub }));
  });
  sy += HEAD_H;

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

    // row label + its cache-size sub-line
    const cacheMB = mb(need(r.bytesTransferred, `${task}.bytesTransferred`));
    const nTasks = need(r.totalTasks, `${task}.totalTasks`);
    T.push(txt(x0, sy + ROW_H / 2 - 2, task, { size: 13.5, weight: "600" }));
    T.push(
      txt(x0, sy + ROW_H / 2 + 15, `${cacheMB} cache · ${nTasks} tasks`, {
        size: 10.5,
        fill: MUTED,
      }),
    );

    cells.forEach((ms, i) => {
      const x = gridX + i * COL_W;
      const mult = ms / best;
      const rgb = rampRGB(mult);
      // near-tie rule: within 5% of the fastest the sub is the honest +%, never "×1.0"
      const sub =
        mult <= 1.0001
          ? "fastest"
          : mult < 1.05
            ? nearTiePct(mult)
            : `×${mult.toFixed(mult < 10 ? 1 : 0)}`;
      T.push(...heatCell(x, sy, COL_W, ROW_H, rgbCss(rgb), inkFor(rgb), secs(ms), sub));
    });
    sy += ROW_H;
  }

  // provenance: source link + the methodology note
  sy += 16;
  T.push(txt(x0, sy, "Source:", { size: 10.5, fill: MUTED }));
  T.push(
    `<a href="${esc("../../bench/ci-cache-network-bench.json")}"><text x="${x0 + 44}" y="${sy}" font-size="10.5" fill="${ACCENT}" text-decoration="underline">bench/ci-cache-network-bench.json</text></a>`,
  );
  for (const ln of noteLines) {
    sy += 14;
    T.push(txt(x0, sy, ln, { size: 10.5, fill: MUTED }));
  }
  y += frameH;
}

const H = y + 12;
emitChart(
  "cache-network",
  svgDoc(
    W,
    H,
    `Remote cache restore versus cold compute across network profiles: rows are tasks with their cache size, columns are cold compute plus each shaped restore profile; per row the fastest cell is green and the rest show their multiple of it. ${FINDING}`,
    T,
  ),
);

#!/usr/bin/env node
// Render the million-module checker story as a stacked heat chart, in the same visual
// system as tool-comparison.svg (scripts/_chartstyle.mjs): per row the FASTEST cell is
// green and the rest show how many times slower (× N); near-ties show their +%. Cell
// states beyond numbers: "—" with its reason (anchor cutoff), a TIMEOUT cell — a
// request that outran its budget renders at that REAL ceiling as a floor ("timed out
// ≥2m") — and a CRASH cell, which shows status only (a wedge is not a measurement).
// Deterministic from the cited bench/*.json (no hand numbers) ->
// bench/charts/checker-scale.svg (+ a 300 DPI PNG in the same step).
//
//   node scripts/scale-chart.mjs

import { readFileSync } from "node:fs";
import {
  MUTED,
  ACCENT,
  txt,
  svgDoc,
  sectionFrame,
  RAMP,
  rampRGB,
  rgbCss,
  inkFor,
  fmtMult,
  nearTiePct,
  isFastest,
  isNearTie,
  rampLegendItems,
  legendRow,
  heatCell,
  naCell,
  colHeader,
  wrapText,
  esc,
  emitChart,
} from "./_chartstyle.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const TS = read("bench/tsgo-scale-bench.json");
const LSP = read("bench/lsp-scale-bench.json");
const RT = read("bench/flow-wedge-retest.json");

const P = (n) => TS.points[String(n)];
const L = (n) => LSP.results.find((r) => r.modules === n);
const med = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
// a measured row cell is {medianMs}; guard so a killed/skipped record can never read as a number
const rowMs = (rec, row) => {
  const v = rec?.[row];
  if (typeof v?.medianMs !== "number") throw new Error(`missing ${row}.medianMs in a cited record`);
  return v.medianMs;
};
// the flow column is a build of flow main (the wedge fixes verified in the retest);
// a dataset whose flow provenance changes must force a deliberate chart update
if (!String(TS.versions.flow).includes("flow main"))
  throw new Error(
    "expected the flow column to be a flow-main build — dataset changed, update the chart",
  );
const HOUR_MS = 3_600_000;
// tsgo LSP completion at 500k/1M is the recorded probe timeout at its request ceiling
const compCeil = (n) => {
  const c = L(n).tsgoLsp.warm.completionMs;
  if (!c?.timedOut || typeof c.ceilingMs !== "number")
    throw new Error(
      `expected the recorded completion timeout at ${n} — dataset changed, update the chart`,
    );
  return c.ceilingMs;
};

// timeout cell: renders at the REAL ceiling as a floor — "≥<ceiling>" + "≥×N slower".
// Reserved for genuine performance ceilings (a request that outran its budget); a CRASH
// is a different thing and shows STATUS ONLY, no derived numbers (a wedge is not a
// measurement, and a pseudo-time would read as one).
const TO = (floorMs, label) => ({ timeout: true, floorMs, label });
const CRASH = (label, sub) => ({ crash: true, label, sub });
const NAR = (why) => ({ na: true, why });

const SCALES = [
  [10000, "10k modules"],
  [100000, "100k modules"],
  [250000, "250k modules"],
  [500000, "500k modules"],
  [1000000, "1,000,000 modules"],
];
const LSP_SCALES = SCALES.filter(([n]) => LSP.results.some((r) => r.modules === n));

const SECTIONS = [
  {
    title: "Whole-program check — tsgo vs tsc vs Flow",
    compareAxis: "row",
    cols: [
      { k: "tsgo", label: "tsgo", chip: "tsgo" },
      { k: "tsc", label: "tsc", chip: "tsc" },
      { k: "flow", label: "Flow", chip: "flow" },
    ],
    rows: SCALES.map(([n, lbl]) => [
      lbl,
      {
        tsgo: rowMs(P(n).tsgo, "full"),
        tsc: P(n).tsc?.skipped ? NAR("anchor ≤100k") : rowMs(P(n).tsc, "full"),
        flow: rowMs(P(n).flow, "full"),
      },
    ]),
    source: "bench/tsgo-scale-bench.json",
    note: "Warm full check (no incremental state). tsc anchors at 100k (a cost cutoff, not a capacity result). The flow column is a build of flow main with the wedge fixes (provenance in the JSON) — released 0.321's server crashes at this scale (last section).",
  },
  {
    title: "A failing check vs a passing one — the red-gate premium, per checker",
    delta: true,
    cols: [
      { k: "tsgo", label: "tsgo\n(1M modules)", chip: "tsgo" },
      { k: "tsc", label: "tsc\n(100k modules)", chip: "tsc" },
      { k: "flow", label: "Flow\n(1M modules)", chip: "flow" },
    ],
    rows: [
      [
        "red check vs green check",
        {
          tsgo: {
            green: rowMs(P(1000000).tsgo, "full"),
            red: rowMs(P(1000000).tsgo, "fullWithLeafErrors"),
          },
          tsc: {
            green: rowMs(P(100000).tsc, "full"),
            red: rowMs(P(100000).tsc, "fullWithLeafErrors"),
          },
          flow: {
            green: rowMs(P(1000000).flow, "full"),
            red: rowMs(P(1000000).flow, "fullWithLeafErrors"),
          },
        },
      ],
    ],
    source: "bench/tsgo-scale-bench.json",
    note: "Each cell: the red run's cost relative to the green run at that checker's largest measured scale. The red run (3 seeded leaf errors in zero-dependent modules) must exit nonzero and report exactly the seeded errors — a failing gate costs what a passing one costs.",
  },
  {
    title: "One edit → verdict (the save loop, by mechanic)",
    compareAxis: "row",
    cols: [
      { k: "lsp", label: "tsgo --lsp\nsquiggle", chip: "tsgo" },
      { k: "tss", label: "tsserver\nsquiggle", chip: "tsc" },
      { k: "flow", label: "flow server\nedit", chip: "flow" },
      { k: "watch", label: "tsgo --watch", chip: "tsgo" },
      { k: "cli", label: "tsgo CLI\nincremental", chip: "tsgo" },
      { k: "tsccli", label: "tsc CLI\nincremental", chip: "tsc" },
    ],
    rows: LSP_SCALES.map(([n, lbl]) => [
      lbl,
      {
        lsp: L(n).tsgoLsp.warm.errorAppearsMs,
        tss: L(n).tsserver?.skipped ? null : L(n).tsserver.warm.errorAppearsMs,
        flow: rowMs(P(n).flow, "incrOneEdit"),
        watch: L(n).tsgoWatch.oneEditRecheckMs,
        cli: rowMs(P(n).tsgo, "incrOneEdit"),
        tsccli: P(n).tsc?.skipped ? null : rowMs(P(n).tsc, "incrOneEdit"),
      },
    ]),
    source: "bench/tsgo-scale-bench.json, bench/lsp-scale-bench.json",
    note: "Squiggle = the asserted didChange→TS2322→clear transition against a live server; flow = force-recheck+status round-trip; CLI = process relaunch on warm incremental state. Flow is measured from a main build (header) — released 0.321's server wedges under overlapping-edit pressure at this scale (facebook/flow#9454; the head-to-head below).",
  },
  {
    title: "Completion — different result sets, reported with counts",
    compareAxis: "row",
    cols: [
      { k: "tsgo", label: "tsgo --lsp", chip: "tsgo" },
      { k: "tss", label: "tsserver", chip: "tsc" },
    ],
    rows: LSP_SCALES.map(([n, lbl]) => [
      lbl,
      {
        tsgo:
          typeof L(n).tsgoLsp.warm.completionMs === "number"
            ? L(n).tsgoLsp.warm.completionMs
            : TO(compCeil(n), "timed out"),
        tss: L(n).tsserver?.skipped ? null : L(n).tsserver.warm.completionMs,
      },
    ]),
    source: "bench/lsp-scale-bench.json",
    note: "Not a like-for-like race: tsgo returns the full exported-symbol space (31,058 items at 10k; 301,058 at 100k) where tsserver returns a bounded 1,067-entry set — the × numbers price the responses a user actually waits for, with the set-size caveat. From 250k up tsgo exceeds its 120s request ceiling; tsserver is anchor-cut there.",
  },
  {
    title: `Flow's wedge under edit pressure — released ${RT.binaries.released.version} vs flow main (fixes in)`,
    compareAxis: "row",
    cols: [
      {
        k: "main",
        label: `flow main\n@ ${(RT.binaries.main.source.match(/@ ([0-9a-f]+)/) || [, "?"])[1]}`,
        chip: "flow",
      },
      { k: "rel", label: `released\n${RT.binaries.released.version}`, chip: "flow" },
    ],
    rows: [
      [
        "recheck round-trip (storm, median)",
        {
          main: med(RT.runs.find((r) => r.label === "main storm").cycles.map((c) => c.ms)),
          rel: med(RT.runs.find((r) => r.label === "released-0321 storm").cycles.map((c) => c.ms)),
        },
      ],
      [
        `overlapping-edit storm, ${RT.runs.find((r) => r.label === "main storm").cycles.length} cycles`,
        {
          main: {
            ok: true,
            label: `${RT.runs.find((r) => r.label === "main storm").cycles.length}/${RT.runs.find((r) => r.label === "main storm").cycles.length} clean`,
          },
          rel: CRASH(
            `wedged at cycle ${RT.runs.find((r) => r.label === "released-0321 storm").wedgedAtCycle}`,
            "WorkerCanceled panic",
          ),
        },
      ],
    ],
    source: "bench/flow-wedge-retest.json",
    note: `Storm = a second edit lands 120–480ms into an in-flight recheck (the trigger behind all three recorded wedges). 500k corpus. Sequential settled edits never trigger it on either binary; the fix is verified on flow main (facebook/flow#9454).`,
  },
];

// --- per-cell best/multiple: timeout cells contribute their FLOOR and can never be best ---------
const cellVal = (v) =>
  v == null || v.na || v.crash ? null : v.timeout ? v.floorMs : typeof v === "number" ? v : null;
const cellMult = (sec, ri, ci) => {
  const v = sec.rows[ri][1][sec.cols[ci].k];
  const n = cellVal(v);
  if (n == null) return null;
  const measured = sec.cols.map((c) => sec.rows[ri][1][c.k]).filter((x) => typeof x === "number");
  if (!measured.length) return null; // a timeout with no measured competitor gets no ×
  return n / Math.min(...measured);
};

// --- formatting ----------------------------------------------------------------------------------
const fmtS = (ms) => {
  if (ms >= HOUR_MS) return (ms / HOUR_MS).toFixed(0) + "h";
  if (ms >= 60_000 && ms % 60_000 === 0) return ms / 60_000 + "m";
  if (ms < 1000) return Math.round(ms) + "ms";
  const s = ms / 1000;
  return s < 10 ? s.toFixed(2) + "s" : s < 100 ? s.toFixed(1) + "s" : Math.round(s) + "s";
};

// --- layout --------------------------------------------------------------------------------------
const PAD = 24;
const FR = 16;
const LABEL_W = 250;
const COL_W = 150;
const ROW_H = 54;
const HEAD_H = 52;
const MAXCOLS = Math.max(...SECTIONS.map((s) => s.cols.length));
const W = PAD * 2 + FR * 2 + LABEL_W + COL_W * MAXCOLS;
const FRAME_W = W - PAD * 2;
const INNER_W = FRAME_W - FR * 2;
const NOTE_CHARS = Math.floor(INNER_W / (10.5 * 0.53));
const T = [];

// ---- title block + legend band ----
T.push(
  txt(PAD, 40, "Type checkers at scale — 10k to 1,000,000 modules", { size: 20, weight: "700" }),
);
T.push(
  txt(
    PAD,
    62,
    "Fastest cell in each row green; near-ties show their +%; others show how many times slower. A request that outran its budget shows that real ceiling as a floor (≥); a crash shows status, never a number.",
    { size: 12.5, fill: MUTED },
  ),
);
T.push(
  txt(
    PAD,
    80,
    `tsgo ${TS.versions.tsgo} · tsc ${TS.versions.typescript} (64GB heap) · flow ${(String(TS.versions.flow).match(/flow main @ [0-9a-f]+/) || ["main build"])[0].replace("flow main", "main")} (wedge fixes in) · ${TS.cores}-core host. Every number traces to the cited bench JSON.`,
    { size: 12.5, fill: MUTED },
  ),
);
{
  const items = rampLegendItems();
  items.push({
    c: rgbCss(RAMP[RAMP.length - 1][1]),
    t: "timed out ≥ceiling / crash = status only",
  });
  const { parts, endX } = legendRow(PAD, 102, items);
  T.push(...parts);
  T.push(txt(endX + 8, 103, "cell: ×N slower (big) · its time (small)", { size: 11, fill: MUTED }));
}

let y = 126;
for (const sec of SECTIONS) {
  const x0 = PAD + FR;
  const gridX = x0 + LABEL_W;
  const noteLines = sec.note ? wrapText(sec.note, NOTE_CHARS) : [];
  const frameH =
    FR + 22 + 8 + HEAD_H + sec.rows.length * ROW_H + 20 + noteLines.length * 14 + FR - 2;
  T.push(sectionFrame(PAD, y, FRAME_W, frameH));

  let sy = y + FR + 8;
  T.push(txt(x0, sy, sec.title, { size: 15, weight: "700" }));
  sy += 14;
  T.push(txt(x0, sy + HEAD_H / 2 + 4, "scenario", { size: 11.5, fill: MUTED, weight: "600" }));
  sec.cols.forEach((col, ci) => {
    T.push(...colHeader(gridX + ci * COL_W, sy, COL_W, HEAD_H, col.label, col));
  });
  sy += HEAD_H;
  sec.rows.forEach((row, ri) => {
    T.push(txt(x0, sy + ROW_H / 2 + 4, row[0], { size: 12.5 }));
    sec.cols.forEach((col, ci) => {
      const x = gridX + ci * COL_W;
      const v = row[1][col.k];
      if (v == null || v.na) {
        T.push(...naCell(x, sy, COL_W, ROW_H, v && v.why ? v.why : null));
      } else if (v.crash) {
        // a crash is a status, not a measurement: no time, no multiplier
        const rgb = RAMP[RAMP.length - 1][1];
        T.push(...heatCell(x, sy, COL_W, ROW_H, rgbCss(rgb), inkFor(rgb), v.label, v.sub || ""));
      } else if (v.green !== undefined && v.red !== undefined) {
        // delta cell: the red-gate premium as a percentage, times as the sub-line
        const pct = ((v.red - v.green) / v.green) * 100;
        const rgb = Math.abs(pct) < 5 ? RAMP[0][1] : rampRGB(1 + Math.abs(pct) / 100);
        T.push(
          ...heatCell(
            x,
            sy,
            COL_W,
            ROW_H,
            rgbCss(rgb),
            inkFor(rgb),
            `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
            `${fmtS(v.red)} red vs ${fmtS(v.green)} green`,
          ),
        );
      } else if (v.ok) {
        const rgb = RAMP[0][1];
        T.push(...heatCell(x, sy, COL_W, ROW_H, rgbCss(rgb), inkFor(rgb), v.label, "no panic"));
      } else if (v.timeout) {
        // the headline the timeout deserves: the ≥× computed from the run's REAL
        // ceiling against the row's measured best — never green. With no measured
        // competitor in the row, the floor itself is the headline.
        const mult = cellMult(sec, ri, ci);
        const rgb = RAMP[RAMP.length - 1][1];
        T.push(
          ...heatCell(
            x,
            sy,
            COL_W,
            ROW_H,
            rgbCss(rgb),
            inkFor(rgb),
            mult == null ? `${v.label} ≥${fmtS(v.floorMs)}` : `≥${fmtMult(mult)} slower`,
            mult == null ? "hit its ceiling" : `${v.label} ≥${fmtS(v.floorMs)}`,
          ),
        );
      } else {
        // the × multiplier IS the headline for every non-fastest cell; the absolute
        // time is the sub-line. Near-ties are not "×1.0 slower" — within 5% of the
        // fastest the time stays the headline with the honest +N% as the sub-line.
        const mult = cellMult(sec, ri, ci);
        const rgb = rampRGB(mult);
        const fastest = isFastest(mult);
        const nearTie = isNearTie(mult);
        T.push(
          ...heatCell(
            x,
            sy,
            COL_W,
            ROW_H,
            rgbCss(rgb),
            inkFor(rgb),
            fastest || nearTie ? fmtS(v) : fmtMult(mult) + " slower",
            fastest ? "fastest" : nearTie ? nearTiePct(mult) : fmtS(v),
          ),
        );
      }
    });
    sy += ROW_H;
  });
  sy += 16;
  {
    // clickable source links (relative hrefs — resolve from bench/charts/ wherever the
    // SVG is served; GitHub's README <img> strips interactivity, the Raw view keeps it)
    const parts = sec.source.split(", ");
    let sx = x0;
    T.push(txt(sx, sy, "Source:", { size: 10.5, fill: MUTED }));
    sx += 44;
    parts.forEach((p, i) => {
      const label = p + (i < parts.length - 1 ? "," : "");
      T.push(
        `<a href="${esc("../../" + p)}"><text x="${sx}" y="${sy}" font-size="10.5" fill="${ACCENT}" text-decoration="underline">${esc(label)}</text></a>`,
      );
      sx += label.length * 5.5 + 8;
    });
  }
  for (const ln of noteLines) {
    sy += 14;
    T.push(txt(x0, sy, ln, { size: 10.5, fill: MUTED }));
  }
  y += frameH + 16;
}

const H = y + 8;
emitChart(
  "checker-scale",
  svgDoc(
    W,
    H,
    "Type checkers at scale, 10k to one million modules: whole-program check (tsgo vs tsc vs Flow), the red-gate premium, the one-edit save loop by mechanic, completion, and Flow's wedge under edit pressure; per row the fastest cell is green and the rest show how many times slower.",
    T,
  ),
);
console.log(
  `sections: ${SECTIONS.length}, scenario rows: ${SECTIONS.reduce((n, s) => n + s.rows.length, 0)}`,
);

#!/usr/bin/env node
// Render the million-module checker story as a stacked heat chart, in the same visual
// system as tool-comparison.svg: per row the FASTEST cell is green and the rest show how
// many times slower (× N). Two cell states beyond numbers: "—" (not measured: anchor
// cutoff, or after a checker died at a smaller scale) and a TIMEOUT cell — a run that hit
// its ceiling renders at that REAL ceiling as a floor ("wedged ≥1h", "≥×3,629 slower"),
// never as a dash and never as green. Deterministic from the cited bench/*.json (no hand
// numbers) -> bench/charts/checker-scale.svg (+ a 300 DPI PNG in the same step).
//
//   node scripts/scale-chart.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

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
// the flow 500k one-edit row is the recorded wedge: killed+timedOut at the bench's 1h ceiling
if (!(P(500000).flow.incrOneEdit?.killed && P(500000).flow.incrOneEdit?.timedOut))
  throw new Error(
    "expected the recorded flow 500k incrOneEdit timeout — dataset changed, update the chart",
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

// timeout cell: renders at the REAL ceiling as a floor — "≥<ceiling>" + "≥×N slower"
const TO = (floorMs, label) => ({ timeout: true, floorMs, label });

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
      { k: "tsgo", label: "tsgo" },
      { k: "tsc", label: "tsc" },
      { k: "flow", label: "Flow" },
    ],
    rows: SCALES.map(([n, lbl]) => [
      lbl,
      {
        tsgo: rowMs(P(n).tsgo, "full"),
        tsc: P(n).tsc?.skipped ? null : rowMs(P(n).tsc, "full"),
        flow: P(n).flow?.skipped ? null : rowMs(P(n).flow, "full"),
      },
    ]),
    source: "bench/tsgo-scale-bench.json",
    note: "Warm full check (no incremental state). tsc anchors at 100k (a cost cutoff, not a capacity result). Flow's 1M cells are unmeasured: its 0.321 server wedged at 500k in the one-edit rows below — the red rows (3 seeded leaf errors, exact count asserted) cost within ~2% of these green runs for every checker at every measured scale.",
  },
  {
    title: "A failing check vs a passing one — tsgo, 1,000,000 modules",
    compareAxis: "row",
    cols: [
      { k: "green", label: "clean corpus" },
      { k: "red", label: "3 leaf type errors" },
    ],
    rows: [
      [
        "whole-program check",
        {
          green: rowMs(P(1000000).tsgo, "full"),
          red: rowMs(P(1000000).tsgo, "fullWithLeafErrors"),
        },
      ],
    ],
    source: "bench/tsgo-scale-bench.json",
    note: "The red run must exit nonzero and report exactly the seeded errors. Diagnostic construction is not a cost axis at this corpus's error counts.",
  },
  {
    title: "One edit → verdict (the save loop, by mechanic)",
    compareAxis: "row",
    cols: [
      { k: "lsp", label: "tsgo --lsp\nsquiggle" },
      { k: "tss", label: "tsserver\nsquiggle" },
      { k: "flow", label: "flow server\nedit" },
      { k: "watch", label: "tsgo --watch" },
      { k: "cli", label: "tsgo CLI\nincremental" },
      { k: "tsccli", label: "tsc CLI\nincremental" },
    ],
    rows: LSP_SCALES.map(([n, lbl]) => [
      lbl,
      {
        lsp: L(n).tsgoLsp.warm.errorAppearsMs,
        tss: L(n).tsserver?.skipped ? null : L(n).tsserver.warm.errorAppearsMs,
        flow:
          n === 500000
            ? TO(HOUR_MS, "wedged")
            : P(n).flow?.skipped
              ? null
              : rowMs(P(n).flow, "incrOneEdit"),
        watch: L(n).tsgoWatch.oneEditRecheckMs,
        cli: rowMs(P(n).tsgo, "incrOneEdit"),
        tsccli: P(n).tsc?.skipped ? null : rowMs(P(n).tsc, "incrOneEdit"),
      },
    ]),
    source: "bench/tsgo-scale-bench.json, bench/lsp-scale-bench.json",
    note: "Squiggle = the asserted didChange→TS2322→clear transition against a live server; flow = force-recheck+status round-trip; CLI = process relaunch on warm incremental state. The 500k flow cell is the recorded WorkerCanceled wedge (facebook/flow#9454, fixed on flow main, unreleased as of 0.321): the client hung to the bench's 1h ceiling, so its cell shows that REAL timeout as a floor. Flow's clean 250k round-trip (939ms) sits between the 100k and 500k rows shown here.",
  },
  {
    title: "Completion — different result sets, reported with counts",
    compareAxis: "row",
    cols: [
      { k: "tsgo", label: "tsgo --lsp" },
      { k: "tss", label: "tsserver" },
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
    note: "Not a like-for-like race: tsgo returns the full exported-symbol space (31,058 items at 10k; 301,058 at 100k) where tsserver returns a bounded 1,067-entry set — the × numbers price the responses a user actually waits for, with the set-size caveat. At 500k+ tsgo exceeds its 120s request ceiling; tsserver is anchor-cut there.",
  },
  {
    title: `Flow's wedge under edit pressure — released ${RT.binaries.released.version} vs flow main (fixes in)`,
    compareAxis: "row",
    cols: [
      {
        k: "main",
        label: `flow main\n@ ${(RT.binaries.main.source.match(/@ ([0-9a-f]+)/) || [, "?"])[1]}`,
      },
      { k: "rel", label: `released\n${RT.binaries.released.version}` },
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
          rel: TO(
            RT.runs.find((r) => r.label === "released-0321 storm").hungCeilingMin * 60_000,
            "wedged",
          ),
        },
      ],
    ],
    source: "bench/flow-wedge-retest.json",
    note: `Storm = a second edit lands 120–480ms into an in-flight recheck (the trigger behind all three recorded wedges). 500k corpus. Released ${RT.binaries.released.version} wedged at cycle ${RT.runs.find((r) => r.label === "released-0321 storm").wedgedAtCycle} of ${RT.runs.find((r) => r.label === "main storm").cycles.length} — the WorkerCanceled panic — and its client hung to the retest's ${RT.runs.find((r) => r.label === "released-0321 storm").hungCeilingMin}-minute ceiling, shown as the floor. Sequential settled edits never trigger it on either binary.`,
  },
];

// --- per-cell best/multiple: timeout cells contribute their FLOOR and can never be best ---------
const cellVal = (v) =>
  v == null ? null : v.timeout ? v.floorMs : typeof v === "number" ? v : null;
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
const fmtMult = (m) => "×" + (m < 10 ? m.toFixed(1) : Math.round(m).toLocaleString("en-US"));

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
  const Lm = relLum(rgb);
  return contrast(Lm, DARK_INK_L) >= contrast(Lm, 1) ? "#0a0d12" : "#ffffff";
};

// --- layout --------------------------------------------------------------------------------------
const LABEL_W = 250;
const COL_W = 150;
const ROW_H = 56;
const HEAD_H = 50;
const PAD = 28;
const MAXCOLS = Math.max(...SECTIONS.map((s) => s.cols.length));
const W = PAD * 2 + LABEL_W + COL_W * MAXCOLS;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const T = [];
let y = 108;

const gridX = PAD + LABEL_W;
for (const sec of SECTIONS) {
  T.push(
    `<text x="${PAD}" y="${y}" font-size="16" font-weight="700" fill="#1f2328">${esc(sec.title)}</text>`,
  );
  y += 18;
  T.push(
    `<rect x="${PAD}" y="${y}" width="${LABEL_W}" height="${HEAD_H}" fill="#f6f8fa" stroke="#d0d7de"/>`,
  );
  T.push(
    `<text x="${PAD + 12}" y="${y + HEAD_H / 2 + 5}" font-size="12" font-weight="600" fill="#57606a">scenario</text>`,
  );
  sec.cols.forEach((col, ci) => {
    const x = gridX + ci * COL_W;
    T.push(
      `<rect x="${x}" y="${y}" width="${COL_W}" height="${HEAD_H}" fill="#f6f8fa" stroke="#d0d7de"/>`,
    );
    const lines = col.label.split("\n");
    const ly = y + HEAD_H / 2 - (lines.length - 1) * 8 + 5;
    lines.forEach((ln, k) =>
      T.push(
        `<text x="${x + COL_W / 2}" y="${ly + k * 16}" font-size="14" font-weight="700" fill="#1f2328" text-anchor="middle">${esc(ln)}</text>`,
      ),
    );
  });
  y += HEAD_H;
  sec.rows.forEach((row, ri) => {
    T.push(
      `<rect x="${PAD}" y="${y}" width="${LABEL_W}" height="${ROW_H}" fill="#ffffff" stroke="#d0d7de"/>`,
    );
    T.push(
      `<text x="${PAD + 12}" y="${y + ROW_H / 2 + 5}" font-size="14" fill="#1f2328">${esc(row[0])}</text>`,
    );
    sec.cols.forEach((col, ci) => {
      const x = gridX + ci * COL_W;
      const v = row[1][col.k];
      const cell = (bg, ink, main, sub, stroke = "#ffffff") => {
        T.push(
          `<rect x="${x}" y="${y}" width="${COL_W}" height="${ROW_H}" fill="${bg}" stroke="${stroke}"/>`,
        );
        T.push(
          `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 - 4}" font-size="16" font-weight="700" fill="${ink}" text-anchor="middle">${esc(main)}</text>`,
        );
        if (sub)
          T.push(
            `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 + 16}" font-size="12" font-weight="600" fill="${ink}" text-anchor="middle">${esc(sub)}</text>`,
          );
      };
      if (v == null) {
        T.push(
          `<rect x="${x}" y="${y}" width="${COL_W}" height="${ROW_H}" fill="#f6f8fa" stroke="#d0d7de"/>`,
        );
        T.push(
          `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 + 5}" font-size="15" fill="#8c959f" text-anchor="middle">—</text>`,
        );
      } else if (v.ok) {
        cell(rgbCss(RAMP[0][1]), "#ffffff", v.label, "no panic");
      } else if (v.timeout) {
        // the headline the timeout deserves: the ≥× computed from the run's REAL
        // ceiling against the row's measured best — never green. With no measured
        // competitor in the row, the floor itself is the headline.
        const mult = cellMult(sec, ri, ci);
        const rgb = RAMP[RAMP.length - 1][1];
        cell(
          rgbCss(rgb),
          inkFor(rgb),
          mult == null ? `${v.label} ≥${fmtS(v.floorMs)}` : `≥${fmtMult(mult)} slower`,
          mult == null ? "hit its ceiling" : `${v.label} ≥${fmtS(v.floorMs)}`,
        );
      } else {
        // the × multiplier IS the headline for every non-fastest cell; the absolute
        // time is the sub-line (the fastest cell keeps its time as the headline)
        const mult = cellMult(sec, ri, ci);
        const rgb = rampRGB(mult);
        const fastest = mult <= 1.0001;
        cell(
          rgbCss(rgb),
          inkFor(rgb),
          fastest ? fmtS(v) : fmtMult(mult) + " slower",
          fastest ? "fastest" : fmtS(v),
        );
      }
    });
    y += ROW_H;
  });
  y += 16;
  T.push(
    `<text x="${PAD}" y="${y}" font-size="11" fill="#57606a">${esc("Source: " + sec.source)}</text>`,
  );
  if (sec.note) {
    const noteChars = Math.floor((W - PAD * 2) / 5.6);
    const lines = [];
    let line = "";
    for (const word of sec.note.split(" ")) {
      if (line && line.length + 1 + word.length > noteChars) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    for (const ln of lines) {
      y += 15;
      T.push(`<text x="${PAD}" y="${y}" font-size="11" fill="#57606a">${esc(ln)}</text>`);
    }
  }
  y += 30;
}

const H = y + 8;
const out = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">`,
  `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
  `<text x="${PAD}" y="40" font-size="22" font-weight="700" fill="#1f2328">Type checkers at scale — 10k to 1,000,000 modules</text>`,
  `<text x="${PAD}" y="62" font-size="13" fill="#57606a">Fastest cell in each row green; others show how many times slower. A run that hit its ceiling shows that real timeout as a floor (≥).</text>`,
  `<text x="${PAD}" y="80" font-size="13" fill="#57606a">${esc(`tsgo ${TS.versions.tsgo} · tsc ${TS.versions.typescript} (64GB heap) · flow-bin ${TS.versions.flow} · ${TS.cores}-core host. Every number traces to the cited bench JSON.`)}</text>`,
  ...T,
  `</svg>`,
];

mkdirSync("bench/charts", { recursive: true });
const p = join("bench/charts", "checker-scale.svg");
writeFileSync(p, out.join("\n") + "\n");
console.log(
  `wrote ${p} — ${SECTIONS.length} sections, ${SECTIONS.reduce((n, s) => n + s.rows.length, 0)} scenario rows`,
);

// Rasterize the PNG in the same step (same contract as comparison-chart.mjs): regenerating
// the chart regenerates both, so the committed raster can never drift from the gated SVG.
const png = join("bench/charts", "checker-scale.png");
const conv = spawnSync(
  "convert",
  ["-density", "300", "-background", "white", p, "-flatten", "-depth", "8", png],
  { encoding: "utf8" },
);
if (conv.error || conv.status !== 0)
  console.warn(
    `! PNG NOT rasterized: ImageMagick \`convert\` ${conv.error ? "not found" : `exited ${conv.status}`}. ` +
      `The SVG is updated but ${png} may now be STALE — install ImageMagick and re-run before committing.`,
  );
else if (!existsSync(png) || statSync(png).size === 0)
  console.warn(
    `! \`convert\` exited 0 but ${png} is missing/empty — it may be STALE; re-run to refresh.`,
  );
else console.log(`wrote ${png} — 300 DPI raster of the SVG`);

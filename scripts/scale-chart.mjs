#!/usr/bin/env node
// Render the million-module checker story as a stacked heat chart, in the same visual
// system as tool-comparison.svg: per row the FASTEST cell is green and the rest show how
// many times slower (× N); near-ties show their +%. Cell states beyond numbers: "—"
// with its reason (anchor cutoff), a TIMEOUT cell — a request that outran its budget
// renders at that REAL ceiling as a floor ("timed out ≥2m") — and a CRASH cell, which
// shows status only (a wedge is not a measurement). Deterministic from the cited bench/*.json (no hand
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
      { k: "tsgo", label: "tsgo" },
      { k: "tsc", label: "tsc" },
      { k: "flow", label: "Flow" },
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
      { k: "tsgo", label: "tsgo\n(1M modules)" },
      { k: "tsc", label: "tsc\n(100k modules)" },
      { k: "flow", label: "Flow\n(1M modules)" },
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
    note: "Not a like-for-like race: tsgo returns the full exported-symbol space (31,058 items at 10k; 301,058 at 100k) where tsserver returns a bounded 1,067-entry set — the × numbers price the responses a user actually waits for, with the set-size caveat. From 250k up tsgo exceeds its 120s request ceiling; tsserver is anchor-cut there.",
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
let y = 140; // below the title block + legend band
// legend band: the ramp anchors as swatches + the special states — the chart's
// color language, readable without the docs
const LEGEND_Y = 102;
const legendItems = [
  { c: rgbCss(rampRGB(1)), t: "fastest" },
  { c: rgbCss(rampRGB(2)), t: "×2 slower" },
  { c: rgbCss(rampRGB(10)), t: "×10" },
  { c: rgbCss(rampRGB(100)), t: "×100+" },
  { c: "#f6f8fa", t: "— not measured", stroke: "#d0d7de" },
  { c: rgbCss(RAMP[RAMP.length - 1][1]), t: "timed out ≥ceiling / crash = status only" },
];
{
  let lx = PAD;
  for (const it of legendItems) {
    T.push(
      `<rect x="${lx}" y="${LEGEND_Y - 10}" width="14" height="14" rx="3" fill="${it.c}"${it.stroke ? ` stroke="${it.stroke}"` : ""}/>`,
    );
    lx += 19;
    T.push(`<text x="${lx}" y="${LEGEND_Y + 1}" font-size="11" fill="#57606a">${esc(it.t)}</text>`);
    lx += it.t.length * 5.6 + 16;
  }
  T.push(
    `<text x="${lx + 8}" y="${LEGEND_Y + 1}" font-size="11" fill="#57606a">cell: ×N slower (big) · its time (small)</text>`,
  );
}

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
      if (v == null || v.na) {
        T.push(
          `<rect x="${x}" y="${y}" width="${COL_W}" height="${ROW_H}" fill="#f6f8fa" stroke="#d0d7de"/>`,
        );
        T.push(
          `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 + (v && v.why ? -2 : 5)}" font-size="15" fill="#8c959f" text-anchor="middle">—</text>`,
        );
        if (v && v.why)
          T.push(
            `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 + 16}" font-size="10" fill="#8c959f" text-anchor="middle">${esc(v.why)}</text>`,
          );
      } else if (v.crash) {
        // a crash is a status, not a measurement: no time, no multiplier
        const rgb = RAMP[RAMP.length - 1][1];
        cell(rgbCss(rgb), inkFor(rgb), v.label, v.sub || "");
      } else if (v.green !== undefined && v.red !== undefined) {
        // delta cell: the red-gate premium as a percentage, times as the sub-line
        const pct = ((v.red - v.green) / v.green) * 100;
        const rgb = Math.abs(pct) < 5 ? RAMP[0][1] : rampRGB(1 + Math.abs(pct) / 100);
        cell(
          rgbCss(rgb),
          inkFor(rgb),
          `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
          `${fmtS(v.red)} red vs ${fmtS(v.green)} green`,
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
        // time is the sub-line. Near-ties are not "×1.0 slower" — within 5% of the
        // fastest the time stays the headline with the honest +N% as the sub-line.
        const mult = cellMult(sec, ri, ci);
        const rgb = rampRGB(mult);
        const fastest = mult <= 1.0001;
        const nearTie = !fastest && mult < 1.05;
        cell(
          rgbCss(rgb),
          inkFor(rgb),
          fastest || nearTie ? fmtS(v) : fmtMult(mult) + " slower",
          fastest ? "fastest" : nearTie ? `+${((mult - 1) * 100).toFixed(0)}% vs fastest` : fmtS(v),
        );
      }
    });
    y += ROW_H;
  });
  y += 16;
  {
    // clickable source links (relative hrefs — resolve from bench/charts/ wherever the
    // SVG is served; GitHub's README <img> strips interactivity, the Raw view keeps it)
    const parts = sec.source.split(", ");
    let sx = PAD;
    T.push(`<text x="${sx}" y="${y}" font-size="11" fill="#57606a">Source: </text>`);
    sx += 46;
    parts.forEach((p, i) => {
      const label = p + (i < parts.length - 1 ? "," : "");
      T.push(
        `<a href="${esc("../../" + p)}"><text x="${sx}" y="${y}" font-size="11" fill="#57606a" text-decoration="underline">${esc(label)}</text></a>`,
      );
      sx += label.length * 5.6 + 6;
    });
  }
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
  `<text x="${PAD}" y="62" font-size="13" fill="#57606a">Fastest cell in each row green; near-ties show their +%; others show how many times slower. A request that outran its budget shows that real ceiling as a floor (≥); a crash shows status, never a number.</text>`,
  `<text x="${PAD}" y="80" font-size="13" fill="#57606a">${esc(`tsgo ${TS.versions.tsgo} · tsc ${TS.versions.typescript} (64GB heap) · flow ${(String(TS.versions.flow).match(/flow main @ [0-9a-f]+/) || ["main build"])[0].replace("flow main", "main")} (wedge fixes in) · ${TS.cores}-core host. Every number traces to the cited bench JSON.`)}</text>`,
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

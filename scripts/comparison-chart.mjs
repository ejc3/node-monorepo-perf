#!/usr/bin/env node
// Render a model-comparison-style heatmap of the repo's like-for-like tool head-to-heads, in stacked
// sections so each comparison keeps COMPATIBLE columns: Install (bun vs pnpm isolated vs hoisted),
// Typecheck (tsc vs tsgo), Build (Next vs Vite), and pnpm install-situations (compared down the column).
// Per cell the FASTEST is green and the rest show how many times slower (x N). Deterministic from the
// cited bench/*.json (no hand numbers) -> bench/charts/tool-comparison.svg.
//
//   node scripts/comparison-chart.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const IB = read("bench/install-bench.json");
const TB = read("bench/typecheck-bench.json");
const PAR = read("bench/typecheck-parity-bench.json");
const BB = read("bench/build-bench.json");
const IM = read("bench/install-modes-bench.json");
const LB = read("bench/lint-bench.json");
const byScale = Object.fromEntries(IB.scales.map((s) => [`${s.apps}x${s.libs}`, s]));
const inst = (scale, tool, regime) => byScale[scale][tool][regime];

// compareAxis "row" = fastest across the columns in a row (tool head-to-head). "col" = cheapest down a
// column (situations within one tool). Either way a cell's number is its multiple of that best.
const SECTIONS = [
  {
    title: "Install the workspace — bun vs pnpm",
    compareAxis: "row",
    cols: [
      { k: "bun", label: "bun" },
      { k: "iso", label: "pnpm\nisolated" },
      { k: "hoist", label: "pnpm\nhoisted" },
    ],
    rows: [
      [
        "Cold · 200 apps",
        {
          bun: inst("200x100", "bun", "coldMs"),
          iso: inst("200x100", "pnpmIsolated", "coldMs"),
          hoist: inst("200x100", "pnpmHoisted", "coldMs"),
        },
      ],
      [
        "Cold · 1,000 apps",
        {
          bun: inst("1000x200", "bun", "coldMs"),
          iso: inst("1000x200", "pnpmIsolated", "coldMs"),
          hoist: inst("1000x200", "pnpmHoisted", "coldMs"),
        },
      ],
      [
        "Cold · 2,000 apps",
        {
          bun: inst("2000x300", "bun", "coldMs"),
          iso: inst("2000x300", "pnpmIsolated", "coldMs"),
          hoist: inst("2000x300", "pnpmHoisted", "coldMs"),
        },
      ],
      [
        "Warm · 200 apps",
        {
          bun: inst("200x100", "bun", "warmMs"),
          iso: inst("200x100", "pnpmIsolated", "warmMs"),
          hoist: inst("200x100", "pnpmHoisted", "warmMs"),
        },
      ],
      [
        "Warm · 1,000 apps",
        {
          bun: inst("1000x200", "bun", "warmMs"),
          iso: inst("1000x200", "pnpmIsolated", "warmMs"),
          hoist: inst("1000x200", "pnpmHoisted", "warmMs"),
        },
      ],
      [
        "Warm · 2,000 apps",
        {
          bun: inst("2000x300", "bun", "warmMs"),
          iso: inst("2000x300", "pnpmIsolated", "warmMs"),
          hoist: inst("2000x300", "pnpmHoisted", "warmMs"),
        },
      ],
      [
        "Fresh container · 200 apps",
        { bun: IB.trulyCold.bunMs, iso: null, hoist: IB.trulyCold.pnpmHoistedMs },
      ],
    ],
    source: "bench/install-bench.json",
    note: "Cold = no committed lockfile (full resolve); warm = lockfile present, relink only; both warm-store. Fresh container = cold store too — network-bound, a single sample, not directly comparable to the warm-store rows.",
  },
  {
    title: "Typecheck — tsc vs tsgo",
    compareAxis: "row",
    cols: [
      { k: "tsc", label: "tsc" },
      { k: "tsgo", label: "tsgo" },
    ],
    rows: [
      [
        `${TB.modules.toLocaleString("en-US")}-module program`,
        { tsc: TB.tsc.medianMs, tsgo: TB.tsgo.medianMs },
      ],
      [
        "4,000:400 type-heavy whole-program",
        { tsc: PAR.cleanBaseline.tsc.ms, tsgo: PAR.cleanBaseline.tsgo.ms },
      ],
    ],
    source: "bench/typecheck-bench.json, bench/typecheck-parity-bench.json",
  },
  {
    title: "Production build — Next vs Vite",
    compareAxis: "row",
    cols: [
      { k: "next", label: "Next" },
      { k: "vite", label: "Vite" },
    ],
    rows: [[`${BB.apps} apps / ${BB.libs} libs`, { next: BB.next.ms, vite: BB.vite.ms }]],
    source: "bench/build-bench.json",
    note: "Different feature sets: Next App Router vs Vite SPA.",
  },
  {
    title: `pnpm install situations — ${IM.apps.toLocaleString("en-US")} apps`,
    compareAxis: "col",
    cols: [{ k: "pnpm", label: "pnpm" }],
    rows: [
      ["frozen install (warm store)", { pnpm: IM.frozenWarmMs }],
      ["frozen install (cold store)", { pnpm: IM.frozenColdStoreMs }],
      ["add one dependency", { pnpm: IM.depChangeAddOneMs }],
      ["catalog bump (shared dep)", { pnpm: IM.depChangeCatalogBumpMs }],
      ["cold resolve (no lockfile)", { pnpm: IM.coldResolveMs }],
    ],
    source: "bench/install-modes-bench.json",
    note: "One tool, many situations: cheapest in green, others relative to it.",
  },
  {
    title: `Lint — ESLint vs oxlint (${LB.corpus.files.toLocaleString("en-US")} files)`,
    compareAxis: "row",
    cols: [
      { k: "eslint", label: "ESLint" },
      { k: "oxlint", label: "oxlint" },
    ],
    rows: [
      [
        `syntactic (${LB.syntactic.eslintMatchedRuleCount} vs ${LB.syntactic.oxlintActiveRuleCount} rules)`,
        { eslint: LB.syntactic.eslint.noCacheMs, oxlint: LB.syntactic.oxlint.runMs },
      ],
      [
        "syntactic, ESLint --cache",
        { eslint: LB.syntactic.eslint.cacheMs, oxlint: LB.syntactic.oxlint.runMs },
      ],
      ["type-aware", { eslint: LB.typeAware.eslint.ms, oxlint: LB.typeAware.oxlint.ms }],
    ],
    source: "bench/lint-bench.json",
    note: "ESLint runs a strict subset of oxlint's covered rules (no more work) — conservative. Wall-clock on a 64-core box: oxlint is multithreaded, so the ratio scales with cores. The type-aware row is mostly tsgo-vs-tsc (oxlint via tsgolint, alpha).",
  },
];

// --- per-cell best/multiple ----------------------------------------------------------------------
const cellMult = (sec, ri, ci) => {
  const v = sec.rows[ri][1][sec.cols[ci].k];
  if (v == null) return null;
  const pool =
    sec.compareAxis === "col"
      ? sec.rows.map((r) => r[1][sec.cols[ci].k]).filter((x) => x != null)
      : sec.cols.map((c) => sec.rows[ri][1][c.k]).filter((x) => x != null);
  return v / Math.min(...pool);
};

// --- formatting ----------------------------------------------------------------------------------
const fmtS = (ms) => {
  const s = ms / 1000;
  return (s < 1 ? s.toFixed(2) : s.toFixed(1)) + "s";
};
const fmtMult = (m) => "×" + (m < 10 ? m.toFixed(1) : Math.round(m));

// Per-cell colour as a function of how many times slower the cell is than the fastest in its
// comparison. Anchored at specific MULTIPLES and interpolated in log-multiple space, so the same
// multiple is the same colour in every section (x2 and x440 read consistently). The green band is
// deliberately NARROW — by 2x slower a cell is already full amber, not a shade of green — so the drop
// off green is steep, then it ramps through orange to red.
const RAMP = [
  [1, [26, 127, 55]], // fastest — green
  [2, [214, 168, 28]], // 2x slower — amber/gold (clearly off green)
  [10, [198, 98, 28]], // ~10x — orange
  [100, [176, 42, 42]], // 100x+ — red (clamped)
];
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const rampRGB = (mult) => {
  if (mult <= 1.0001) return RAMP[0][1];
  const m = Math.min(mult, RAMP[RAMP.length - 1][0]); // clamp at the red anchor
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
// Near-black ink: on light/mid-tone cells its low luminance beats white; white wins on the dark cells.
const DARK_INK = [10, 13, 18];
const DARK_INK_L = relLum(DARK_INK);
// Pick whichever ink contrasts MORE with the cell, so a cell never gets the worse-legibility colour
// (a fixed luminance threshold picks dark ink on mid tones where white actually reads better). The
// orange→red mid-tone band (~15–20× slower) caps solid-ink contrast at ~4.4:1 against either ink —
// intrinsic to those hues — so a cell there can land just under WCAG AA 4.5 on the 11px sub-label; the
// bold 16px number clears large-text AA (3:1), and the cell colour itself also encodes the value.
const inkFor = (rgb) => {
  const L = relLum(rgb);
  return contrast(L, DARK_INK_L) >= contrast(L, 1) ? "#0a0d12" : "#ffffff";
};

// --- layout --------------------------------------------------------------------------------------
const LABEL_W = 290;
const COL_W = 162;
const ROW_H = 56;
const HEAD_H = 50;
const PAD = 28;
const MAXCOLS = Math.max(...SECTIONS.map((s) => s.cols.length));
const W = PAD * 2 + LABEL_W + COL_W * MAXCOLS;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const T = []; // body elements; height computed as we go
let y = 108; // below the three-line title block, with breathing room before the first section title

const gridX = PAD + LABEL_W;
for (const sec of SECTIONS) {
  // Section title.
  T.push(
    `<text x="${PAD}" y="${y}" font-size="16" font-weight="700" fill="#1f2328">${esc(sec.title)}</text>`,
  );
  y += 18;
  // Header row.
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
  // Data rows.
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
      if (v == null) {
        T.push(
          `<rect x="${x}" y="${y}" width="${COL_W}" height="${ROW_H}" fill="#f6f8fa" stroke="#d0d7de"/>`,
        );
        T.push(
          `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 + 5}" font-size="15" fill="#8c959f" text-anchor="middle">—</text>`,
        );
        return;
      }
      const mult = cellMult(sec, ri, ci);
      const rgb = rampRGB(mult);
      const ink = inkFor(rgb);
      T.push(
        `<rect x="${x}" y="${y}" width="${COL_W}" height="${ROW_H}" fill="${rgbCss(rgb)}" stroke="#ffffff"/>`,
      );
      T.push(
        `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 - 4}" font-size="16" font-weight="700" fill="${ink}" text-anchor="middle">${fmtS(v)}</text>`,
      );
      const sub = mult <= 1.0001 ? "fastest" : fmtMult(mult) + " slower";
      T.push(
        `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 + 15}" font-size="11" fill="${ink}" text-anchor="middle">${esc(sub)}</text>`,
      );
    });
    y += ROW_H;
  });
  // Section source, then any note on its own line (a full, accurate note can be long — keep it off the
  // source line so it never runs past the SVG width).
  y += 16;
  T.push(
    `<text x="${PAD}" y="${y}" font-size="11" fill="#57606a">${esc("Source: " + sec.source)}</text>`,
  );
  if (sec.note) {
    y += 15;
    T.push(`<text x="${PAD}" y="${y}" font-size="11" fill="#57606a">${esc(sec.note)}</text>`);
  }
  y += 30;
}

const H = y + 8;
const out = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">`,
  `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
  `<text x="${PAD}" y="40" font-size="22" font-weight="700" fill="#1f2328">Tooling head-to-head — wall time</text>`,
  `<text x="${PAD}" y="62" font-size="13" fill="#57606a">Each section compares like-for-like tools (or, last, one tool's situations). Fastest cell green; others show how many times slower.</text>`,
  `<text x="${PAD}" y="80" font-size="13" fill="#57606a">${esc(`Machine: ${PAR.cores}-core host. Every number traces to the cited bench JSON.`)}</text>`,
  ...T,
  `</svg>`,
];

mkdirSync("bench/charts", { recursive: true });
const p = join("bench/charts", "tool-comparison.svg");
writeFileSync(p, out.join("\n") + "\n");
console.log(
  `wrote ${p} — ${SECTIONS.length} sections, ${SECTIONS.reduce((n, s) => n + s.rows.length, 0)} scenario rows`,
);

// Rasterize a high-resolution PNG in the SAME step that writes the SVG, so the committed PNG
// (linked from the README) can never drift from the SVG: regenerating the chart regenerates both.
// Skip with a warning if ImageMagick's `convert` isn't installed — a local run without it still
// produces the SVG, and CI installs ImageMagick so the PNG is always refreshed there.
const png = join("bench/charts", "tool-comparison.png");
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
  // convert reported success but produced nothing usable — don't let a silent miss leave a stale PNG.
  console.warn(
    `! \`convert\` exited 0 but ${png} is missing/empty — it may be STALE; re-run to refresh.`,
  );
else console.log(`wrote ${png} — 300 DPI raster of the SVG`);

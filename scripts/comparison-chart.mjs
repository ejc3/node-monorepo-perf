#!/usr/bin/env node
// Render a model-comparison-style heatmap of the repo's like-for-like tool head-to-heads, in stacked
// sections so each comparison keeps COMPATIBLE columns: Install (bun vs pnpm isolated/hoisted vs
// yarn node-modules/PnP), Typecheck (tsc vs tsgo), Build (Next vs Vite), and pnpm install-situations
// (compared down the column).
// Per cell the FASTEST is green and the rest show how many times slower (x N). Deterministic from the
// cited bench/*.json (no hand numbers) -> bench/charts/tool-comparison.svg.
//
//   node scripts/comparison-chart.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const IB = read("bench/install-bench.json");
const CI = read("bench/container-install-bench.json");
const TB = read("bench/typecheck-bench.json");
const PAR = read("bench/typecheck-parity-bench.json");
const BB = read("bench/build-bench.json");
const IM = read("bench/install-modes-bench.json");
const LB = read("bench/lint-bench.json");
const byScale = Object.fromEntries(IB.scales.map((s) => [`${s.apps}x${s.libs}`, s]));
const inst = (scale, tool, state) => byScale[scale][tool][state];
// trulyCold is read by direct property access below — unlike the per-scale tools, where
// a missing key fails loud inside inst() — and the cell renderer draws null/undefined as
// the same "—" used for intentionally-unmeasured cells. Assert the measured fields exist
// so a stale or partial dataset can't render a missing measurement as "not applicable".
for (const k of ["pnpmHoistedMs", "bunMs", "yarnNmMs", "yarnPnpMs"])
  if (typeof IB.trulyCold?.[k] !== "number")
    throw new Error(
      `bench/install-bench.json trulyCold.${k} is missing — re-run install-bench before charting`,
    );
// same protection for the container bench's cells
for (const t of ["pnpm", "bun", "yarnNm", "yarnPnp", "npm"])
  for (const v of ["freshRunner", "cacheRestored"])
    if (typeof CI.tools?.[t]?.[v]?.medianMs !== "number")
      throw new Error(
        `bench/container-install-bench.json tools.${t}.${v}.medianMs is missing — re-run container-install-bench before charting`,
      );

// Install section columns: k = cell key, tool = the bench/install-bench.json key. The six
// cold/warm rows are a pure states x scales cross-product over these five tools, so they
// are generated — a new tool or scale is one edit, and no hand-copied row can carry a
// stale key that renders a plausible wrong number.
const INSTALL_COLS = [
  { k: "bun", label: "bun", tool: "bun" },
  { k: "iso", label: "pnpm\nisolated", tool: "pnpmIsolated" },
  { k: "hoist", label: "pnpm\nhoisted", tool: "pnpmHoisted" },
  { k: "ynm", label: "yarn\nnode-modules", tool: "yarnNm" },
  { k: "ypnp", label: "yarn\nPnP", tool: "yarnPnp" },
];
const INSTALL_SCALES = [
  ["200x100", "200 apps"],
  ["1000x200", "1,000 apps"],
  ["2000x300", "2,000 apps"],
];

// compareAxis "row" = fastest across the columns in a row (tool head-to-head). "col" = cheapest down a
// column (situations within one tool). Either way a cell's number is its multiple of that best.
const SECTIONS = [
  {
    title: "Install the workspace — bun vs pnpm vs yarn",
    compareAxis: "row",
    cols: INSTALL_COLS,
    rows: [
      ...[
        ["coldMs", "Cold"],
        ["warmMs", "Warm"],
      ].flatMap(([state, rLabel]) =>
        INSTALL_SCALES.map(([scale, sLabel]) => [
          `${rLabel} · ${sLabel} · ${byScale[scale].depEdgesVerified.toLocaleString("en-US")} dep edges`,
          Object.fromEntries(
            INSTALL_COLS.map((c) => [
              c.k,
              {
                ms: inst(scale, c.tool, state),
                detail:
                  c.tool === "yarnPnp"
                    ? `${byScale[scale][c.tool].nmEntries} entries + ${(byScale[scale][c.tool].pnpCjsBytes / 1e6).toFixed(1)}MB table`
                    : `${(byScale[scale][c.tool].nmEntries / 1000).toFixed(1)}k nm entries`,
              },
            ]),
          ),
        ]),
      ),
      [
        // scale derived from the JSON, not hand-typed — a re-run at a different first
        // scale must change this label, not silently keep "200 apps" over new numbers.
        // "Cold store + no lockfile", not "fresh container": the pass deletes the
        // lockfile, and a real fresh container/CI checkout keeps the committed one.
        `Cold store + no lockfile · ${IB.trulyCold.apps.toLocaleString("en-US")} apps`,
        {
          bun: IB.trulyCold.bunMs,
          iso: null,
          hoist: IB.trulyCold.pnpmHoistedMs,
          ynm: IB.trulyCold.yarnNmMs,
          ypnp: IB.trulyCold.yarnPnpMs,
        },
      ],
    ],
    source: "bench/install-bench.json",
    note: "Row label = resolved dependency edges (what the install pulls in, verified post-install); each cell's third line = what that tool MATERIALIZES for the same install — the layout skew: node_modules trees differ per linker, and yarn PnP writes a 64-entry dir plus a resolution table instead of a tree. Cold = no committed lockfile (full resolve); warm = lockfile present, relink only; both warm-store. yarn PnP writes no node_modules (a .pnp.cjs table over cache zips). Cold store + no lockfile = each tool's store and metadata redirected to a fresh dir, real network — single samples, not directly comparable to the warm-store rows. “—” = not measured (pnpm-isolated cold is within ~3% of hoisted).",
  },
  {
    title: `CI-runner install — frozen from the committed lockfile (${CI.scale.apps.toLocaleString("en-US")} apps, fresh podman container per sample)`,
    compareAxis: "row",
    cols: [
      { k: "bun", label: "bun" },
      { k: "pnpm", label: "pnpm" },
      { k: "ynm", label: "yarn\nnode-modules" },
      { k: "ypnp", label: "yarn\nPnP" },
      { k: "npm", label: "npm" },
    ],
    rows: [
      [
        "Fresh runner (empty caches, network)",
        {
          bun: CI.tools.bun.freshRunner.medianMs,
          pnpm: CI.tools.pnpm.freshRunner.medianMs,
          ynm: CI.tools.yarnNm.freshRunner.medianMs,
          ypnp: CI.tools.yarnPnp.freshRunner.medianMs,
          npm: CI.tools.npm.freshRunner.medianMs,
        },
      ],
      [
        "Cache restored",
        {
          bun: CI.tools.bun.cacheRestored.medianMs,
          pnpm: CI.tools.pnpm.cacheRestored.medianMs,
          ynm: CI.tools.yarnNm.cacheRestored.medianMs,
          ypnp: CI.tools.yarnPnp.cacheRestored.medianMs,
          npm: CI.tools.npm.cacheRestored.medianMs,
        },
      ],
    ],
    source: "bench/container-install-bench.json",
    note: `Same workspace shape as the 1,000-apps install rows above (${CI.depEdgesVerified.toLocaleString("en-US")} dep edges verified per install). Committed lockfile + frozen install (pnpm/bun --frozen-lockfile, yarn --immutable, npm ci) — what a real CI runner actually pays; medians of 5 rotated samples, each in a fresh hermetic container. All five fail closed on lockfile drift (measured). pnpm here is its default isolated linker.`,
  },
  {
    title: "Typecheck — tsgo vs tsc",
    compareAxis: "row",
    cols: [
      { k: "tsgo", label: "tsgo" },
      { k: "tsc", label: "tsc" },
    ],
    rows: [
      [
        `${TB.modules.toLocaleString("en-US")}-module program`,
        { tsc: TB.tsc.medianMs, tsgo: TB.tsgo.medianMs },
      ],
      [
        `type-heavy program, 4,000:400 (${(PAR.libs * PAR.modulesPerLib).toLocaleString("en-US")} lib modules)`,
        { tsc: PAR.cleanBaseline.tsc.ms, tsgo: PAR.cleanBaseline.tsgo.ms },
      ],
    ],
    source: "bench/typecheck-bench.json, bench/typecheck-parity-bench.json",
  },
  {
    title: "Production build — Vite vs Next",
    compareAxis: "row",
    cols: [
      { k: "vite", label: "Vite" },
      { k: "next", label: "Next" },
    ],
    rows: [[`${BB.apps} apps / ${BB.libs} libs`, { next: BB.next.ms, vite: BB.vite.ms }]],
    source: "bench/build-bench.json",
    note: "Different feature sets: Next App Router vs Vite SPA.",
  },
  {
    title: `pnpm install situations — ${IM.apps.toLocaleString("en-US")} apps, ${IM.lockfileLines.toLocaleString("en-US")}-line lockfile`,
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
    title: `Lint — oxlint vs ESLint (${LB.corpus.files.toLocaleString("en-US")} files)`,
    compareAxis: "row",
    cols: [
      { k: "oxlint", label: "oxlint" },
      { k: "eslint", label: "ESLint" },
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
const msOf = (x) => (x && typeof x === "object" ? x.ms : x); // cells may be {ms, detail}
const cellMult = (sec, ri, ci) => {
  const v = msOf(sec.rows[ri][1][sec.cols[ci].k]);
  if (v == null) return null;
  const pool = (
    sec.compareAxis === "col"
      ? sec.rows.map((r) => msOf(r[1][sec.cols[ci].k]))
      : sec.cols.map((c) => msOf(sec.rows[ri][1][c.k]))
  ).filter((x) => x != null);
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
      const raw = row[1][col.k];
      const v = raw && typeof raw === "object" ? raw.ms : raw;
      const detail = raw && typeof raw === "object" ? raw.detail : null;
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
      // the × multiplier IS the headline for every non-fastest cell; the absolute
      // time is the sub-line. Near-ties are not "×1.0 slower" — within 5% of the
      // fastest the time stays the headline with the honest +N% as the sub-line.
      const fastest = mult <= 1.0001;
      const nearTie = !fastest && mult < 1.05;
      const main = fastest || nearTie ? fmtS(v) : fmtMult(mult) + " slower";
      const sub = fastest
        ? "fastest"
        : nearTie
          ? `+${((mult - 1) * 100).toFixed(0)}% vs fastest`
          : fmtS(v);
      T.push(
        `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 - 4}" font-size="16" font-weight="700" fill="${ink}" text-anchor="middle">${esc(main)}</text>`,
      );
      T.push(
        `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 + (detail ? 10 : 16)}" font-size="13" font-weight="600" fill="${ink}" text-anchor="middle">${esc(sub)}</text>`,
      );
      if (detail)
        T.push(
          `<text x="${x + COL_W / 2}" y="${y + ROW_H / 2 + 23}" font-size="10" fill="${ink}" opacity="0.85" text-anchor="middle">${esc(detail)}</text>`,
        );
    });
    y += ROW_H;
  });
  // Section source, then any note word-wrapped to the drawable width (11px sans averages
  // ~5.6px/char) — a full, accurate note can be long, and an unwrapped <text> line runs
  // past the SVG edge and renders clipped in browsers and in the rasterized PNG.
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
  `<text x="${PAD}" y="40" font-size="22" font-weight="700" fill="#1f2328">Tooling head-to-head — wall time</text>`,
  `<text x="${PAD}" y="62" font-size="13" fill="#57606a">Each section compares like-for-like tools (or one tool's situations), columns in the SAME order everywhere: the typically-fastest tool leftmost. Fastest cell green; others show how many times slower.</text>`,
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

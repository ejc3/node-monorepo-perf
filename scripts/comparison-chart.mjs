#!/usr/bin/env node
// Render a model-comparison-style heatmap of the repo's like-for-like tool head-to-heads, in stacked
// sections so each comparison keeps COMPATIBLE columns: Install (bun vs pnpm 12 isolated/hoisted vs
// yarn 4 node-modules/PnP), the CI-runner frozen install, pnpm 12 (Rust) vs pnpm 10 (JS), Typecheck
// (tsgo vs tsc), Build (Vite vs Next), pnpm install-situations (compared down the column), and Lint.
// Per cell the FASTEST is green and the rest show how many times slower (×N). Drawn with the shared
// visual system (scripts/_chartstyle.mjs): system-ui type, rounded tinted section frames, stable
// tool-color chips, dark-mode support, per-section provenance. Deterministic from the cited
// bench/*.json (no hand numbers) -> bench/charts/tool-comparison.svg (+ 300 DPI PNG in one step).
//
//   node scripts/comparison-chart.mjs

import { readFileSync } from "node:fs";
import {
  INK,
  MUTED,
  ACCENT,
  txt,
  svgDoc,
  sectionFrame,
  rampRGB,
  rgbCss,
  inkFor,
  fmtMult,
  nearTiePct,
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
const IB = read("bench/install-bench.json");
const CI = read("bench/container-install-bench.json");
const PN = read("bench/pnpm12-bench.json");
const TB = read("bench/typecheck-bench.json");
const PAR = read("bench/typecheck-parity-bench.json");
const BB = read("bench/build-bench.json");
const IM = read("bench/install-modes-bench.json");
const LB = read("bench/lint-bench.json");
const byScale = Object.fromEntries(IB.scales.map((s) => [`${s.apps}x${s.libs}`, s]));
const inst = (scale, tool, state) => byScale[scale][tool][state];
// deep accessor for the pnpm12 dataset: the section must fail the build, not
// render a plausible cell, if the JSON's shape changes
const need = (o, path, file) => {
  let v = o;
  for (const k of path.split(".")) {
    v = v?.[k];
    if (v == null) throw new Error(`missing field ${path} in ${file}`);
  }
  return v;
};
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
// the version-scoped labels below must trace to each dataset's recorded versions
// (the install family was re-measured under the pnpm 12 Rust CLI in PR #54, and
// install-bench now records its pnpm/bun versions itself)
if (!String(IB.yarnVersion).startsWith("4."))
  throw new Error(`install-bench yarnVersion ${IB.yarnVersion} no longer backs the "yarn 4" label`);
if (!String(IB.pnpmVersion).startsWith("12."))
  throw new Error(
    `install-bench pnpmVersion ${IB.pnpmVersion} no longer backs the "pnpm 12" label`,
  );
if (!String(CI.versions.pnpm).startsWith("12."))
  throw new Error(`container-install pnpm ${CI.versions.pnpm} no longer backs the "pnpm 12" label`);
if (!String(need(PN, "versions.pnpm10", "pnpm12-bench")).startsWith("10."))
  throw new Error(`pnpm12-bench versions.pnpm10 no longer backs the "pnpm 10" label`);
if (!String(need(PN, "versions.pnpm12", "pnpm12-bench")).startsWith("12."))
  throw new Error(`pnpm12-bench versions.pnpm12 no longer backs the "pnpm 12" label`);
if (!String(IM.pnpm).startsWith("12."))
  throw new Error(`install-modes pnpm ${IM.pnpm} no longer backs the "pnpm 12" label`);
// numeric accessor for the pnpm12 dataset: presence is not enough — a timing
// reshaped into an object (or a count into a string) must throw, not render as
// a plausible cell or a "—"
const pnNum = (path) => {
  const v = need(PN, path, "bench/pnpm12-bench.json");
  if (typeof v !== "number") throw new Error(`bench/pnpm12-bench.json ${path} is not a number`);
  return v;
};
// the three pnpm12 legs must have locked the identical package set (the bench's
// own equivalence gate, re-asserted here across every count the note cites —
// dep edges, locked packages, importers — so a reshaped record can't chart
// apples against oranges)
for (const k of ["depEdgesVerified", "lockPackages", "importers"]) {
  const vals = ["pnpm10", "pnpm12", "tip"].map((l) => pnNum(`rows.${l}.${k}`));
  if (new Set(vals).size !== 1)
    throw new Error(`pnpm12-bench legs disagree on ${k} — not the identical package set`);
}
// the note's sample-count claims must hold: every timed row carries exactly
// PN.samples samples, and truly cold is the single recorded sample
const pnSamples = pnNum("samples");
for (const leg of ["pnpm10", "pnpm12", "tip"]) {
  for (const row of ["coldResolve", "warm", "frozen"]) {
    const s = need(PN, `rows.${leg}.${row}.samplesMs`, "bench/pnpm12-bench.json");
    if (!Array.isArray(s) || s.length !== pnSamples)
      throw new Error(`pnpm12-bench rows.${leg}.${row}.samplesMs is not ${pnSamples} samples`);
  }
  if (pnNum(`rows.${leg}.trulyCold.samples`) !== 1)
    throw new Error(`pnpm12-bench rows.${leg}.trulyCold is not the single-sample record`);
}
const pnRow = (leg, row) => pnNum(`rows.${leg}.${row}.medianMs`);
const pnTipShort = String(need(PN, "versions.tip", "pnpm12-bench")).split(" ")[0];

// Install section columns: k = cell key, tool = the bench/install-bench.json key, chip = the
// stable tool identity color. The six cold/warm rows are a pure states x scales cross-product
// over these five tools, so they are generated — a new tool or scale is one edit, and no
// hand-copied row can carry a stale key that renders a plausible wrong number.
const INSTALL_COLS = [
  { k: "bun", label: "bun", tool: "bun", chip: "bun" },
  { k: "iso", label: "pnpm 12\nisolated", tool: "pnpmIsolated", chip: "pnpm" },
  { k: "hoist", label: "pnpm 12\nhoisted", tool: "pnpmHoisted", chip: "pnpm" },
  { k: "ynm", label: "yarn 4\nnode-modules", tool: "yarnNm", chip: "yarn" },
  {
    k: "ypnp",
    label: "yarn 4\nPnP",
    sub: "no nm tree — zip cache + table",
    tool: "yarnPnp",
    chip: "yarn",
  },
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
    title: "Install the workspace — bun vs pnpm 12 vs yarn 4",
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
    note: `Row label = resolved dependency edges (what the install pulls in, verified post-install); each cell's third line = what that tool MATERIALIZES for the same install — the layout skew: node_modules trees differ per linker, and yarn PnP writes a 64-entry dir plus a resolution table instead of a tree. Cold = no committed lockfile (full resolve); warm = lockfile present, relink only; both warm-store. yarn PnP writes no node_modules (a .pnp.cjs table over cache zips). Cold store + no lockfile = each tool's store and metadata redirected to a fresh dir, real network — single samples, not directly comparable to the warm-store rows. “—” = not measured (only pnpm-hoisted was measured in this truly-cold pass; pnpm-isolated was not). Versions per the JSON: pnpm ${IB.pnpmVersion} (the Rust CLI) · bun ${IB.bunVersion} · yarn ${IB.yarnVersion}; the pnpm 12-vs-10 rewrite head-to-head is its own section below.`,
  },
  {
    title: `CI-runner install — frozen from the committed lockfile (${CI.scale.apps.toLocaleString("en-US")} apps, fresh podman container per sample)`,
    compareAxis: "row",
    cols: [
      { k: "bun", label: "bun", chip: "bun" },
      { k: "pnpm", label: "pnpm 12", chip: "pnpm" },
      { k: "ynm", label: "yarn 4\nnode-modules", chip: "yarn" },
      { k: "ypnp", label: "yarn 4\nPnP", sub: "no nm tree — zip cache + table", chip: "yarn" },
      { k: "npm", label: "npm", chip: "npm" },
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
    note: `Same workspace shape as the 1,000-apps install rows above (${CI.depEdgesVerified.toLocaleString("en-US")} dep edges verified per install). Committed lockfile + frozen install (pnpm/bun --frozen-lockfile, yarn --immutable, npm ci) — what a real CI runner actually pays; medians of 5 rotated samples, each in a fresh hermetic container. All five fail closed on lockfile drift (measured). pnpm here is its default isolated linker. Versions per the JSON: pnpm ${CI.versions.pnpm} · bun ${CI.versions.bun} · yarn ${CI.versions.yarn}.`,
  },
  {
    title: `pnpm 12 (the Rust CLI) vs pnpm 10 (JS) — ${pnNum("scale.apps").toLocaleString("en-US")} apps / ${pnNum("scale.libs")} libs`,
    compareAxis: "row",
    cols: [
      {
        k: "p12",
        label: "pnpm 12",
        sub: `Rust · ${need(PN, "versions.pnpm12", "pnpm12-bench")}`,
        chip: "pnpm",
      },
      { k: "tip", label: "tip of main", sub: `Rust · ${pnTipShort}`, chip: "pnpm" },
      {
        k: "p10",
        label: "pnpm 10",
        sub: `JS · ${need(PN, "versions.pnpm10", "pnpm12-bench")}`,
        chip: "pnpm",
      },
    ],
    rows: [
      [
        "cold resolve (no lockfile, warm store)",
        {
          p10: pnRow("pnpm10", "coldResolve"),
          p12: pnRow("pnpm12", "coldResolve"),
          tip: pnRow("tip", "coldResolve"),
        },
      ],
      [
        "warm rebuild (lockfile + store, no node_modules)",
        { p10: pnRow("pnpm10", "warm"), p12: pnRow("pnpm12", "warm"), tip: pnRow("tip", "warm") },
      ],
      [
        "frozen (--frozen-lockfile — the CI row)",
        {
          p10: pnRow("pnpm10", "frozen"),
          p12: pnRow("pnpm12", "frozen"),
          tip: pnRow("tip", "frozen"),
        },
      ],
      [
        "truly cold (fresh store + cache, network; frozen)",
        {
          p10: pnNum("rows.pnpm10.trulyCold.ms"),
          p12: pnNum("rows.pnpm12.trulyCold.ms"),
          tip: pnNum("rows.tip.trulyCold.ms"),
        },
      ],
    ],
    source: "bench/pnpm12-bench.json",
    note: `Its own bench dataset — one workspace per leg, every leg asserted to lock the identical package set (${pnNum("rows.pnpm12.lockPackages")} packages, ${pnNum("rows.pnpm12.importers").toLocaleString("en-US")} importers), leg order rotated per round. Medians of ${pnSamples}; truly cold is a single sample. Not directly comparable to the install-bench rows above (its own flag set and install-state definitions). pnpm 12 and tip measure within a few % of each other — near-ties keep their time as the headline.`,
  },
  {
    title: "Typecheck — tsgo vs tsc",
    compareAxis: "row",
    cols: [
      { k: "tsgo", label: "tsgo", chip: "tsgo" },
      { k: "tsc", label: "tsc", chip: "tsc" },
    ],
    rows: [
      [
        `${TB.modules.toLocaleString("en-US")}-module program`,
        { tsc: TB.tsc.medianMs, tsgo: TB.tsgo.medianMs },
      ],
      [
        `type-heavy 4,000:400 (${(PAR.libs * PAR.modulesPerLib).toLocaleString("en-US")} lib modules)`,
        { tsc: PAR.cleanBaseline.tsc.ms, tsgo: PAR.cleanBaseline.tsgo.ms },
      ],
    ],
    source: "bench/typecheck-bench.json, bench/typecheck-parity-bench.json",
    note: `Versions per the JSONs: tsgo ${String(TB.versions.tsgo).replace("Version ", "")} · tsc ${String(TB.versions.tsc).replace("Version ", "")} (the parity row records the same pins).`,
  },
  {
    title: "Production build — Vite vs Next",
    compareAxis: "row",
    cols: [
      { k: "vite", label: "Vite", chip: "vite" },
      { k: "next", label: "Next", chip: "next" },
    ],
    rows: [[`${BB.apps} apps / ${BB.libs} libs`, { next: BB.next.ms, vite: BB.vite.ms }]],
    source: "bench/build-bench.json",
    note: "Different feature sets: Next App Router vs Vite SPA.",
  },
  {
    title: `pnpm 12 install situations — pnpm ${IM.pnpm}, ${IM.apps.toLocaleString("en-US")} apps, ${IM.lockfileLines.toLocaleString("en-US")}-line lockfile`,
    compareAxis: "col",
    cols: [{ k: "pnpm", label: "pnpm 12", chip: "pnpm" }],
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
      { k: "oxlint", label: "oxlint", chip: "oxlint" },
      { k: "eslint", label: "ESLint", chip: "eslint" },
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
    note: `ESLint runs a strict subset of oxlint's covered rules (no more work) — conservative. Wall-clock on a 64-core box: oxlint is multithreaded, so the ratio scales with cores. The type-aware row is mostly tsgo-vs-tsc (oxlint via tsgolint, alpha). Versions per the JSON: oxlint ${LB.versions.oxlint} · ESLint ${LB.versions.eslint}.`,
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
  // round from integer MILLISECONDS (centi-second steps below 1s, deci-second above),
  // not via float toFixed on the quotient — 605ms must print 0.61s, not 0.60s
  if (ms < 1000) return (Math.round(ms / 10) / 100).toFixed(2) + "s";
  if (ms < 100000) return (Math.round(ms / 100) / 10).toFixed(1) + "s";
  return Math.round(ms / 1000).toLocaleString("en-US") + "s";
};

// --- layout --------------------------------------------------------------------------------------
const PAD = 24; // outer margin
const FR = 16; // section-frame inner padding
const LABEL_W = 280;
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
T.push(txt(PAD, 40, "Tooling head-to-head — wall time", { size: 20, weight: "700" }));
T.push(
  txt(
    PAD,
    62,
    "Like-for-like sections, columns in one order everywhere (typically-fastest leftmost). Fastest cell green; others show ×N slower.",
    { size: 12.5, fill: MUTED },
  ),
);
T.push(
  txt(PAD, 80, `Machine: ${PAR.cores}-core host. Every number traces to the cited bench JSON.`, {
    size: 12.5,
    fill: MUTED,
  }),
);
{
  const { parts, endX } = legendRow(PAD, 102, rampLegendItems());
  T.push(...parts);
  T.push(
    txt(endX + 8, 103, "cell: ×N slower (big) · its time (small) · what it writes (installs)", {
      size: 11,
      fill: MUTED,
    }),
  );
}

let y = 126; // first section frame top
for (const sec of SECTIONS) {
  const x0 = PAD + FR;
  const gridX = x0 + LABEL_W;
  const noteLines = sec.note ? wrapText(sec.note, NOTE_CHARS) : [];
  const frameH =
    FR + 22 + 8 + HEAD_H + sec.rows.length * ROW_H + 20 + noteLines.length * 14 + FR - 2;
  T.push(sectionFrame(PAD, y, FRAME_W, frameH));

  // section title
  let sy = y + FR + 8;
  T.push(txt(x0, sy, sec.title, { size: 15, weight: "700" }));
  sy += 14;
  // header row
  T.push(txt(x0, sy + HEAD_H / 2 + 4, "scenario", { size: 11.5, fill: MUTED, weight: "600" }));
  sec.cols.forEach((col, ci) => {
    T.push(...colHeader(gridX + ci * COL_W, sy, COL_W, HEAD_H, col.label, col));
  });
  sy += HEAD_H;
  // data rows
  sec.rows.forEach((row, ri) => {
    T.push(txt(x0, sy + ROW_H / 2 + 4, row[0], { size: 12.5 }));
    sec.cols.forEach((col, ci) => {
      const x = gridX + ci * COL_W;
      const raw = row[1][col.k];
      const v = raw && typeof raw === "object" ? raw.ms : raw;
      const detail = raw && typeof raw === "object" ? raw.detail : null;
      if (v == null) {
        T.push(...naCell(x, sy, COL_W, ROW_H));
        return;
      }
      const mult = cellMult(sec, ri, ci);
      const rgb = rampRGB(mult);
      const ink = inkFor(rgb);
      // the × multiplier IS the headline for every non-fastest cell; the absolute
      // time is the sub-line. Near-ties are not "×1.0 slower" — within 5% of the
      // fastest the time stays the headline with the honest +N% as the sub-line.
      const fastest = mult <= 1.0001;
      const nearTie = !fastest && mult < 1.05;
      const main = fastest || nearTie ? fmtS(v) : fmtMult(mult) + " slower";
      const sub = fastest ? "fastest" : nearTie ? nearTiePct(mult) : fmtS(v);
      T.push(...heatCell(x, sy, COL_W, ROW_H, rgbCss(rgb), ink, main, sub, detail));
    });
    sy += ROW_H;
  });
  // per-section provenance: clickable source links (relative hrefs — resolve from
  // bench/charts/ wherever the SVG is served; GitHub's README <img> strips
  // interactivity, the Raw view keeps it), then the note word-wrapped to the frame.
  sy += 16;
  {
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
  "tool-comparison",
  svgDoc(
    W,
    H,
    "Tooling head-to-head heat table: install (bun vs pnpm 12 vs yarn 4), CI-runner frozen install, pnpm 12 Rust CLI vs pnpm 10 JS, typecheck (tsgo vs tsc), build (Vite vs Next), pnpm install situations, and lint (oxlint vs ESLint); per row the fastest cell is green and the rest show how many times slower.",
    T,
  ),
);
console.log(
  `sections: ${SECTIONS.length}, scenario rows: ${SECTIONS.reduce((n, s) => n + s.rows.length, 0)}`,
);

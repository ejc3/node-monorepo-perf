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
import { heatChart, emitChart, bareVer, mdDetails, writeDocBlock } from "./_chartstyle.mjs";
import { assertWaveRolloutSpeedText } from "./_install-speed-context.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const IB = read("bench/install-bench.json");
const CI = read("bench/container-install-bench.json");
const PN = read("bench/pnpm12-bench.json");
const TB = read("bench/typecheck-bench.json");
const PAR = read("bench/typecheck-parity-bench.json");
const BB = read("bench/build-bench.json");
const IM = read("bench/install-modes-bench.json");
const LB = read("bench/lint-bench.json");
// bench/wave-rollout-bench.json quotes these two install records in its `speedContext`
// and `claim`. This generator is the CI step that reads both, so it also holds the
// quote to the data: the committed text must equal what
// scripts/_install-speed-context.mjs derives, or the chart (and the byte-gate) fails.
assertWaveRolloutSpeedText(read("bench/wave-rollout-bench.json"), IB, CI);
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
if (!String(CI.versions.yarn).startsWith("4."))
  throw new Error(`container-install yarn ${CI.versions.yarn} no longer backs the "yarn 4" label`);
// the note's sample count is the dataset's, and every cell carries exactly that many
if (!Number.isInteger(CI.samplesPerCell) || CI.samplesPerCell < 1)
  throw new Error("container-install samplesPerCell is not a positive integer");
for (const t of ["pnpm", "bun", "yarnNm", "yarnPnp", "npm"])
  for (const v of ["freshRunner", "cacheRestored"]) {
    const s = CI.tools[t][v].samplesMs;
    if (!Array.isArray(s) || s.length !== CI.samplesPerCell)
      throw new Error(
        `container-install tools.${t}.${v}.samplesMs is not ${CI.samplesPerCell} samples`,
      );
  }
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
// the container bench times each tool inside its image, so the npm column and the
// node the installs ran under are the image's (not the host's): both come from the
// record, and the "npm N" label is its major
const ciNpm = String(need(CI, "image.npm", "bench/container-install-bench.json"));
const ciImageNode = String(need(CI, "image.node", "bench/container-install-bench.json")).replace(
  /^v/,
  "",
);
const ciNpmMajor = ciNpm.split(".")[0];
if (!/^\d+$/.test(ciNpmMajor))
  throw new Error(`container-install image.npm ${ciNpm} has no numeric major for the npm label`);
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
    sub: "zip cache + .pnp.cjs",
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
    title: "Install the workspace: bun, pnpm 12, yarn 4",
    compareAxis: "row",
    cols: INSTALL_COLS,
    rows: [
      ...[
        ["coldMs", "Cold"],
        ["warmMs", "Warm"],
      ].flatMap(([state, rLabel]) =>
        INSTALL_SCALES.map(([scale, sLabel]) => [
          `${rLabel} · ${sLabel}`,
          Object.fromEntries(
            INSTALL_COLS.map((c) => [
              c.k,
              {
                ms: inst(scale, c.tool, state),
                detail:
                  c.tool === "yarnPnp"
                    ? `${byScale[scale][c.tool].nmEntries} entries + ${(byScale[scale][c.tool].pnpCjsBytes / 1e6).toFixed(1)} MB`
                    : `${(byScale[scale][c.tool].nmEntries / 1000).toFixed(1)}k nm entries`,
              },
            ]),
          ),
          `${byScale[scale].depEdgesVerified.toLocaleString("en-US")} dep edges`,
        ]),
      ),
      [
        // scale derived from the JSON, not hand-typed — a re-run at a different first
        // scale must change this label, not silently keep "200 apps" over new numbers.
        // "Cold store + no lockfile", not "fresh container": the pass deletes the
        // lockfile, and a real fresh container/CI checkout keeps the committed one.
        `Cold store, no lockfile · ${IB.trulyCold.apps.toLocaleString("en-US")} apps`,
        {
          bun: IB.trulyCold.bunMs,
          iso: { ms: null, why: "not measured" },
          hoist: IB.trulyCold.pnpmHoistedMs,
          ynm: IB.trulyCold.yarnNmMs,
          ypnp: IB.trulyCold.yarnPnpMs,
        },
        "fresh store and metadata, network",
      ],
    ],
    source: "bench/install-bench.json",
    note: `Under each row label: the dependency edges resolved and verified after the install. Under each time: what the linker writes (node_modules entries; yarn PnP writes a 64-entry directory and the .pnp.cjs table). Cold: no lockfile, full resolve. Warm: lockfile present, relink only. Both on a warm store. Cold store, no lockfile: fresh store and metadata, real network; not comparable to the warm-store rows, and pnpm-isolated was not run in it. One sample per cell. pnpm ${IB.pnpmVersion} · bun ${IB.bunVersion} · yarn ${IB.yarnVersion}.`,
  },
  {
    title: `CI-runner install: frozen, from the committed lockfile (${CI.scale.apps.toLocaleString("en-US")} apps)`,
    compareAxis: "row",
    cols: [
      { k: "bun", label: "bun", chip: "bun" },
      { k: "pnpm", label: "pnpm 12", chip: "pnpm" },
      { k: "ynm", label: "yarn 4\nnode-modules", chip: "yarn" },
      { k: "ypnp", label: "yarn 4\nPnP", sub: "zip cache + .pnp.cjs", chip: "yarn" },
      { k: "npm", label: `npm ${ciNpmMajor}`, chip: "npm" },
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
    note: `Frozen install (--frozen-lockfile, --immutable, npm ci), median of ${CI.samplesPerCell} rotated samples, each in a fresh podman container. Same workspace shape as the 1,000-app install rows above (${CI.depEdgesVerified.toLocaleString("en-US")} dep edges). All five fail closed on lockfile drift. pnpm uses its default isolated linker. pnpm ${CI.versions.pnpm} · bun ${CI.versions.bun} · yarn ${CI.versions.yarn} · npm ${ciNpm}, node ${ciImageNode} image.`,
  },
  {
    title: `pnpm 12 (Rust) vs pnpm 10 (JS): ${pnNum("scale.apps").toLocaleString("en-US")} apps / ${pnNum("scale.libs")} libs`,
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
        "warm (lockfile + store, node_modules wiped)",
        { p10: pnRow("pnpm10", "warm"), p12: pnRow("pnpm12", "warm"), tip: pnRow("tip", "warm") },
      ],
      [
        "frozen (--frozen-lockfile, the CI row)",
        {
          p10: pnRow("pnpm10", "frozen"),
          p12: pnRow("pnpm12", "frozen"),
          tip: pnRow("tip", "frozen"),
        },
      ],
      [
        "truly cold (fresh store + network; frozen)",
        {
          p10: pnNum("rows.pnpm10.trulyCold.ms"),
          p12: pnNum("rows.pnpm12.trulyCold.ms"),
          tip: pnNum("rows.tip.trulyCold.ms"),
        },
      ],
    ],
    source: "bench/pnpm12-bench.json",
    note: `Separate dataset: one workspace per leg, every leg locks the identical package set (${pnNum("rows.pnpm12.lockPackages")} packages, ${pnNum("rows.pnpm12.importers").toLocaleString("en-US")} importers), leg order rotated per round. Median of ${pnSamples}; truly cold is one sample with the lockfile retained (store and network cost, no re-resolve). Not comparable to the install rows above.`,
  },
  {
    title: "Typecheck: tsgo vs tsc",
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
    note: `tsgo ${bareVer(TB.versions.tsgo)} · tsc ${bareVer(TB.versions.tsc)} (both rows).`,
  },
  {
    title: "Production build: Vite vs Next",
    compareAxis: "row",
    cols: [
      { k: "vite", label: "Vite", chip: "vite" },
      { k: "next", label: "Next", chip: "next" },
    ],
    rows: [[`${BB.apps} apps / ${BB.libs} libs`, { next: BB.next.ms, vite: BB.vite.ms }]],
    source: "bench/build-bench.json",
    note: "Different feature sets: Next App Router vs a Vite SPA.",
  },
  {
    title: `pnpm 12 install situations: pnpm ${IM.pnpm}, ${IM.apps.toLocaleString("en-US")} apps, ${IM.lockfileLines.toLocaleString("en-US")}-line lockfile`,
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
    note: "Compared down the column: each situation against the cheapest one.",
  },
  {
    title: `Lint: oxlint vs ESLint (${LB.corpus.files.toLocaleString("en-US")} files)`,
    compareAxis: "row",
    cols: [
      { k: "oxlint", label: "oxlint", chip: "oxlint" },
      { k: "eslint", label: "ESLint", chip: "eslint" },
    ],
    rows: [
      [
        `syntactic (oxlint ${LB.syntactic.oxlintActiveRuleCount} · ESLint ${LB.syntactic.eslintMatchedRuleCount} rules)`,
        { eslint: LB.syntactic.eslint.noCacheMs, oxlint: LB.syntactic.oxlint.runMs },
      ],
      [
        "syntactic, ESLint --cache",
        { eslint: LB.syntactic.eslint.cacheMs, oxlint: LB.syntactic.oxlint.runMs },
      ],
      ["type-aware", { eslint: LB.typeAware.eslint.ms, oxlint: LB.typeAware.oxlint.ms }],
    ],
    source: "bench/lint-bench.json",
    note: `ESLint runs a strict subset of oxlint's rules. oxlint runs multithreaded and ESLint runs single-process here (no --concurrency), so the ratio grows with cores (${need(LB, "cores", "bench/lint-bench.json")} here). The type-aware row is mostly tsgo vs tsc (oxlint through tsgolint, alpha). oxlint ${LB.versions.oxlint} · ESLint ${LB.versions.eslint}.`,
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

// --- render -------------------------------------------------------------------------------------
const cellOf = (sec, ri, ci) => {
  const raw = sec.rows[ri][1][sec.cols[ci].k];
  const v = msOf(raw);
  if (v == null) {
    const why = raw && typeof raw === "object" ? raw.why : null;
    if (!why)
      throw new Error(`section "${sec.title}": a "—" cell (${sec.cols[ci].k}) has no reason`);
    return { kind: "na", why };
  }
  const detail = raw && typeof raw === "object" ? raw.detail : undefined;
  return { kind: "ranked", text: fmtS(v), mult: cellMult(sec, ri, ci), detail };
};
// The cell standing's denominator, stated from the sections' own comparison axes: a
// column-compared section (install situations) measures each cell against the cheapest
// cell in its column, not its row, and the lede must say so for every such section.
const colSections = SECTIONS.filter((sec) => sec.compareAxis === "col");
if (SECTIONS.some((sec) => !["row", "col"].includes(sec.compareAxis)))
  throw new Error("comparison-chart: every section needs compareAxis row or col");
const STANDING = colSections.length
  ? `its multiple of the fastest in its row (in ${colSections.map((sec) => sec.title.split(":")[0]).join(", ")}: the cheapest in its column)`
  : "its multiple of the row's fastest";
for (const sec of colSections)
  if (!STANDING.includes(sec.title.split(":")[0]))
    throw new Error(`comparison-chart: the lede does not name column-compared "${sec.title}"`);
const { svg, md } = heatChart({
  title: "Tooling head-to-head: wall time",
  lede: `Each cell: the measured time, then ${STANDING}. ${PAR.cores}-core host (lint: ${need(LB, "cores", "bench/lint-bench.json")}-core).`,
  sections: SECTIONS.map((sec) => ({
    title: sec.title,
    cols: sec.cols,
    rows: sec.rows.map((row, ri) => ({
      label: row[0],
      sub: row[2],
      cells: sec.cols.map((_, ci) => cellOf(sec, ri, ci)),
    })),
    source: sec.source,
    note: sec.note,
  })),
  aria: `Tooling head-to-head heat table: install (bun vs pnpm 12 vs yarn 4), CI-runner frozen install, pnpm 12 Rust CLI vs pnpm 10 JS, typecheck (tsgo vs tsc), build (Vite vs Next), pnpm install situations, and lint (oxlint vs ESLint); each cell shows its measured time and ${STANDING}.`,
});
emitChart("tool-comparison", svg);
writeDocBlock(
  "README.md",
  "tool-comparison",
  mdDetails("The numbers as tables (fastest in bold; readable on a phone)", md),
);
console.log(
  `sections: ${SECTIONS.length}, scenario rows: ${SECTIONS.reduce((n, s) => n + s.rows.length, 0)}`,
);

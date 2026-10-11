#!/usr/bin/env node
// Render the million-module checker story as a stacked heat chart, in the same visual
// system as tool-comparison.svg (scripts/_chartstyle.mjs): each cell shows its measured
// time and its multiple of the row's fastest (× N); near-ties show their +%. Cell
// states beyond numbers: "—" with its reason (anchor cutoff), a TIMEOUT cell — a
// request that outran its budget renders at that REAL ceiling as a floor ("timed out
// ≥2m") — and a CRASH cell, which shows status only (a wedge is not a measurement).
// Deterministic from the cited bench/*.json (no hand numbers) ->
// bench/charts/checker-scale.svg (+ a 300 DPI PNG in the same step).
//
//   node scripts/scale-chart.mjs

import { readFileSync } from "node:fs";
import {
  fmtMult,
  heatChart,
  emitChart,
  bareVer,
  assertComparable,
  mdDetails,
  writeDocBlock,
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
// the save-loop and completion sections draw lsp-scale rows beside tsgo-scale rows
// under one header (tsgo version, core count): same machine size, same corpus depth,
// same checker build invoked the same way (lsp-scale records no arch, mount or node
// version, so those cannot be compared)
const field = (rec, path, name) => {
  const v = path.split(".").reduce((o, k) => o?.[k], rec);
  if (v === undefined) throw new Error(`missing ${path} in ${name}`);
  return v;
};
assertComparable(
  {
    cores: field(TS, "cores", "tsgo-scale-bench"),
    layers: field(TS, "layers", "tsgo-scale-bench"),
    tsgoInvocation: field(TS, "tsgoInvocation", "tsgo-scale-bench"),
    versions: { tsgo: field(TS, "versions.tsgo", "tsgo-scale-bench") },
  },
  {
    cores: field(LSP, "meta.cores", "lsp-scale-bench"),
    layers: field(LSP, "meta.layers", "lsp-scale-bench"),
    tsgoInvocation: field(LSP, "meta.tsgoInvocation", "lsp-scale-bench"),
    versions: { tsgo: field(LSP, "meta.tsgoVersion", "lsp-scale-bench") },
  },
  { fields: ["cores", "layers", "tsgoInvocation"], versions: ["tsgo"] },
  "checker-scale: tsgo-scale vs lsp-scale",
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
    title: "Whole-program check: tsgo, tsc, Flow",
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
    note: "Warm full check, no incremental state. tsc stops at the 100k anchor: a cost cutoff, not a capacity limit. Flow is a build of flow main with the wedge fixes (provenance in the JSON); released 0.321's server crashes at this scale (last section).",
  },
  {
    title: "A failing check costs what a passing one costs",
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
    note: "Each cell: the red run against the green run, at the checker's largest measured scale. The red run seeds 3 errors in zero-dependent leaf modules and must exit nonzero reporting exactly those errors.",
  },
  {
    title: "One edit to a verdict: the save loop, by mechanic",
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
        tss: L(n).tsserver?.skipped ? NAR("anchor ≤100k") : L(n).tsserver.warm.errorAppearsMs,
        flow: rowMs(P(n).flow, "incrOneEdit"),
        watch: L(n).tsgoWatch.oneEditRecheckMs,
        cli: rowMs(P(n).tsgo, "incrOneEdit"),
        tsccli: P(n).tsc?.skipped ? NAR("anchor ≤100k") : rowMs(P(n).tsc, "incrOneEdit"),
      },
    ]),
    source: "bench/tsgo-scale-bench.json, bench/lsp-scale-bench.json",
    note: "Squiggle: the asserted didChange → TS2322 → clear transition on a live server. Flow server: a force-recheck + status round-trip. CLI: a relaunch on warm incremental state. Released Flow 0.321's server wedges under overlapping edits at this scale (facebook/flow#9454, last section).",
  },
  {
    title: "Completion: different result sets, reported with counts",
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
        tss: L(n).tsserver?.skipped ? NAR("anchor ≤100k") : L(n).tsserver.warm.completionMs,
      },
    ]),
    source: "bench/lsp-scale-bench.json",
    note: "Not like-for-like: tsgo returns the full exported-symbol space (31,058 items at 10k, 301,058 at 100k); tsserver returns a bounded 1,067-entry set. The × prices the response a user waits for. From 250k up tsgo exceeds its 120s request ceiling; tsserver stops at the 100k anchor.",
  },
  {
    title: `Flow's wedge under edit pressure: released ${RT.binaries.released.version} vs flow main`,
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
            "wedged",
            `at cycle ${RT.runs.find((r) => r.label === "released-0321 storm").wedgedAtCycle}`,
          ),
        },
      ],
    ],
    source: "bench/flow-wedge-retest.json",
    note: `Storm: a second edit lands 120–480ms into an in-flight recheck, the trigger behind all three recorded wedges. 500k corpus. Released 0.321 wedges with a WorkerCanceled panic. Settled sequential edits never trigger it on either binary. Fix verified on flow main (facebook/flow#9454).`,
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

// --- render -------------------------------------------------------------------------------------
const cellOf = (sec, ri, ci) => {
  const v = sec.rows[ri][1][sec.cols[ci].k];
  // a bare null/undefined is a missing field, never a plausible "—": every
  // intentionally-unmeasured cell is an explicit NAR(why) at its source
  if (v == null)
    throw new Error(
      `checker-scale "${sec.title}": cell ${sec.cols[ci].k} of "${sec.rows[ri][0]}" is missing`,
    );
  if (v.na) return { kind: "na", why: v.why };
  // a crash is a status, not a measurement: no time, no multiplier
  if (v.crash) return { kind: "status", main: v.label, sub: v.sub || "" };
  if (v.ok) return { kind: "ok", main: v.label, sub: "no panic" };
  if (v.green !== undefined && v.red !== undefined) {
    // the red-gate premium as a percentage, both times as the sub-line
    const pct = ((v.red - v.green) / v.green) * 100;
    return {
      kind: "delta",
      main: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
      sub: `${fmtS(v.red)} vs ${fmtS(v.green)}`,
    };
  }
  if (v.timeout) {
    // rendered AT the real ceiling as a floor, with the ≥× from that floor when the
    // row has a measured best; never green
    const mult = cellMult(sec, ri, ci);
    return {
      kind: "status",
      main: `≥${fmtS(v.floorMs)}`,
      sub: mult == null ? v.label : `${v.label}, ≥${fmtMult(mult)}`,
    };
  }
  return { kind: "ranked", text: fmtS(v), mult: cellMult(sec, ri, ci) };
};
const { svg, md } = heatChart({
  title: "Type checkers from 10k to 1,000,000 modules",
  lede: [
    `tsgo ${bareVer(TS.versions.tsgo)} · tsc ${TS.versions.typescript} (64GB heap) · flow ${(String(TS.versions.flow).match(/flow main @ [0-9a-f]+/) || ["main build"])[0].replace("flow main", "main")} (wedge fixes in) · ${TS.cores}-core host.`,
    "Each cell: the measured time, then its multiple of the row's fastest. The red-vs-green row compares a failing run with a passing one; it is not a ranking.",
  ],
  sections: SECTIONS.map((sec) => ({
    title: sec.title,
    cols: sec.cols,
    rows: sec.rows.map((row, ri) => ({
      label: row[0],
      cells: sec.cols.map((_, ci) => cellOf(sec, ri, ci)),
    })),
    source: sec.source,
    note: sec.note,
  })),
  labelW: 196,
  colW: 112,
  statusKey: "≥ timeout · crash: status only",
  aria: "Type checkers at scale, 10k to one million modules: whole-program check (tsgo vs tsc vs Flow), the red-gate premium, the one-edit save loop by mechanic, completion, and Flow's wedge under edit pressure; each cell shows its measured time and its multiple of the row's fastest.",
});
emitChart("checker-scale", svg);
for (const doc of ["README.md", "TYPECHECKERS.md"])
  writeDocBlock(
    doc,
    "checker-scale",
    mdDetails("The numbers as tables (fastest in bold; readable on a phone)", md),
  );
console.log(
  `sections: ${SECTIONS.length}, scenario rows: ${SECTIONS.reduce((n, s) => n + s.rows.length, 0)}`,
);

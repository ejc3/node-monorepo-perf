#!/usr/bin/env node
// Render the Turbopack graph numbers in the docs from the records: TURBOPACK-GRAPH.md's
// tables between marker comments
//   <!-- turbopack-graph:ab --> ... <!-- /turbopack-graph:ab -->
//   <!-- turbopack-graph:scaling --> ... <!-- /turbopack-graph:scaling -->
// and every inline value <!--v:KEY-->...<!--/v--> in TURBOPACK-GRAPH.md, README.md and
// SUMMARY.md (keys below).
//
//   node scripts/turbopack-gym/report.mjs           # rewrite them in place
//   node scripts/turbopack-gym/report.mjs --check   # exit 1 if any differs from the records
//
// Needs no GYM_ROOT: it reads only bench/turbopack-graph-*.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const DOC = join(REPO, "TURBOPACK-GRAPH.md");
const ab = JSON.parse(readFileSync(join(REPO, "bench", "turbopack-graph-ab.json"), "utf8"));
const sc = JSON.parse(readFileSync(join(REPO, "bench", "turbopack-graph-scaling.json"), "utf8"));
// optional: the A/B record on the vizdash app (vz.* keys)
const VZ = join(REPO, "bench", "turbopack-graph-vizdash.json");
const vz = existsSync(VZ) ? JSON.parse(readFileSync(VZ, "utf8")) : null;

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const s2 = (x) => `${x.toFixed(2)}s`;
const x3 = (x) => x.toFixed(3);
const c1 = (x) => x.toFixed(1);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const describe = {
  aa: "A/A (base vs base)",
  11: "11: topological binding usage",
  15: "15: 11 + merged-modules order + interned bitmaps",
  22: "22: sharded scheduler queue",
  "15+22": "15 + 22",
  "workers-16": "base, 16 worker threads",
  "evict-8g": "base, 8 GiB eviction floor",
  "no-fs-cache": "base, no persistent build cache",
};

function abTable() {
  const lines = [
    "| B (A = base) | graph phase | ratio | swap pairs | run-turbopack | ratio | cores in graph phase |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of ab.rows) {
    const m = (side, f) => med(r.reps.map((p) => f(p[side])));
    lines.push(
      `| ${describe[r.label] || r.label} | ${s2(m("a", (x) => x.graph.s))} → ${s2(m("b", (x) => x.graph.s))} | ${r.win ? `**${x3(r.ratio)}**` : x3(r.ratio)} | ${r.swapRatios.map(x3).join(", ")} | ${s2(m("a", (x) => x.turbopack.s))} → ${s2(m("b", (x) => x.turbopack.s))} | ${x3(r.guardRatio)} | ${c1(m("a", (x) => x.graph.cores))} → ${c1(m("b", (x) => x.graph.cores))} |`,
    );
  }
  const differ = ab.rows.filter((r) => !r.sameOutput).map((r) => describe[r.label] || r.label);
  lines.push(
    "",
    `${ab.rows.length} rows, ${ab.rows[0].reps.length} reps each. Output fingerprint: ${
      differ.length ? `matches base except in ${differ.join("; ")}` : "matches base in every row"
    }.`,
  );
  return lines.join("\n");
}

function scalingTable() {
  const bindings = [...new Set(sc.points.map((p) => p.binding))];
  const [b0, b1] = bindings;
  const at = (b, n) => sc.points.find((p) => p.binding === b && p.ncpu === n);
  const sizes = [...new Set(sc.points.map((p) => p.ncpu))].sort((a, b) => a - b);
  const lines = [
    `| cores | ${b0} graph phase | cores busy | kernel | ${b1} graph phase | cores busy | kernel | run-turbopack, ${b0} → ${b1} |`,
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const n of sizes) {
    const [p, q] = [at(b0, n), at(b1, n)];
    lines.push(
      `| ${n} | ${s2(p.median.graph.s)} | ${c1(p.median.graph.cores)} | ${pct(p.median.graph.sysShare)} | ${s2(q.median.graph.s)} | ${c1(q.median.graph.cores)} | ${pct(q.median.graph.sysShare)} | ${s2(p.median.turbopack.s)} → ${s2(q.median.turbopack.s)} |`,
    );
  }
  lines.push("", `Medians over ${sc.points[0].reps} interleaved runs per point.`);
  return lines.join("\n");
}

// Inline values: <!--v:KEY-->text<!--/v--> is rewritten to the record's value for KEY.
//   ab.<label>.ratio|guard            A/B ratios (3 decimals)
//   ab.<label>.graphA|graphB|tpA|tpB  medians over reps (seconds, 2 decimals)
//   ab.<label>.coresA|coresB          median cores in the graph phase (1 decimal)
//   vz.<label>.<field>                the same fields from bench/turbopack-graph-vizdash.json
//   prod.<label1>.<label2>            product of two rows' ratios (3 decimals)
//   sc.<binding>.<cores>.<graph|cores|sys|tp|entry>          one scaling point (median)
//   sc.<binding>.<lo>-<hi>.<graph|cores|sys|tp|entry>        range over points lo..hi
//   ratio.sc.<b1>.<b2>.<cores>.graph  scaling graph ratio b2/b1 at a size (2 decimals)
//   machine                           instance, CPUs, NUMA nodes, memory, node
function value(key) {
  const k = key.split(".");
  const rec = k[0] === "vz" ? vz || fail("no bench/turbopack-graph-vizdash.json") : ab;
  const row = (l) => rec.rows.find((r) => r.label === l) || fail(`no A/B row ${l}`);
  const fail = (m) => {
    throw new Error(`${key}: ${m}`);
  };
  const point = (b, n) =>
    sc.points.find((p) => p.binding === b && p.ncpu === n) || fail(`no point ${b}@${n}`);
  const field = (p, f) =>
    ({
      graph: p.median.graph.s,
      cores: p.median.graph.cores,
      sys: p.median.graph.sysShare,
      tp: p.median.turbopack.s,
      entry: p.median.entrypoints.s,
    })[f] ?? fail(`field ${f}`);
  const fmt = (f, x) => (f === "sys" ? pct(x) : f === "cores" ? c1(x) : s2(x));
  if (k[0] === "machine") {
    const m = ab.machine;
    return `a dedicated ${m.instanceType}: ${m.cores} ${m.cpuModel} vCPUs in ${m.numaNodes} NUMA nodes, ${m.memGiB} GiB, Node ${m.node.replace(/^v/, "")}`;
  }
  if (k[0] === "prod") return x3(row(k[1]).ratio * row(k[2]).ratio);
  if (k[0] === "ab" || k[0] === "vz") {
    const label = k.slice(1, -1).join(".");
    const r = row(label);
    const f = k.at(-1);
    const m = (side, g) => med(r.reps.map((p) => g(p[side])));
    return (
      {
        ratio: () => x3(r.ratio),
        guard: () => x3(r.guardRatio),
        graphA: () => s2(m("a", (x) => x.graph.s)),
        graphB: () => s2(m("b", (x) => x.graph.s)),
        tpA: () => s2(m("a", (x) => x.turbopack.s)),
        tpB: () => s2(m("b", (x) => x.turbopack.s)),
        coresA: () => c1(m("a", (x) => x.graph.cores)),
        coresB: () => c1(m("b", (x) => x.graph.cores)),
      }[f]?.() ?? fail(`field ${f}`)
    );
  }
  if (k[0] === "ratio" && k[1] === "sc") {
    const [b1, b2, n] = [k[2], k[3], Number(k[4])];
    return (field(point(b2, n), "graph") / field(point(b1, n), "graph")).toFixed(2);
  }
  if (k[0] === "sc") {
    const f = k.at(-1);
    const b = k.slice(1, -2).join(".");
    const span = k.at(-2);
    if (span.includes("-")) {
      const [lo, hi] = span.split("-").map(Number);
      const xs = sc.points
        .filter((p) => p.binding === b && p.ncpu >= lo && p.ncpu <= hi)
        .map((p) => field(p, f));
      if (!xs.length) fail("empty range");
      const [mn, mx] = [Math.min(...xs), Math.max(...xs)];
      return f === "sys"
        ? `${pct(mn).slice(0, -1)}–${pct(mx)}`
        : f === "cores"
          ? `${c1(mn)}–${c1(mx)}`
          : `${mn.toFixed(2)}–${s2(mx)}`;
    }
    return fmt(f, field(point(b, Number(span)), f));
  }
  fail("unknown key");
}
const inline = (doc) =>
  doc.replace(
    /<!--v:([^>]+?)-->[\s\S]*?<!--\/v-->/g,
    (_, key) => `<!--v:${key}-->${value(key)}<!--/v-->`,
  );

const section = (doc, name, body) => {
  const re = new RegExp(
    `(<!-- turbopack-graph:${name} -->)[\\s\\S]*?(<!-- /turbopack-graph:${name} -->)`,
  );
  if (!re.test(doc)) throw new Error(`TURBOPACK-GRAPH.md has no turbopack-graph:${name} markers`);
  return doc.replace(re, `$1\n${body}\n$2`);
};
const render = (doc) => inline(section(section(doc, "ab", abTable()), "scaling", scalingTable()));

// TURBOPACK-GRAPH.md gets tables and inline values; README.md and SUMMARY.md inline
// values only
const files = [
  [DOC, render],
  [join(REPO, "README.md"), inline],
  [join(REPO, "SUMMARY.md"), inline],
];
let stale = 0;
for (const [file, fn] of files) {
  const doc = readFileSync(file, "utf8");
  const out = fn(doc);
  if (process.argv.includes("--check")) {
    if (out !== doc) {
      console.error(
        `${file.split("/").at(-1)} differs from the records: run scripts/turbopack-gym/report.mjs`,
      );
      stale++;
    }
  } else if (out !== doc) writeFileSync(file, out);
}
if (process.argv.includes("--check")) {
  if (stale) process.exit(1);
  console.log("Turbopack graph numbers in the docs match the records");
} else console.log("rendered the Turbopack graph numbers from the records");

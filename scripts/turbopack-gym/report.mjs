#!/usr/bin/env node
// Render TURBOPACK-GRAPH.md's tables from the records, between marker comments:
//   <!-- turbopack-graph:ab --> ... <!-- /turbopack-graph:ab -->
//   <!-- turbopack-graph:scaling --> ... <!-- /turbopack-graph:scaling -->
//
//   node scripts/turbopack-gym/report.mjs           # rewrite the tables in place
//   node scripts/turbopack-gym/report.mjs --check   # exit 1 if they differ from the records
//
// Needs no GYM_ROOT: it reads only bench/turbopack-graph-*.json.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const DOC = join(REPO, "TURBOPACK-GRAPH.md");
const ab = JSON.parse(readFileSync(join(REPO, "bench", "turbopack-graph-ab.json"), "utf8"));
const sc = JSON.parse(readFileSync(join(REPO, "bench", "turbopack-graph-scaling.json"), "utf8"));

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

const section = (doc, name, body) => {
  const re = new RegExp(
    `(<!-- turbopack-graph:${name} -->)[\\s\\S]*?(<!-- /turbopack-graph:${name} -->)`,
  );
  if (!re.test(doc)) throw new Error(`TURBOPACK-GRAPH.md has no turbopack-graph:${name} markers`);
  return doc.replace(re, `$1\n${body}\n$2`);
};
const render = (doc) => section(section(doc, "ab", abTable()), "scaling", scalingTable());

const doc = readFileSync(DOC, "utf8");
const out = render(doc);
if (process.argv.includes("--check")) {
  if (out !== doc) {
    console.error(
      "TURBOPACK-GRAPH.md tables differ from the records: run scripts/turbopack-gym/report.mjs",
    );
    process.exit(1);
  }
  console.log("TURBOPACK-GRAPH.md tables match the records");
} else {
  writeFileSync(DOC, out);
  console.log("rendered TURBOPACK-GRAPH.md tables");
}

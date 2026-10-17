#!/usr/bin/env node
// Render the Turbopack graph numbers in the docs from the records: TURBOPACK-GRAPH.md's
// tables between marker comments
//   <!-- turbopack-graph:ab --> ... <!-- /turbopack-graph:ab -->
//   <!-- turbopack-graph:scaling --> ... <!-- /turbopack-graph:scaling -->
// and every inline value <!--v:KEY-->...<!--/v--> in TURBOPACK-GRAPH.md, README.md,
// SUMMARY.md and bench/turbopack-gym/cache-drift.md (keys below).
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
// optional A/B records with the same fields as ab.*, by key prefix: the vizdash app (vz.*)
// and the operation-counter A/Bs (oc.*)
const AB_RECORDS = { vz: "turbopack-graph-vizdash.json", oc: "turbopack-graph-52.json" };
const abRecords = Object.fromEntries(
  Object.entries(AB_RECORDS)
    .map(([k, f]) => [k, join(REPO, "bench", f)])
    .filter(([, f]) => existsSync(f))
    .map(([k, f]) => [k, JSON.parse(readFileSync(f, "utf8"))]),
);
// optional: the persistent-cache drift records (dr.* keys), by name
const DRIFT = {
  main: "turbopack-graph-drift.json",
  c56: "turbopack-graph-drift-56.json",
  c52w: "turbopack-graph-drift-52w.json",
  c57: "turbopack-graph-drift-57.json",
  c58: "turbopack-graph-drift-58.json",
  c59: "turbopack-graph-drift-59.json",
  c61: "turbopack-graph-drift-61.json",
  cores24: "turbopack-graph-drift-cores-24.json",
  cores48: "turbopack-graph-drift-cores-48.json",
  cores96: "turbopack-graph-drift-cores-96.json",
  cores192: "turbopack-graph-drift-cores-192.json",
  big24: "turbopack-graph-drift-2x-24.json",
  c52s192: "turbopack-graph-drift-52s-192.json",
  c52s24: "turbopack-graph-drift-52s-24.json",
  c4142big: "turbopack-graph-drift-4142-2x.json",
  c4142: "turbopack-graph-drift-4142.json",
  full24: "turbopack-graph-drift-full-24.json",
  full192: "turbopack-graph-drift-full-192.json",
  c64s24: "turbopack-graph-drift-64-24.json",
  c64s192: "turbopack-graph-drift-64-192.json",
  c65s24: "turbopack-graph-drift-65-24.json",
  c65s192: "turbopack-graph-drift-65-192.json",
  c6667s24: "turbopack-graph-drift-6667-24.json",
  c6667s192: "turbopack-graph-drift-6667-192.json",
  up24: "turbopack-graph-drift-up-24.json",
  up192: "turbopack-graph-drift-up-192.json",
  up68s24: "turbopack-graph-drift-up68-24.json",
  up68s192: "turbopack-graph-drift-up68-192.json",
  up70s24: "turbopack-graph-drift-up70-24.json",
  up70s192: "turbopack-graph-drift-up70-192.json",
  up71s24: "turbopack-graph-drift-up71-24.json",
  up71s192: "turbopack-graph-drift-up71-192.json",
  up71cs24: "turbopack-graph-drift-up71c-24.json",
  up72s24: "turbopack-graph-drift-up72-24.json",
  up72s192: "turbopack-graph-drift-up72-192.json",
  up72rs24: "turbopack-graph-drift-up72r-24.json",
  up72rs192: "turbopack-graph-drift-up72r-192.json",
  up72cs24: "turbopack-graph-drift-up72c-24.json",
  lab72s24: "turbopack-graph-drift-lab72-24.json",
  up73s24: "turbopack-graph-drift-up73-24.json",
  up73s8: "turbopack-graph-drift-up73-8.json",
  up73s192: "turbopack-graph-drift-up73-192.json",
  up73cs24: "turbopack-graph-drift-up73c-24.json",
  up73cs8: "turbopack-graph-drift-up73c-8.json",
  up73cs192: "turbopack-graph-drift-up73c-192.json",
};
const drift = Object.fromEntries(
  Object.entries(DRIFT)
    .map(([k, f]) => [k, join(REPO, "bench", f)])
    .filter(([, f]) => existsSync(f))
    .map(([k, f]) => [k, JSON.parse(readFileSync(f, "utf8"))]),
);
// optional: the warm-start cache-read probes (cr.* keys)
const CACHE_READ = join(REPO, "bench", "turbopack-gym", "cache-read-probes.json");
const cacheRead = existsSync(CACHE_READ) ? JSON.parse(readFileSync(CACHE_READ, "utf8")) : null;
// optional: route-stats.mjs records (rs.* keys), by name
const ROUTE_STATS = { c60: "route-stats-60.json" };
// optional: next-ab.mjs records (na.* keys), by name
const NEXT_AB = {
  c62: "next-ab-62.json",
  node192: "next-ab-node-192.json",
  node24: "next-ab-node-24.json",
};
const nextAb = Object.fromEntries(
  Object.entries(NEXT_AB)
    .map(([k, f]) => [k, join(REPO, "bench", "turbopack-gym", f)])
    .filter(([, f]) => existsSync(f))
    .map(([k, f]) => [k, JSON.parse(readFileSync(f, "utf8"))]),
);
const routeStats = Object.fromEntries(
  Object.entries(ROUTE_STATS)
    .map(([k, f]) => [k, join(REPO, "bench", "turbopack-gym", f)])
    .filter(([, f]) => existsSync(f))
    .map(([k, f]) => [k, JSON.parse(readFileSync(f, "utf8"))]),
);

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
//   vz.<label>.<field>, oc.<label>.<field>  the same fields from an optional A/B record
//                                     (AB_RECORDS)
//   prod.<label1>.<label2>            product of two rows' ratios (3 decimals)
//   sc.<binding>.<cores>.<graph|cores|sys|tp|entry>          one scaling point (median)
//   sc.<binding>.<lo>-<hi>.<graph|cores|sys|tp|entry>        range over points lo..hi
//   ratio.sc.<b1>.<b2>.<cores>.graph  scaling graph ratio b2/b1 at a size (2 decimals)
//   machine                           instance, CPUs, NUMA nodes, memory, node
//   dr.<rec>.<edit>.<binding>.<N>.<mode>.<wall|turbopack|emit|preEmit|afterCompile|lowCoreS>
//                                     drift median (seconds, 1 decimal); rec names a drift
//                                     record (DRIFT), mode warm|cold|off
//   dr.<rec>.<edit>.<binding>.<N>.<mode>.memPeak  median of the runs' memory peaks (GiB,
//                                     2 decimals)
//   dr.<rec>.<edit>.<binding>.<N>.<mode>.over.<mode2>  ratio of the two modes' wall medians
//   cr.<set>.<binding>.<mode>.<N>.<turbopack|wall>  cache-read probe median over its reps
//                                     (seconds, 1 decimal); set names a cache-read-probes.json
//                                     set (pageCache: mode is the page cache, cold|hot)
//   cr.<set>.<binding>.<mode>.<N>.over.<binding2>.<mode2>  ratio of turbopack medians (1 decimal)
//   rs.<rec>.<base|candidate>.<s|rssMiB>  route-stats median (seconds, 2 decimals; MiB)
//   rs.<rec>.ratio                    candidate/base median time (3 decimals)
//   rs.<rec>.manifests                manifest files and total size
//   na.<rec>.<mode>.<side>.<wall|turbopack|after>  next-ab median (seconds, 1 decimal); side
//                                     base|candidate|reference, mode cold|warm
//   na.<rec>.<mode>.ratio             candidate/base median wall (3 decimals)
function value(key) {
  const k = key.split(".");
  const fail = (m) => {
    throw new Error(`${key}: ${m}`);
  };
  const rec = k[0] in AB_RECORDS ? abRecords[k[0]] || fail(`no bench/${AB_RECORDS[k[0]]}`) : ab;
  const row = (l) => rec.rows.find((r) => r.label === l) || fail(`no A/B row ${l}`);
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
  if (k[0] === "rs") {
    const r = routeStats[k[1]] || fail(`no route-stats record ${k[1]}`);
    if (k[2] === "ratio") return r.ratio.toFixed(3);
    if (k[2] === "manifests")
      return `${r.manifests.files.toLocaleString("en-US")} files, ${r.manifests.mb} MB`;
    const m = r.median?.[k[2]] || fail(`no side ${k[2]}`);
    if (k[3] === "s") return `${m.s.toFixed(2)}s`;
    if (k[3] === "rssMiB") return `${m.rssMiB.toLocaleString("en-US")} MiB`;
    fail(`field ${k[3]}`);
  }
  if (k[0] === "na") {
    const r = nextAb[k[1]] || fail(`no next-ab record ${k[1]}`);
    const m = r.median?.[k[2]] || fail(`no mode ${k[2]}`);
    if (k[3] === "ratio") return m.ratio.toFixed(3);
    const side = m[k[3]] || fail(`no side ${k[3]}`);
    const x = side[k[4]];
    if (typeof x !== "number") fail(`field ${k[4]}`);
    return `${x.toFixed(1)}s`;
  }
  if (k[0] === "cr") {
    const set = cacheRead && Object.hasOwn(cacheRead, k[1]) ? cacheRead[k[1]] : null;
    if (!Array.isArray(set?.builds)) fail(`no set ${k[1]} in cache-read-probes.json`);
    const pick = (b, mode, n, f) => {
      const xs = set.builds
        .filter((r) => r.binding === b && (r.pageCache ?? r.mode) === mode && r.n === Number(n))
        .map((r) => r[f]);
      if (!xs.length) fail(`no ${b} ${mode} N=${n} builds in ${k[1]}`);
      if (xs.some((x) => typeof x !== "number")) fail(`no ${f} in every such build`);
      return med(xs);
    };
    if (k[5] === "over")
      return (pick(k[2], k[3], k[4], "turbopack") / pick(k[6], k[7], k[4], "turbopack")).toFixed(1);
    if (!["turbopack", "wall"].includes(k[5])) fail(`field ${k[5]}`);
    return `${pick(k[2], k[3], k[4], k[5]).toFixed(1)}s`;
  }
  if (k[0] === "dr") {
    const rec = drift[k[1]] || fail(`no drift record ${k[1]}`);
    const ser = rec.series.find((x) => x.edit === k[2]) || fail(`no ${k[2]} series`);
    const pt = ser.points.find((p) => p.n === Number(k[4])) || fail(`no point N=${k[4]}`);
    const at = (mode, f) =>
      pt[k[3]]?.[mode]?.median?.[f] ?? fail(`no ${k[3]} ${mode} ${f} at N=${k[4]}`);
    if (k[6] === "over") return (at(k[5], "wall") / at(k[7], "wall")).toFixed(2);
    if (k[6] === "memPeak") {
      const runs = pt[k[3]]?.[k[5]]?.runs;
      if (!runs?.length) fail(`no ${k[3]} ${k[5]} runs at N=${k[4]}`);
      const xs = runs.map((r) => r.memPeakGiB);
      if (xs.some((x) => typeof x !== "number" || !Number.isFinite(x)))
        fail(`no memPeakGiB in every ${k[3]} ${k[5]} run at N=${k[4]}`);
      return `${med(xs).toFixed(2)} GiB`;
    }
    return `${at(k[5], k[6]).toFixed(1)}s`;
  }
  if (k[0] === "ab" || k[0] in AB_RECORDS) {
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

// TURBOPACK-GRAPH.md gets tables and inline values; the other docs inline values only
const files = [
  [DOC, render],
  [join(REPO, "README.md"), inline],
  [join(REPO, "SUMMARY.md"), inline],
  [join(REPO, "bench", "turbopack-gym", "cache-drift.md"), inline],
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

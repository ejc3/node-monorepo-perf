#!/usr/bin/env node
// Print one run's per-second CPU timeline with the trace-build phases overlaid.
//   node scripts/turbopack-gym/show.mjs [run-id]      (default: newest run)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUNS } from "./lib.mjs";

const id =
  process.argv[2] ||
  readdirSync(RUNS)
    .map((d) => [d, statSync(join(RUNS, d)).mtimeMs])
    .sort((a, b) => b[1] - a[1])[0][0];
const r = JSON.parse(readFileSync(join(RUNS, id, "run.json"), "utf8"));
const t0 = Date.parse(r.when);
const spans = r.phases
  .filter((e) => e.duration > 2e5)
  .map((e) => ({
    name: e.name,
    a: (e.startTime - t0) / 1000,
    b: (e.startTime - t0) / 1000 + e.duration / 1e6,
  }))
  .sort((x, y) => x.a - y.a);
console.log(`${r.label || r.binding} ncpu=${r.ncpu} wall=${r.wall}s avg cores=${r.cores}`);
for (const s of spans)
  console.log(
    `  ${s.name.padEnd(28)} ${s.a.toFixed(1).padStart(6)}s -> ${s.b.toFixed(1).padStart(6)}s  (${(s.b - s.a).toFixed(1)}s)`,
  );
const W = 60;
r.timeline.forEach((c, t) => {
  const tags = spans
    .filter((s) => t + 0.5 >= s.a && t + 0.5 < s.b)
    .map((s) => s.name.replace(/^turbopack-/, ""));
  const bar = "#".repeat(Math.round((c / r.ncpu) * W));
  console.log(
    `${String(t).padStart(4)}s ${c.toFixed(1).padStart(6)} |${bar.padEnd(W)}| ${tags.join(",")}`,
  );
});

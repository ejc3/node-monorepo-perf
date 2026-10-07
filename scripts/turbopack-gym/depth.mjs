#!/usr/bin/env node
// Import-graph shape of an app's first-party source: module count, edges, and the
// longest import chain from any route entry. Graph construction discovers a module's
// imports only after parsing it, so the longest chain bounds the phase from below
// no matter how many cores are available.
//
//   node scripts/turbopack-gym/depth.mjs [appDir]
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { APPS } from "./lib.mjs";

const app = resolve(process.argv[2] || join(APPS, "monolith"));
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|jsx?|mjs)$/.test(e.name)) files.push(p);
  }
};
for (const top of ["app", "src", "pages"]) if (existsSync(join(app, top))) walk(join(app, top));

const exts = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];
const resolveSpec = (from, spec) => {
  let base;
  if (spec.startsWith("@/")) base = join(app, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null; // package import: outside first-party shape
  for (const x of exts) if (existsSync(base + x) && statSync(base + x).isFile()) return base + x;
  return null;
};
const edges = new Map();
let edgeCount = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const out = [];
  for (const m of src.matchAll(
    /(?:import|export)[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    const t = resolveSpec(f, m[1] || m[2]);
    if (t) out.push(t);
  }
  edges.set(f, out);
  edgeCount += out.length;
}
// longest path via memoized DFS (the generated graph is a DAG; guard cycles anyway)
const memo = new Map();
const onStack = new Set();
const longest = (f) => {
  if (memo.has(f)) return memo.get(f);
  if (onStack.has(f)) return 0;
  onStack.add(f);
  let best = 0;
  for (const t of edges.get(f) || []) best = Math.max(best, 1 + longest(t));
  onStack.delete(f);
  memo.set(f, best);
  return best;
};
const entries = files.filter((f) => /\/(page|layout|route|instrumentation)\.[tj]sx?$/.test(f));
const depths = entries.map(longest).sort((a, b) => a - b);
console.log(
  JSON.stringify({
    app: relative(APPS, app) || app,
    modules: files.length,
    edges: edgeCount,
    entries: entries.length,
    maxDepth: depths.at(-1),
    medianEntryDepth: depths[depths.length >> 1],
  }),
);

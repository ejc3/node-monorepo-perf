// The engine's variants that fixes.mjs and scriptc-check.mjs measure: copies of
// route-planner/engine and native/ with edits, each a find that must occur exactly once.
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLANNER } from "./lib.mjs";

// --- the variants: route-planner/engine and native/, with edits (each find exactly once) ----
const any = "(globalThis as any).__rp";
const ROUTER = "engine/src/router.ts";
const BOUND_NOW_START = "/** Faster than any road's free speed (40 m/s, 89 mph)";
const BOUND_END = "const BEATEN_COST";
const CALL_NOW =
  "  const toGo = freeFlowTo(g, o.cal, to, from);\n  const h = (ei: number) => toGo(g.edges[ei]!.to);";
const CAPPED =
  "  const enough = () => Math.min(cap, done[from] ? Math.max(2 * dist[from]!, dist[from]! + 60) : Infinity);";
const UNCAPPED =
  "  const enough = () => (done[from] ? Math.max(2 * dist[from]!, dist[from]! + 60) : Infinity);";
// The estimate before the free-flow bound: straight-line distance at the fastest free speed.
const STRAIGHT_BLOCK = `const maxSpeedCache = new WeakMap<Graph, number>();
/** Fastest free-flow speed in the graph, m/s, at the calibration's speed scale. */
export function maxSpeed(g: Graph, cal: Calibration): number {
  let v = maxSpeedCache.get(g);
  if (v === undefined) {
    // A loop, not Math.max(...edges): a big area's edges overflow a browser worker's stack as arguments.
    v = 1;
    for (const e of g.edges) if (e.freeSpeedKph > v) v = e.freeSpeedKph;
    maxSpeedCache.set(g, v);
  }
  return (v * cal.speedScale) / 3.6;
}

`;
const STRAIGHT_CALL =
  "  const vmax = maxSpeed(g, o.cal);\n  const h = (ei: number) => distance(g.vertices[g.edges[ei]!.to]!, target) / vmax;";
// The free-flow bound as first written: one backward search to exhaustion per destination
// (four kept), and one per penalized attempt, the penalties multiplied in.
const FULL_BLOCK = `const freeFlowCache = new WeakMap<Graph, WeakMap<Calibration, Map<number, Float64Array>>>();
export function freeFlowTo(g: Graph, cal: Calibration, to: number, penalty?: Map<number, number>): Float64Array {
  if (penalty?.size) return backward(g, cal, to, penalty);
  let byCal = freeFlowCache.get(g);
  if (!byCal) { byCal = new WeakMap(); freeFlowCache.set(g, byCal); }
  let byTo = byCal.get(cal);
  if (!byTo) { byTo = new Map(); byCal.set(cal, byTo); }
  const kept = byTo.get(to);
  if (kept) return kept;
  const dist = backward(g, cal, to);
  if (byTo.size >= 4) byTo.delete(byTo.keys().next().value!);
  byTo.set(to, dist);
  return dist;
}

function backward(g: Graph, cal: Calibration, to: number, penalty?: Map<number, number>): Float64Array {
  const dist = new Float64Array(g.vertices.length).fill(Infinity);
  const open = new Heap();
  dist[to] = 0;
  open.push(0, to);
  while (open.size) {
    const [d, v] = open.pop();
    if (d > dist[v]!) continue;
    for (const ei of g.vertices[v]!.in) {
      const e = g.edges[ei]!;
      const nd = d + freeFlowTime(e, cal) * (penalty?.get(ei) ?? 1);
      if (nd < dist[e.from]!) { dist[e.from] = nd; open.push(nd, e.from); }
    }
  }
  return dist;
}

`;
const FULL_CALL =
  "  const toGo = freeFlowTo(g, o.cal, to, o.penalty);\n  const h = (ei: number) => toGo[g.edges[ei]!.to]!;";
const HOTSPOTS = [
  "engine/src/plan.ts",
  "out.push(departurePoint(simulateRoute(g, stats, route, m, o, false), m, target));",
  "out.push(departurePoint(simulateRoute(g, stats, route, m, o), m, target));",
];
// Counters the child reads (globalThis.__rp); they change no arithmetic.
export const COUNTERS = [
  [
    ROUTER,
    "export function shortestPath(g: Graph, stats: MovementStats, from: number, to: number, o: SearchOptions): Route | null {",
    `export function shortestPath(g: Graph, stats: MovementStats, from: number, to: number, o: SearchOptions): Route | null {\n  ${any}.searches++;`,
  ],
  [ROUTER, "    done[ei] = 1;\n    const e = g.edges[ei]!;", `    done[ei] = 1;\n    ${any}.settled++;\n    const e = g.edges[ei]!;`],
  [ROUTER, "    const m = this.movement(inId, outId);\n", `    const m = this.movement(inId, outId);\n    ${any}.buckets++;\n`],
  [
    "engine/src/simulate.ts",
    "  const n = route.edges.length;\n  const mornings: Morning[] = [];",
    `  const n = route.edges.length;\n  const mornings: Morning[] = [];\n  ${any}.simulations++; ${any}.mornings += o.runs; ${any}.crossings += movements.length * o.runs; ${any}.edgeDraws += n * o.runs;`,
  ],
];
// the vertices the bound's backward search settles, in the lazily grown search and the full one
const LAZY_COUNTER = [ROUTER, "    done[v] = 1;\n    f.reach = d;", `    done[v] = 1;\n    ${any}.boundSettled++;\n    f.reach = d;`];
const FULL_COUNTER = [ROUTER, "    if (d > dist[v]!) continue;\n", `    if (d > dist[v]!) continue;\n    ${any}.boundSettled++;\n`];
const region = (file, start, end, text) => [file, { start, end }, text];

// each variant: its edits, and the counter of its bound's search (none for straight)
export const ASTAR = {
  straight: [[region(ROUTER, BOUND_NOW_START, BOUND_END, STRAIGHT_BLOCK), [ROUTER, CALL_NOW, STRAIGHT_CALL], HOTSPOTS], []],
  bound: [[region(ROUTER, BOUND_NOW_START, BOUND_END, FULL_BLOCK), [ROUTER, CALL_NOW, FULL_CALL], HOTSPOTS], [FULL_COUNTER]],
  lazy: [[[ROUTER, CAPPED, UNCAPPED], HOTSPOTS], [LAZY_COUNTER]],
  skip: [[[ROUTER, CAPPED, UNCAPPED]], [LAZY_COUNTER]],
  now: [[], [LAZY_COUNTER]],
};
// Traffic terms in a WeakMap keyed by edges, as before Scriptc.
export const WEAKMAP = [
  [
    "engine/src/traffic.ts",
    "function termsOf(e: Edge, cal: Calibration): EdgeTerms {\n  let t = e.terms;",
    "const edgeTerms = new WeakMap<Edge, EdgeTerms>();\nfunction termsOf(e: Edge, cal: Calibration): EdgeTerms {\n  let t = edgeTerms.get(e);",
  ],
  ["engine/src/traffic.ts", "  e.terms = t;\n  return t;", "  edgeTerms.set(e, t);\n  return t;"],
];
// The engine's forms before its Scriptc rewrites (the same arithmetic in the same order).
export const PRE_SCRIPTC = [
  ...WEAKMAP,
  ["engine/src/pack.ts", '  const nodes: RoadData["nodes"] = [];', "  const nodes = [];"],
  ["engine/src/pack.ts", '  const restrictions: RoadData["restrictions"] = [];', "  const restrictions = [];"],
  [
    "engine/src/plan.ts",
    "      let floor = departFrom;\n      for (const p of curve) if (p.departMinute <= lb && p.onTime >= o.goal.confidence && p.departMinute > floor) floor = p.departMinute;",
    "      const floor = Math.max(...curve.filter((p) => p.departMinute <= lb! && p.onTime >= o.goal.confidence).map((p) => p.departMinute), departFrom);",
  ],
  [ROUTER, "  const cost = new Float64Array(n);\n  cost.fill(Infinity);", "  const cost = new Float64Array(n).fill(Infinity);"],
  [ROUTER, "  const prev = new Int32Array(n);\n  prev.fill(-1);", "  const prev = new Int32Array(n).fill(-1);"],
  [
    ROUTER,
    "  const starts: number[] = o.startEdge !== undefined ? [o.startEdge] : g.vertices[from]!.out;\n  for (let si = 0; si < starts.length; si++) {\n    const ei = starts[si]!;",
    "  for (const ei of o.startEdge !== undefined ? [o.startEdge] : g.vertices[from]!.out) {",
  ],
  [
    ROUTER,
    "    const outs = g.vertices[e.to]!.out;\n    for (let oi = 0; oi < outs.length; oi++) {\n      const fi = outs[oi]!;",
    "    for (const fi of g.vertices[e.to]!.out) {",
  ],
  ["engine/src/simulate.ts", "    meanSec: sum(samples) / o.runs,", "    meanSec: samples.reduce((s, x) => s + x, 0) / o.runs,"],
  [
    "engine/src/simulate.ts",
    "    const sums = h.sums;\n    for (let k = 0; k < o.runs; k++) sums[k] = sums[k]! + pm.all[k]!;",
    "    for (let k = 0; k < o.runs; k++) h.sums[k]! += pm.all[k]!;",
  ],
  ["engine/src/simulate.ts", "      meanSec: sum(sorted) / o.runs, p50Sec", "      meanSec: sorted.reduce((s, x) => s + x, 0) / o.runs, p50Sec"],
];

/** A copy of route-planner/engine and native/ under <root>/<name>, with the edits applied. */
export function variant(root, name, edits) {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  for (const d of ["engine/src", "native"]) cpSync(join(PLANNER, d), join(dir, d), { recursive: true });
  for (const [file, find, replace] of edits) {
    const p = join(dir, file);
    const s = readFileSync(p, "utf8");
    if (typeof find === "string") {
      const n = s.split(find).length - 1;
      if (n !== 1) throw new Error(`${name}: ${file}: expected one ${JSON.stringify(find.slice(0, 70))}, found ${n}`);
      writeFileSync(p, s.replace(find, () => replace));
    } else {
      const a = s.indexOf(find.start), b = s.indexOf(find.end, a);
      if (a < 0 || b < 0) throw new Error(`${name}: ${file}: region ${find.start.slice(0, 40)} not found`);
      writeFileSync(p, s.slice(0, a) + replace + s.slice(b));
    }
  }
  return dir;
}


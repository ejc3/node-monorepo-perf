// Turn-aware, time-dependent shortest paths. The search state is the edge you arrived
// on, so a left across traffic and a right turn at the same junction cost differently,
// and each movement is priced at the minute you reach it.

import { distance } from "./geo.ts";
import { movementAllowed, type Graph } from "./graph.ts";
import { describeMovement, sampleDelay, type Movement } from "./intersection.ts";
import { hash, rng } from "./random.ts";
import { freeFlowTime, runningTime, type Calibration } from "./traffic.ts";

export interface Route {
  edges: number[];
  lengthM: number;
}

export interface RouteCostOptions {
  /** 0: minimise expected time. Higher: also avoid intersections whose bad days are bad (adds risk × sd). */
  risk: number;
  cal: Calibration;
  /** "beaten": price intersections the way a typical router does, flat and with no queues. */
  pricing?: "model" | "beaten";
}

const STATS_SAMPLES = 48;

/** Per-movement delay statistics, cached by movement and five-minute bucket. */
export class MovementStats {
  // Keyed by number (in edge × edge count + out edge, then the bucket): building a string key
  // for every lookup was a large share of a plan's time in Hermes' interpreter.
  private movements = new Map<number, Movement>();
  private stats = new Map<number, Map<number, { mean: number; sd: number }>>();
  private readonly g: Graph;
  private readonly cal: Calibration;
  constructor(g: Graph, cal: Calibration) {
    this.g = g;
    this.cal = cal;
  }

  movement(inId: number, outId: number): Movement {
    const key = inId * this.g.edges.length + outId;
    let m = this.movements.get(key);
    if (!m) { m = describeMovement(this.g, inId, outId); this.movements.set(key, m); }
    return m;
  }

  delay(inId: number, outId: number, minuteOfDay: number): { mean: number; sd: number } {
    const bucket = Math.floor(minuteOfDay / 5) * 5;
    const pair = inId * this.g.edges.length + outId;
    let byBucket = this.stats.get(pair);
    if (!byBucket) { byBucket = new Map(); this.stats.set(pair, byBucket); }
    let s = byBucket.get(bucket);
    if (s) return s;
    const m = this.movement(inId, outId);
    // Same random stream for a movement at every hour: differences between hours are real.
    const r = rng(hash(`${inId}>${outId}`));
    let sum = 0, sum2 = 0;
    for (let i = 0; i < STATS_SAMPLES; i++) {
      const dayFactor = Math.exp(this.cal.daySigma * r.normal());
      const d = sampleDelay(this.g, m, { minuteOfDay: bucket + 2.5, dayFactor, cal: this.cal }, r).seconds;
      sum += d; sum2 += d * d;
    }
    const mean = sum / STATS_SAMPLES;
    s = { mean, sd: Math.sqrt(Math.max(0, sum2 / STATS_SAMPLES - mean * mean)) };
    byBucket.set(bucket, s);
    return s;
  }
}

/** Faster than any road's free speed (40 m/s, 89 mph): only bounds how far the backward search goes. */
const CAP_SPEED_MS = 40;

/** A backward search from one destination over free-flow times, grown as far as a search needs it. */
interface FreeFlow { dist: Float64Array; done: Uint8Array; open: Heap; reach: number }
const freeFlowCache = new WeakMap<Graph, WeakMap<Calibration, Map<number, FreeFlow>>>();

/**
 * A lower bound on the cost from each vertex to `to`, for a search starting at `from`: the
 * free-flow seconds still to go (every road at its free speed, no traffic, no waits at
 * junctions, no turn rules). No route costs less (a route's cost adds traffic, waits, risk and
 * penalties to these times), so as A*'s estimate it still finds the cheapest route first, and
 * far sooner than straight-line distance at the fastest speed anywhere: on a 22-mile trip that
 * estimate let a search wander over half the map.
 *
 * The backward search runs only until it has passed `from` with room to spare (twice its time,
 * and at least a minute more), so a short trip in a big area searches a small patch; a vertex
 * it has not reached is at least as far as it has gone. It is kept per destination (a few at a
 * time) and grown again for a search from farther away.
 */
export function freeFlowTo(g: Graph, cal: Calibration, to: number, from: number): (v: number) => number {
  let byCal = freeFlowCache.get(g);
  if (!byCal) { byCal = new WeakMap(); freeFlowCache.set(g, byCal); }
  let byTo = byCal.get(cal);
  if (!byTo) { byTo = new Map(); byCal.set(cal, byTo); }
  let f = byTo.get(to);
  if (!f) {
    f = { dist: new Float64Array(g.vertices.length).fill(Infinity), done: new Uint8Array(g.vertices.length), open: new Heap(), reach: 0 };
    f.dist[to] = 0;
    f.open.push(0, to);
    if (byTo.size >= 4) byTo.delete(byTo.keys().next().value!);
    byTo.set(to, f);
  }
  const { dist, done, open } = f;
  // Past `from` with room to spare; and never further than the trip could take at a speed
  // above any road's, four times over, so an origin that cannot reach `to` at all (a point
  // snapped onto a small piece of road on its own) does not search the whole area.
  const cap = (4 * distance(g.vertices[from]!, g.vertices[to]!)) / CAP_SPEED_MS + 600;
  const enough = () => Math.min(cap, done[from] ? Math.max(2 * dist[from]!, dist[from]! + 60) : Infinity);
  while (open.size && f.reach < enough()) {
    const [d, v] = open.pop();
    if (done[v]) continue;
    done[v] = 1;
    f.reach = d;
    for (const ei of g.vertices[v]!.in) {
      const e = g.edges[ei]!;
      const nd = d + freeFlowTime(e, cal);
      if (nd < dist[e.from]!) { dist[e.from] = nd; open.push(nd, e.from); }
    }
  }
  // Searched out: every vertex left is one that cannot reach `to` at all.
  if (!open.size) f.reach = Infinity;
  const ff = f;
  return (v) => (done[v] ? dist[v]! : ff.reach);
}

const BEATEN_COST: Record<string, number> = { signal: 15, all_way_stop: 8, stop: 6, give_way: 2 };

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= key) break;
      k[i] = k[p]!; v[i] = v[p]!; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const top: [number, number] = [k[0]!, v[0]!];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < k.length && k[l]! < mk) { m = l; mk = k[l]!; }
        if (r < k.length && k[r]! < mk) { m = r; }
        if (m === i) break;
        k[i] = k[m]!; v[i] = v[m]!; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export interface SearchOptions extends RouteCostOptions {
  departMinute: number;
  /** Multiplies the cost of using an edge (alternatives). */
  penalty?: Map<number, number>;
  /**
   * The edge the car is already on (a new route mid-drive): the route begins with it and
   * leaves its end by an allowed movement, never by turning back at `from`.
   */
  startEdge?: number;
}

/** Fastest path from vertex `from` to vertex `to` leaving at `departMinute`, or null. */
export function shortestPath(g: Graph, stats: MovementStats, from: number, to: number, o: SearchOptions): Route | null {
  if (from === to && o.startEdge === undefined) return { edges: [], lengthM: 0 };
  const n = g.edges.length;
  const cost = new Float64Array(n);
  cost.fill(Infinity);
  const clock = new Float64Array(n); // seconds after departure on arrival at the edge's end
  const prev = new Int32Array(n);
  prev.fill(-1);
  const open = new Heap();
  const target = g.vertices[to]!;
  // access=destination ways are free to use only when the trip starts or ends on them.
  const endWays = new Set([...g.vertices[from]!.out, ...g.vertices[from]!.in, ...target.in, ...target.out].map((ei) => g.edges[ei]!.way));
  const edgeCost = (ei: number, t: number) => {
    const e = g.edges[ei]!;
    const run = runningTime(e, o.departMinute + t / 60, o.cal);
    const destPenalty = e.destinationOnly && !endWays.has(e.way) ? 120 : 0;
    return { run, weighted: run * (o.penalty?.get(ei) ?? 1) + destPenalty };
  };
  // A* on the free-flow time still to go: never more than the true remaining cost, so the
  // first route found is the cheapest.
  const toGo = freeFlowTo(g, o.cal, to, from);
  const h = (ei: number) => toGo(g.edges[ei]!.to);
  const starts: number[] = o.startEdge !== undefined ? [o.startEdge] : g.vertices[from]!.out;
  for (let si = 0; si < starts.length; si++) {
    const ei = starts[si]!;
    const c = edgeCost(ei, 0);
    cost[ei] = c.weighted; clock[ei] = c.run;
    open.push(c.weighted + h(ei), ei);
  }
  let best = -1;
  const done = new Uint8Array(n);
  while (open.size) {
    const [, ei] = open.pop();
    if (done[ei]) continue;
    done[ei] = 1;
    const e = g.edges[ei]!;
    if (e.to === to) { best = ei; break; }
    const outs = g.vertices[e.to]!.out;
    for (let oi = 0; oi < outs.length; oi++) {
      const fi = outs[oi]!;
      if (done[fi]) continue;
      const f = g.edges[fi]!;
      if (!movementAllowed(g, e, f)) continue;
      const tArrive = clock[ei]!;
      let delay: number, weightedDelay: number;
      if (o.pricing === "beaten") {
        const m = stats.movement(ei, fi);
        delay = m.control === "internal" ? 0 : (BEATEN_COST[m.control] ?? 0);
        weightedDelay = delay;
      } else {
        const d = stats.delay(ei, fi, o.departMinute + tArrive / 60);
        delay = d.mean;
        weightedDelay = d.mean + o.risk * d.sd;
      }
      const c = edgeCost(fi, tArrive + delay);
      const nc = cost[ei]! + weightedDelay + c.weighted;
      if (nc < cost[fi]!) {
        cost[fi] = nc;
        clock[fi] = tArrive + delay + c.run;
        prev[fi] = ei;
        open.push(nc + h(fi), fi);
      }
    }
  }
  if (best < 0) return null;
  const edges: number[] = [];
  for (let ei = best; ei >= 0; ei = prev[ei]!) edges.push(ei);
  edges.reverse();
  return { edges, lengthM: edges.reduce((s, ei) => s + g.edges[ei]!.lengthM, 0) };
}

/** How much of `a`'s length is shared with `b`. */
export function overlap(g: Graph, a: Route, b: Route): number {
  const inB = new Set(b.edges.map((ei) => g.edges[ei]!.way + ":" + g.edges[ei]!.from));
  let shared = 0;
  for (const ei of a.edges) if (inB.has(g.edges[ei]!.way + ":" + g.edges[ei]!.from)) shared += g.edges[ei]!.lengthM;
  return a.lengthM ? shared / a.lengthM : 0;
}

/**
 * Up to `k` genuinely different routes: route, make the edges used dearer, route again,
 * keep a path only if it shares less than `maxOverlap` of its length with each one kept.
 */
export function alternatives(
  g: Graph, stats: MovementStats, from: number, to: number, o: SearchOptions, k = 5, maxOverlap = 0.75,
): Route[] {
  const kept: Route[] = [];
  const penalty = new Map<number, number>();
  for (let attempt = 0; attempt < k * 3 && kept.length < k; attempt++) {
    const r = shortestPath(g, stats, from, to, { ...o, penalty });
    if (!r) break;
    if (r.edges.length === 0) return [r]; // already there: there is no other way
    if (kept.every((x) => overlap(g, r, x) < maxOverlap && overlap(g, x, r) < maxOverlap)) kept.push(r);
    for (const ei of r.edges) penalty.set(ei, (penalty.get(ei) ?? 1) * 1.35);
  }
  return kept;
}

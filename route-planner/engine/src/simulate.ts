// Monte Carlo of one route: many mornings, each with its own demand level, its own
// signal phases and its own gaps. What comes out is a distribution of door-to-door
// times, not a number, and which intersections made it wide.

import type { Graph } from "./graph.ts";
import { explainControl, nameControl, sampleDelay, type Movement } from "./intersection.ts";
import { rng } from "./random.ts";
import type { MovementStats, Route } from "./router.ts";
import { runningTime, type Calibration } from "./traffic.ts";

export interface SimOptions {
  runs: number;
  seed: number;
  cal: Calibration;
  /** Fixed time at the ends: walking to the car, the drop-off line, parking (seconds). */
  endOverheadSec?: number;
}

export interface Hotspot {
  complex: number;
  lat: number;
  lon: number;
  what: string;
  /** A few words for a list: "Stop at Oak Ave (left)". */
  name: string;
  control: Movement["control"];
  inferred: boolean;
  meanSec: number;
  /** The typical morning (median) and a bad one (90th percentile). */
  p50Sec: number;
  p90Sec: number;
  /** Share of runs in which the queue here was over capacity. */
  overflowShare: number;
}

export interface SimResult {
  departMinute: number;
  /** Door-to-door seconds, sorted ascending. */
  samples: Float64Array;
  meanSec: number;
  p10Sec: number;
  p50Sec: number;
  p90Sec: number;
  p95Sec: number;
  runningMeanSec: number;
  junctionMeanSec: number;
  hotspots: Hotspot[];
}

export function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

/**
 * One simulated morning on a route. `enter[i]` and `leave[i]` are the seconds after
 * departure at which the car starts edge i and reaches its end; the gap from `leave[i]` to
 * `enter[i + 1]` is its wait at the junction (`wait[i]`, `overflow[i]`).
 */
export interface Morning {
  enter: Float64Array;
  leave: Float64Array;
  wait: Float64Array;
  overflow: Uint8Array;
  totalSec: number;
}

/** Draw `runs` mornings of a route leaving at `departMinute`: the one place a route is simulated. */
export function simulateMornings(
  g: Graph, stats: MovementStats, route: Route, departMinute: number, o: SimOptions,
): { mornings: Morning[]; movements: Movement[] } {
  const r = rng(o.seed);
  const movements: Movement[] = [];
  for (let i = 1; i < route.edges.length; i++) movements.push(stats.movement(route.edges[i - 1]!, route.edges[i]!));
  const n = route.edges.length;
  const mornings: Morning[] = [];
  for (let k = 0; k < o.runs; k++) {
    // One morning: everyone's demand moves together (rain, an event, a holiday week).
    const dayFactor = Math.exp(o.cal.daySigma * r.normal());
    const m: Morning = { enter: new Float64Array(n), leave: new Float64Array(n), wait: new Float64Array(n), overflow: new Uint8Array(n), totalSec: 0 };
    let t = 0;
    for (let i = 0; i < n; i++) {
      const e = g.edges[route.edges[i]!]!;
      m.enter[i] = t;
      t += runningTime(e, departMinute + t / 60, o.cal, dayFactor) * Math.exp(o.cal.edgeSigma * r.normal());
      m.leave[i] = t;
      if (i < movements.length) {
        const d = sampleDelay(g, movements[i]!, { minuteOfDay: departMinute + t / 60, dayFactor, cal: o.cal }, r);
        m.wait[i] = d.seconds;
        m.overflow[i] = d.overflow ? 1 : 0;
        t += d.seconds;
      }
    }
    m.totalSec = t + (o.endOverheadSec ?? 0);
    mornings.push(m);
  }
  return { mornings, movements };
}

/**
 * A route's mornings summed up: the times, and with `hotspots` (the default) where the waits
 * are. A departure curve reads only the times; summing every intersection for every departure
 * was a large share of a plan.
 */
/** Left to right, as reduce adds. */
function sum(xs: Float64Array): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s;
}

export function simulateRoute(g: Graph, stats: MovementStats, route: Route, departMinute: number, o: SimOptions, hotspots = true): SimResult {
  const { mornings, movements } = simulateMornings(g, stats, route, departMinute, o);
  const samples = new Float64Array(mornings.length);
  for (let k = 0; k < mornings.length; k++) samples[k] = mornings[k]!.totalSec;
  let runSum = 0, juncSum = 0;
  for (const m of mornings) for (let i = 0; i < m.enter.length; i++) { runSum += m.leave[i]! - m.enter[i]!; juncSum += m.wait[i]!; }
  samples.sort();
  const summary = {
    departMinute, samples,
    meanSec: sum(samples) / o.runs,
    p10Sec: quantile(samples, 0.1), p50Sec: quantile(samples, 0.5), p90Sec: quantile(samples, 0.9), p95Sec: quantile(samples, 0.95),
    runningMeanSec: runSum / o.runs, junctionMeanSec: juncSum / o.runs,
  };
  if (!hotspots) return { ...summary, hotspots: [] };
  // Plain loops: in Hermes' interpreter a callback per morning per movement was slow.
  const perMove = movements.map((_, i) => {
    const all = new Float64Array(mornings.length);
    let over = 0;
    for (let k = 0; k < mornings.length; k++) { all[k] = mornings[k]!.wait[i]!; over += mornings[k]!.overflow[i]!; }
    return { all, over };
  });
  // Hotspots: per intersection complex, the movements on this route through it summed.
  const byComplex = new Map<number, { m: Movement; sums: Float64Array; over: number }>();
  movements.forEach((m, i) => {
    if (m.control === "none") return;
    const pm = perMove[i]!;
    let h = byComplex.get(m.complex);
    if (!h) { h = { m, sums: new Float64Array(o.runs), over: 0 }; byComplex.set(m.complex, h); }
    if (m.control !== "internal") h.m = m;
    const sums = h.sums;
    for (let k = 0; k < o.runs; k++) sums[k] = sums[k]! + pm.all[k]!;
    h.over = Math.max(h.over, pm.over);
  });
  const spots: Hotspot[] = [...byComplex.values()].map(({ m, sums, over }) => {
    const sorted = Float64Array.from(sums).sort();
    const v = g.vertices[g.edges[m.inEdge]!.to]!;
    return {
      complex: m.complex, lat: v.lat, lon: v.lon, what: explainControl(m), name: nameControl(m), control: m.control, inferred: m.inferred,
      meanSec: sum(sorted) / o.runs, p50Sec: quantile(sorted, 0.5), p90Sec: quantile(sorted, 0.9),
      overflowShare: over / o.runs,
    };
  });
  spots.sort((a, b) => b.meanSec - a.meanSec);
  return { ...summary, hotspots: spots };
}

/** Share of simulated mornings that arrive at or before `arriveByMinute`. */
export function onTimeShare(sim: SimResult, arriveByMinute: number): number {
  const budget = (arriveByMinute - sim.departMinute) * 60;
  let lo = 0, hi = sim.samples.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sim.samples[mid]! <= budget) lo = mid + 1; else hi = mid; }
  return lo / sim.samples.length;
}

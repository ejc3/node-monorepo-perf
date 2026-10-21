// The question a driver asks: "when do I have to leave, and which way?" Given an
// arrive-by time and how sure they want to be, find for each route the latest departure
// that still makes it, and rank routes by that.

import type { Graph } from "./graph.ts";
import { alternatives, overlap, shortestPath, type MovementStats, type Route } from "./router.ts";
import { onTimeShare, quantile, simulateRoute, type SimOptions, type SimResult } from "./simulate.ts";

export interface Goal {
  arriveByMinute: number;
  /** e.g. 0.95: arrive on time on 95 mornings of 100. */
  confidence: number;
  /** Arrive this many minutes before `arriveByMinute`. */
  earlyMinutes: number;
}

export interface DeparturePoint {
  departMinute: number;
  p10Sec: number;
  p50Sec: number;
  p90Sec: number;
  /** Share of simulated mornings arriving by the goal's target. */
  onTime: number;
  /** Twenty door-to-door times (s), the 2.5th, 7.5th, … 97.5th percentiles: one dot per weekday of a month. */
  dots: number[];
}

export function departureCurve(
  g: Graph, stats: MovementStats, route: Route, goal: Goal, fromMinute: number, toMinute: number, stepMinutes: number, o: SimOptions,
): DeparturePoint[] {
  const target = goal.arriveByMinute - goal.earlyMinutes;
  const out: DeparturePoint[] = [];
  for (let m = fromMinute; m <= toMinute + 1e-9; m += stepMinutes) {
    // The same seed at every departure, so the curve's steps are the traffic, not the dice.
    out.push(departurePoint(simulateRoute(g, stats, route, m, o, false), m, target));
  }
  // Leaving later never makes arriving by a fixed time likelier (traffic is first in,
  // first out), so a rise between two departures is sampling noise: hold the lower value.
  for (let i = 1; i < out.length; i++) out[i]!.onTime = Math.min(out[i]!.onTime, out[i - 1]!.onTime);
  return out;
}

/** One departure's numbers, all from the one simulation: its range, its chance and its dots. */
export function departurePoint(sim: SimResult, departMinute: number, target: number): DeparturePoint {
  return {
    departMinute, p10Sec: sim.p10Sec, p50Sec: sim.p50Sec, p90Sec: sim.p90Sec, onTime: onTimeShare(sim, target),
    dots: Array.from({ length: 20 }, (_, i) => quantile(sim.samples, (i + 0.5) / 20)),
  };
}

/** The latest departure on the curve meeting the goal's confidence, interpolated; null if none does. */
export function leaveBy(curve: DeparturePoint[], goal: Goal): number | null {
  let best: number | null = null;
  for (let i = 0; i < curve.length; i++) {
    const p = curve[i]!;
    if (p.onTime < goal.confidence) continue;
    best = p.departMinute;
    const n = curve[i + 1];
    if (n && n.onTime < goal.confidence) {
      best = p.departMinute + ((p.onTime - goal.confidence) / (p.onTime - n.onTime)) * (n.departMinute - p.departMinute);
    }
  }
  return best;
}

/**
 * Keep a recommendation still unless the evidence moved it. A routine should not read
 * 7:38 one day and 7:35 the next because of noise: a new answer within `hysteresisMin`
 * of the last one keeps the last one. Always rounds down to a whole minute.
 */
export function stableLeaveBy(previous: number | null, next: number, hysteresisMin = 3): number {
  const n = Math.floor(next);
  if (previous === null) return n;
  return Math.abs(n - previous) < hysteresisMin ? previous : n;
}

export interface RouteChoice {
  label: "beaten" | "analysed";
  route: Route;
  leaveBy: number | null;
  /** The simulation at the leave-by minute (or the first departure tried, when none makes it). */
  atLeaveBy: SimResult;
  /** The leave-by minute as a departure of its own, from that simulation; null when none makes it. */
  leavePoint: DeparturePoint | null;
  curve: DeparturePoint[];
}

export interface PlanOptions {
  goal: Goal;
  sim: SimOptions;
  /** At most this many routes come back (the usual one always among them). Default 5. */
  maxRoutes?: number;
  /** Departures tried: from `windowMinutes` before the arrive-by time up to it. */
  windowMinutes?: number;
  stepMinutes?: number;
  alternatives?: number;
}

/** Candidate routes (the beaten path and our own), each with its departure curve and leave-by time. */
export function plan(g: Graph, stats: MovementStats, from: number, to: number, o: PlanOptions): RouteChoice[] {
  const window = o.windowMinutes ?? 60;
  const step = o.stepMinutes ?? 2;
  const departFrom = o.goal.arriveByMinute - window;
  // Route around the middle of the window; the curve then prices each route at every departure.
  const routeAt = o.goal.arriveByMinute - 25;
  const candidates: { label: RouteChoice["label"]; route: Route }[] = [];
  const beaten = shortestPath(g, stats, from, to, { departMinute: routeAt, risk: 0, cal: o.sim.cal, pricing: "beaten" });
  if (beaten) candidates.push({ label: "beaten", route: beaten });
  for (const risk of from === to ? [] : [0, 1.5]) {
    for (const r of alternatives(g, stats, from, to, { departMinute: routeAt, risk, cal: o.sim.cal }, o.alternatives ?? 4)) {
      if (candidates.every((c) => overlap(g, r, c.route) < 0.9 || overlap(g, c.route, r) < 0.9)) candidates.push({ label: "analysed", route: r });
    }
  }
  const choices = candidates.map(({ label, route }) => {
    const curve = departureCurve(g, stats, route, o.goal, departFrom, o.goal.arriveByMinute, step, o.sim);
    const target = o.goal.arriveByMinute - o.goal.earlyMinutes;
    let lb = leaveBy(curve, o.goal);
    // The leave-by time is a whole minute simulated on its own, and must meet the goal on its
    // own: the curve's crossing (between two five-minute departures) can land on a minute whose
    // own simulation falls just short ("Leave by 7:46", then 94% at 7:46). Step back a minute at
    // a time to the latest that meets it; the curve's departure before the crossing does.
    let at = simulateRoute(g, stats, route, lb === null ? departFrom : Math.floor(lb), o.sim);
    if (lb !== null) {
      let floor = departFrom;
      for (const p of curve) if (p.departMinute <= lb && p.onTime >= o.goal.confidence && p.departMinute > floor) floor = p.departMinute;
      let m = Math.floor(lb);
      while (m > floor && onTimeShare(at, target) < o.goal.confidence) {
        m -= 1;
        at = simulateRoute(g, stats, route, m, o.sim);
      }
      lb = m;
    }
    const leavePoint = lb === null ? null : departurePoint(at, lb, target);
    return { label, route, leaveBy: lb, atLeaveBy: at, leavePoint, curve };
  });
  // Latest safe departure first; a route that never makes it goes last.
  choices.sort((a, b) => (b.leaveBy ?? -Infinity) - (a.leaveBy ?? -Infinity));
  const max = o.maxRoutes ?? 5;
  const kept = choices.slice(0, max);
  const usual = choices.find((c) => c.label === "beaten");
  if (usual && !kept.includes(usual)) kept[kept.length - 1] = usual;
  return kept;
}

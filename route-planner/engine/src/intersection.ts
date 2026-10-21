// The delay one vehicle meets making one movement (in-edge → out-edge) at one junction.
//
// Each control is a small simulation of the thing a driver actually waits for:
//   stop / yield  a gap in the conflicting stream (Poisson), behind the cars queued ahead
//   all-way stop  the cars ahead on your approach, each taking turns with the others
//   signal        where in the cycle you arrive, the queue ahead, sometimes a missed cycle
// `sampleDelay` draws one outcome; distributions come from drawing many. These are
// textbook (HCM-style) models with priors, the horizon-0 answer; calibration and observed
// delays refine them.

import { turnAngle } from "./geo.ts";
import { roadRank, type Edge, type Graph } from "./graph.ts";
import type { Rng } from "./random.ts";
import { edgeDayFactor, edgeVolume, lanesPerDirection, type Calibration } from "./traffic.ts";

export type Turn = "straight" | "right" | "left" | "uturn";
export type MovementControl = "signal" | "all_way_stop" | "stop" | "give_way" | "major_left" | "free" | "internal" | "none";

export interface Movement {
  inEdge: number;
  outEdge: number;
  complex: number;
  turn: Turn;
  control: MovementControl;
  inferred: boolean;
  /** Approaches into the intersection from outside it: [edge id, is it the major road]. */
  approaches: { edge: number; major: boolean }[];
  /** The road crossed or joined, for explanations. */
  crossName: string;
  majorLanes: number;
}

export function turnOf(inEdge: Edge, outEdge: Edge): Turn {
  const a = turnAngle(inEdge.endBearing, outEdge.startBearing);
  if (Math.abs(a) > 150) return "uturn";
  if (a > 40) return "right";
  if (a < -40) return "left";
  return "straight";
}

const rankOf = roadRank;

export function describeMovement(g: Graph, inId: number, outId: number): Movement {
  const inEdge = g.edges[inId]!, outEdge = g.edges[outId]!;
  const v = g.vertices[inEdge.to]!;
  const cx = g.complexes[v.complex]!;
  const internal = g.vertices[inEdge.from]!.complex === v.complex;
  const approaches: { edge: number; major: boolean }[] = [];
  for (const vi of cx.vertices) {
    for (const ei of g.vertices[vi]!.in) {
      const e = g.edges[ei]!;
      if (g.vertices[e.from]!.complex === v.complex) continue;
      approaches.push({ edge: ei, major: rankOf(e) >= cx.majorRank - 0.5 });
    }
  }
  const turn = turnOf(inEdge, outEdge);
  const majorApproach = approaches.find((a) => a.major);
  const crossName = outEdge.name !== inEdge.name && outEdge.name ? outEdge.name : cx.majorName;
  const majorLanes = majorApproach ? lanesPerDirection(g.edges[majorApproach.edge]!) : 1;
  let control: MovementControl;
  if (v.degree < 3) control = "none";
  else if (internal) control = "internal";
  else if (inEdge.control === "signal") control = "signal";
  else if (inEdge.control === "all_way_stop") control = "all_way_stop";
  else if (inEdge.control === "stop") control = "stop";
  else if (inEdge.control === "give_way" || inEdge.control === "mini_roundabout") control = "give_way";
  else if (turn === "left" && rankOf(inEdge) >= cx.majorRank - 0.5 && approaches.length > 2) control = "major_left";
  else control = "free";
  return {
    inEdge: inId, outEdge: outId, complex: v.complex, turn, control, inferred: inEdge.controlInferred,
    approaches, crossName, majorLanes,
  };
}

// HCM-style critical headway (tc) and follow-up time (tf), seconds, for a minor-road movement.
const GAP: Record<"right" | "straight" | "left", { tc: number; tf: number }> = {
  right: { tc: 6.2, tf: 3.3 },
  straight: { tc: 6.5, tf: 4.0 },
  left: { tc: 7.1, tf: 3.5 },
};

/** Capacity of a gap-accepting movement against conflicting flow `vc` (veh/h). Finite at vc = 0. */
export function gapCapacity(vc: number, tc: number, tf: number): number {
  if (vc < 1e-6) return 3600 / tf;
  const q = vc / 3600;
  return (vc * Math.exp(-q * tc)) / -Math.expm1(-q * tf);
}

/** Time until the first gap of at least `tc` seconds in a Poisson stream of `vph`. */
function sampleGapWait(vph: number, tc: number, rng: Rng): number {
  if (vph < 1) return 0;
  const rate = vph / 3600;
  let t = 0;
  for (let i = 0; i < 400; i++) {
    const gap = rng.exponential(rate);
    if (gap >= tc) return t;
    t += gap;
  }
  return t;
}

export interface DelayContext {
  minuteOfDay: number;
  dayFactor: number;
  cal: Calibration;
}

export interface MovementFlows {
  /** Flow our movement must find gaps in (veh/h). */
  conflict: number;
  /** Our own approach's flow (veh/h), which queues ahead of us. */
  approach: number;
  /** Everything entering the intersection (veh/h). */
  total: number;
}

export function flows(g: Graph, m: Movement, ctx: DelayContext): MovementFlows {
  const { minuteOfDay, cal, dayFactor } = ctx;
  // Each approach's demand moves with the morning by its own stretch's spread.
  const inEdge = g.edges[m.inEdge]!;
  const own = edgeVolume(inEdge, minuteOfDay, cal) * edgeDayFactor(inEdge, cal, dayFactor);
  let majorOthers = 0, total = 0;
  for (const a of m.approaches) {
    const ae = g.edges[a.edge]!;
    const v = edgeVolume(ae, minuteOfDay, cal) * edgeDayFactor(ae, cal, dayFactor);
    total += v;
    if (a.major && a.edge !== m.inEdge) majorOthers += v;
  }
  let conflict = 0;
  if (m.control === "major_left") conflict = majorOthers; // the opposing direction
  else if (m.turn === "right") conflict = majorOthers * 0.5; // the near side only
  else conflict = majorOthers; // crossing or turning left: both directions
  return { conflict, approach: own, total };
}

/** No movement is priced above this: past it a driver gives up and goes another way. */
export const MAX_MOVEMENT_DELAY_S = 900;
/** Even a saturated movement moves a car a minute (someone lets you in). */
const MIN_CAPACITY_VPH = 60;

export interface DelaySample {
  seconds: number;
  /** Demand above capacity: a queue that grows for as long as the peak lasts. */
  overflow: boolean;
}

const STOP_LOSS = 5; // decelerate, stop, accelerate
const TURN_LOSS: Record<Turn, number> = { straight: 0, right: 2.5, left: 3.5, uturn: 12 };

/** Cars queued ahead of us on an approach with utilisation rho: geometric, plus a growing overflow. */
function sampleQueue(rho: number, capacityVph: number, rng: Rng): { n: number; overflow: boolean } {
  const r = Math.min(rho, 0.95);
  const n = rng.geometric(r);
  if (rho <= 0.95) return { n, overflow: false };
  // Over capacity: the queue grows through the peak. Arrive somewhere in a 20-minute peak.
  const extra = ((rho - 0.95) * capacityVph * rng.uniform(0, 1200)) / 3600;
  return { n: n + Math.round(extra), overflow: true };
}

export function sampleDelay(g: Graph, m: Movement, ctx: DelayContext, rng: Rng): DelaySample {
  const turnLoss = TURN_LOSS[m.turn];
  switch (m.control) {
    case "none":
    case "internal":
      return { seconds: turnLoss, overflow: false };
    case "free":
      return { seconds: turnLoss + (m.turn === "straight" ? 0 : 0.5), overflow: false };
    case "major_left": {
      const f = flows(g, m, ctx);
      const wait = sampleGapWait(f.conflict, 4.1, rng);
      return { seconds: turnLoss + wait + (wait > 0 ? 2 : 0), overflow: false };
    }
    case "stop":
    case "give_way": {
      const f = flows(g, m, ctx);
      const kind = m.turn === "right" ? "right" : m.turn === "straight" ? "straight" : "left";
      // A four-lane major road makes a left or crossing harder (HCM adds to tc).
      const wide = m.majorLanes >= 2 && kind !== "right" ? 0.7 : 0;
      const yieldOnly = m.control === "give_way";
      const tc = GAP[kind].tc + wide - (yieldOnly ? 0.8 : 0);
      const tf = GAP[kind].tf;
      const cap = Math.max(MIN_CAPACITY_VPH, gapCapacity(f.conflict, tc, tf));
      const q = sampleQueue(f.approach / cap, cap, rng);
      let t = 0;
      // Each car ahead takes, on average, 3600/cap seconds to clear; exponential spread.
      for (let i = 0; i < q.n; i++) t += rng.exponential(cap / 3600);
      t += sampleGapWait(f.conflict, tc, rng);
      t += yieldOnly && t < 1 ? 1.5 : STOP_LOSS;
      return { seconds: Math.min(MAX_MOVEMENT_DELAY_S, t + turnLoss), overflow: q.overflow };
    }
    case "all_way_stop": {
      const f = flows(g, m, ctx);
      // Vehicles take turns: about 4 s each when every approach is busy, quicker when not.
      const hSat = 4.0 + (m.turn === "left" ? 0.4 : m.turn === "right" ? -0.4 : 0);
      const rhoAll = (f.total * hSat) / 3600;
      const cap = 3600 / hSat / Math.max(1, m.approaches.length / 2);
      const q = sampleQueue(Math.max(rhoAll, f.approach / cap), cap, rng);
      let t = STOP_LOSS;
      for (let i = 0; i < q.n; i++) t += rng.uniform(0.6, 1.4) * hSat * Math.min(2, 1 + rhoAll);
      // Waiting your turn against a car already at another approach.
      if (rng.next() < Math.min(0.9, rhoAll)) t += rng.uniform(1, hSat);
      return { seconds: Math.min(MAX_MOVEMENT_DELAY_S, t + turnLoss), overflow: q.overflow };
    }
    case "signal": {
      const f = flows(g, m, ctx);
      const cx = g.complexes[m.complex]!;
      const cycle = cx.majorRank >= 5 ? 130 : cx.majorRank >= 4 ? 110 : cx.majorRank >= 3 ? 90 : 70;
      const onMajor = m.approaches.find((a) => a.edge === m.inEdge)?.major ?? false;
      let gShare = onMajor ? 0.55 : 0.3;
      if (m.turn === "left") gShare = onMajor ? 0.14 : 0.12; // a protected left phase
      const green = gShare * cycle, red = cycle - green;
      // A left turn queues in its own lane with the approach's left-turning share; everyone
      // else shares the through lanes.
      const left = m.turn === "left";
      const lanes = left ? 1 : lanesPerDirection(g.edges[m.inEdge]!);
      const demand = f.approach * (left ? ctx.cal.leftTurnShare : 1 - ctx.cal.leftTurnShare);
      const x = demand / (1800 * lanes * gShare);
      // Coordinated arterials: a through driver on the major road often arrives in green.
      const progressed = onMajor && m.turn === "straight" && rng.next() < 0.3;
      const arrival = progressed ? rng.uniform(0, green) : rng.uniform(0, cycle);
      let t = 0;
      if (arrival >= green) {
        const waitRed = cycle - arrival;
        // Cars that arrived during the red discharge first, ~2 s each per lane.
        const ahead = (demand / lanes / 3600) * (arrival - green);
        t = waitRed + 2 * ahead + 2 + STOP_LOSS;
      }
      // Near and over saturation the queue does not clear in one green: sometimes miss a cycle.
      const missP = Math.max(0, Math.min(0.9, (x - 0.8) / 0.4));
      let overflow = false;
      while (rng.next() < missP && t < cycle * 4) { t += red + (t === 0 ? STOP_LOSS : 0); overflow = x > 1; }
      return { seconds: t + turnLoss, overflow };
    }
  }
}

const short = (n: string) => n.replace(/\bAvenue\b/, "Ave").replace(/\bExpressway\b/, "Expy").replace(/\bBoulevard\b/, "Blvd")
  .replace(/\bLane\b/, "Ln").replace(/\bRoad\b/, "Rd").replace(/\bStreet\b/, "St").replace(/\bDrive\b/, "Dr");

/** A hotspot's name in a few words: "Stop at Oak Ave (left)". */
export function nameControl(m: Movement): string {
  const at = short(m.crossName || "cross street");
  const turn = m.turn === "left" ? " (left)" : "";
  switch (m.control) {
    case "signal": return `Signal at ${at}${turn}`;
    case "all_way_stop": return `All-way stop at ${at}`;
    case "stop": return `Stop at ${at}${turn}`;
    case "give_way": return `Yield at ${at}`;
    case "major_left": return `Left onto ${at}`;
    default: return m.turn === "straight" ? at : `${m.turn === "left" ? "Left" : "Right"} onto ${at}`;
  }
}

export function explainControl(m: Movement): string {
  const cross = m.crossName || "the cross street";
  switch (m.control) {
    case "signal": return `signal at ${cross}${m.turn === "left" ? " (left turn)" : ""}`;
    case "all_way_stop": return `all-way stop at ${cross}`;
    case "stop":
      return `${m.turn === "left" ? "left onto" : m.turn === "right" ? "right onto" : "cross"} ${cross} from a stop sign${m.inferred ? " (assumed)" : ""}`;
    case "give_way": return `yield to ${cross}${m.inferred ? " (assumed)" : ""}`;
    case "major_left": return `left across oncoming traffic onto ${cross}`;
    default: return m.turn === "straight" ? `through ${cross}` : `${m.turn} onto ${cross}`;
  }
}

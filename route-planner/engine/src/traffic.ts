// Traffic volumes and running speeds: the priors every horizon starts from, and the
// calibration a higher horizon adjusts them with.

import type { Edge } from "./graph.ts";
import type { RoadClass } from "./osm.ts";

/** Directional volume at the weekday peak (veh/h, one direction, default lanes). */
const PEAK_VPH: Record<RoadClass, number> = {
  motorway: 3600,
  trunk: 1500,
  primary: 950,
  secondary: 700,
  tertiary: 420,
  unclassified: 160,
  residential: 45,
  living_street: 10,
};
const DEFAULT_LANES_PER_DIR: Record<RoadClass, number> = {
  motorway: 3, trunk: 2, primary: 2, secondary: 2, tertiary: 1, unclassified: 1, residential: 1, living_street: 1,
};
/** Effective capacity per lane between intersections (veh/h). */
const LANE_CAPACITY: Record<RoadClass, number> = {
  motorway: 1900, trunk: 1500, primary: 1100, secondary: 1000, tertiary: 850, unclassified: 700, residential: 600, living_street: 400,
};

/**
 * Weekday demand through the day as a share of the peak, by minute since midnight. The
 * morning peak climbs from 7:00 and tops out 7:50–8:15.
 */
const WEEKDAY_PROFILE: [number, number][] = [
  [0, 0.06], [300, 0.12], [360, 0.35], [405, 0.55], [420, 0.68], [435, 0.8], [450, 0.9], [465, 0.97],
  [475, 1.0], [495, 1.0], [510, 0.9], [540, 0.78], [600, 0.65], [720, 0.75], [900, 0.88], [1020, 1.0],
  [1080, 0.9], [1200, 0.5], [1320, 0.25], [1440, 0.06],
];

// The weekday profile's segments, flattened once into plain arrays: the same subtractions,
// done ahead. demandShare runs for every edge of every simulated morning.
const AT: number[] = WEEKDAY_PROFILE.map(([m]) => m);
const SHARE: number[] = WEEKDAY_PROFILE.map(([, f]) => f);
const D_SHARE: number[] = WEEKDAY_PROFILE.map(([, f], i) => (i ? f - WEEKDAY_PROFILE[i - 1]![1] : 0));
const D_MINUTE: number[] = WEEKDAY_PROFILE.map(([m], i) => (i ? m - WEEKDAY_PROFILE[i - 1]![0] : 0));

export function demandShare(minuteOfDay: number, profile = WEEKDAY_PROFILE): number {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  if (profile === WEEKDAY_PROFILE) {
    for (let i = 1; i < AT.length; i++) {
      if (m <= AT[i]!) return SHARE[i - 1]! + (D_SHARE[i]! * (m - AT[i - 1]!)) / D_MINUTE[i]!;
    }
    return SHARE[SHARE.length - 1]!;
  }
  for (let i = 1; i < profile.length; i++) {
    const [m1, f1] = profile[i]!;
    const [m0, f0] = profile[i - 1]!;
    if (m <= m1) return f0 + ((f1 - f0) * (m - m0)) / (m1 - m0);
  }
  return profile[profile.length - 1]![1];
}

/**
 * What a higher horizon has learned for an area. Defaults are the horizon-0 priors.
 * `wayVolume` scales one way's volume (a measured count, or a fit to observed times).
 */
export interface Calibration {
  volumeScale: number;
  speedScale: number;
  /** Spread of the whole-day demand multiplier (lognormal sigma): how different one morning is from another. */
  daySigma: number;
  /** Per-edge running-time noise (lognormal sigma). */
  edgeSigma: number;
  /** Sharpens the daily demand curve (share ** peakExponent): how much busier the peak is than its shoulders. */
  peakExponent: number;
  /**
   * Share of a signalised approach's traffic turning left, which queues in its own lane for
   * the left phase; the rest uses the through lanes. A prior (the traffic-engineering norm
   * of 10–20%) until recorded drives measure it.
   */
  leftTurnShare: number;
  /** Per road class volume factor, fitted where a route on that class has observed ranges (e.g. freeways). */
  classVolume: Partial<Record<RoadClass, number>>;
  /** Per road class free-flow speed factor, fitted the same way (a freeway's real morning free flow). */
  classSpeed: Partial<Record<RoadClass, number>>;
  wayVolume: Record<string, number>;
  /**
   * Stretches of road a traffic service timed on their own (a part of an observed trip),
   * by stretch id: factors on the area-wide calibration for their edges only. None: the
   * area-wide calibration everywhere.
   */
  stretches: Record<string, Stretch>;
}

/**
 * One stretch's calibration. Its edges are those between consecutive `nodes`, in that
 * direction, on the way `ways` names. Each factor multiplies the area-wide value on those
 * edges, so 1 is the area-wide calibration: `volume` its demand, `spread` its day-to-day spread (on a morning whose demand
 * multiplier is d, the stretch's is d ** spread: one morning moves every road the same way,
 * some further). Free-flow speed stays area-wide: a stretch's own times cannot tell it from
 * the fixed start and end a service adds to a short trip (calibrate.ts, fitStretch).
 */
export interface Stretch {
  /** OSM node ids at the stretch's vertices, in driving order. */
  nodes: number[];
  /** The OSM way of each edge between them: two roads can join the same two junctions. */
  ways: number[];
  volume: number;
  spread: number;
}

export const DEFAULT_CALIBRATION: Calibration = {
  volumeScale: 1,
  speedScale: 1,
  daySigma: 0.15,
  edgeSigma: 0.1,
  peakExponent: 1,
  leftTurnShare: 0.15,
  classVolume: {},
  classSpeed: {},
  wayVolume: {},
  stretches: {},
};

export function lanesPerDirection(e: Edge): number {
  if (e.lanes === null) return DEFAULT_LANES_PER_DIR[e.cls];
  // A two-way way's `lanes` counts both directions; a one-way way's is its own.
  return Math.max(1, e.oneway ? e.lanes : Math.ceil(e.lanes / 2));
}

/**
 * What edgeVolume and runningTime read of an edge and a calibration that is the same at every
 * minute, worked out once per edge and calibration. The arithmetic below keeps the order it
 * always had, so every result is the same number to the last bit: this is speed, not a change.
 */
export interface EdgeTerms {
  cal: Calibration;
  base: number;
  classVolume: number;
  wayVolume: number;
  t0: number;
  cap: number;
  alpha: number;
  beta: number;
  /** The edge's stretch's volume and spread factors: 1 off every stretch. */
  stretchVolume: number;
  spread: number;
}
const ARTERIAL_BPR = { alpha: 0.15, beta: 4 };

// Each calibration's stretches by edge ("fromNode>toNode@way"), worked out once per calibration.
const stretchIndex = new WeakMap<Calibration, Map<string, Stretch>>();

/** The stretch an edge is on under a calibration, or null. */
export function stretchOf(e: Edge, cal: Calibration): Stretch | null {
  let index = stretchIndex.get(cal);
  if (!index) {
    index = new Map();
    for (const s of Object.values(cal.stretches ?? {})) for (let i = 1; i < s.nodes.length; i++) index.set(`${s.nodes[i - 1]}>${s.nodes[i]}@${s.ways[i - 1]}`, s);
    stretchIndex.set(cal, index);
  }
  return index.size ? index.get(`${e.fromNode}>${e.toNode}@${e.way}`) ?? null : null;
}

function termsOf(e: Edge, cal: Calibration): EdgeTerms {
  let t = e.terms;
  if (t && t.cal === cal) return t;
  const stretch = stretchOf(e, cal);
  const lanes = lanesPerDirection(e);
  const laneFactor = lanes / DEFAULT_LANES_PER_DIR[e.cls];
  const { alpha, beta } = BPR[e.cls] ?? ARTERIAL_BPR;
  t = {
    cal,
    base: PEAK_VPH[e.cls] * (e.link ? 0.4 : 1) * Math.min(2, Math.max(0.5, laneFactor)),
    classVolume: cal.classVolume?.[e.cls] ?? 1,
    wayVolume: cal.wayVolume[String(e.way)] ?? 1,
    t0: e.lengthM / ((e.freeSpeedKph * cal.speedScale * (cal.classSpeed?.[e.cls] ?? 1)) / 3.6),
    cap: LANE_CAPACITY[e.cls] * lanes,
    alpha, beta,
    stretchVolume: stretch?.volume ?? 1,
    spread: stretch?.spread ?? 1,
  };
  e.terms = t;
  return t;
}

// The last minute's demand, raised to the peak exponent: a junction reads every approach at
// the same minute, so most calls ask again for the one just worked out.
let lastMinute = NaN, lastExponent = NaN, lastDemand = 0;

/** Directional volume on an edge at a minute of the day (veh/h), before the day's multiplier. */
export function edgeVolume(e: Edge, minuteOfDay: number, cal: Calibration): number {
  const t = termsOf(e, cal);
  if (minuteOfDay !== lastMinute || cal.peakExponent !== lastExponent) {
    lastDemand = demandShare(minuteOfDay) ** cal.peakExponent;
    lastMinute = minuteOfDay;
    lastExponent = cal.peakExponent;
  }
  return t.base * lastDemand * cal.volumeScale * t.classVolume * t.wayVolume * t.stretchVolume;
}

/** The morning's demand multiplier on one edge: `dayFactor` raised to its stretch's spread (as is off every stretch). */
export function edgeDayFactor(e: Edge, cal: Calibration, dayFactor: number): number {
  const s = termsOf(e, cal).spread;
  return s === 1 ? dayFactor : dayFactor ** s;
}

/**
 * BPR congestion curve parameters. Arterials keep the classic 0.15/4 (their delay is mostly
 * at the junctions, modelled separately); freeways use the updated freeway fit
 * (alpha 0.83, beta 5.5), under which a road near capacity actually slows.
 */
const BPR: Partial<Record<RoadClass, { alpha: number; beta: number }>> = {
  motorway: { alpha: 0.83, beta: 5.5 },
  trunk: { alpha: 0.83, beta: 5.5 },
};

/** Mid-block running time (s) with the BPR congestion curve, for a given demand multiplier. */
/** Seconds to drive an edge with no traffic on it: what `runningTime` never goes under. */
export function freeFlowTime(e: Edge, cal: Calibration): number {
  return termsOf(e, cal).t0;
}

export function runningTime(e: Edge, minuteOfDay: number, cal: Calibration, dayFactor = 1): number {
  const t = termsOf(e, cal);
  const vc = (edgeVolume(e, minuteOfDay, cal) * edgeDayFactor(e, cal, dayFactor)) / t.cap;
  return t.t0 * (1 + t.alpha * vc ** t.beta);
}

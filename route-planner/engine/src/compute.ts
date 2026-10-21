// The plan call over a loaded area: what the benchmark times in every engine. A request comes
// in as JSON and the result goes out as JSON; the result is numbers, coordinates and street
// names.

import { buildGraph, nearestVertex } from "./graph.ts";
import type { LatLon } from "./geo.ts";
import type { Graph } from "./graph.ts";
import type { MovementControl } from "./intersection.ts";
import { fromPack, type AreaPack } from "./pack.ts";
import { plan, type DeparturePoint, type Goal } from "./plan.ts";
import { MovementStats, type Route } from "./router.ts";
import { DEFAULT_CALIBRATION, type Calibration } from "./traffic.ts";
import { routeLine, viaNames } from "./describe.ts";

export interface AreaModel {
  id: string;
  g: Graph;
  cal: Calibration;
  stats: MovementStats;
  /** The last plan's routes, by key. */
  routes: Map<string, Route>;
}

export function loadArea(id: string, pack: AreaPack): AreaModel {
  const g = buildGraph(fromPack(pack));
  const cal = { ...DEFAULT_CALIBRATION, ...(pack.calibration ?? {}) };
  return { id, g, cal, stats: new MovementStats(g, cal), routes: new Map() };
}

export interface PlanRequest {
  from: LatLon;
  to: LatLon;
  goal: Goal;
  runs: number;
  windowMinutes: number;
  stepMinutes: number;
}

export interface PlannedHotspot {
  lat: number;
  lon: number;
  name: string;
  control: MovementControl;
  assumed: boolean;
  typicalSec: number;
  badSec: number;
}

export interface PlannedRoute {
  key: string;
  via: string[];
  miles: number;
  line: [number, number][];
  leaveBy: number | null;
  curve: DeparturePoint[];
  /** The leave-by minute as a departure, simulated at that minute. */
  atLeaveBy?: DeparturePoint | null;
  hotspots: PlannedHotspot[];
}

export interface PlanResult {
  routes: PlannedRoute[];
}

export function planTrip(area: AreaModel, req: PlanRequest): PlanResult {
  const { g, cal, stats } = area;
  const from = nearestVertex(g, req.from), to = nearestVertex(g, req.to);
  const choices = plan(g, stats, from, to, {
    goal: req.goal, sim: { runs: req.runs, seed: 7, cal }, windowMinutes: req.windowMinutes, stepMinutes: req.stepMinutes,
  });
  area.routes = new Map(choices.map((c, i) => [`r${i}`, c.route]));
  // Two routes must not read the same: lengthen a repeated name until it differs.
  const names = choices.map((c) => viaNames(g, c.route, 5));
  const label = (k: number, j: number) => names[j]!.slice(0, k).join(", ");
  return {
    routes: choices.map((c, i) => {
      let n = 2;
      while (n < names[i]!.length && choices.some((_, j) => j !== i && label(n, j) === label(n, i))) n++;
      return {
        key: `r${i}`,
        via: names[i]!.slice(0, n),
        miles: c.route.lengthM / 1609.344,
        line: routeLine(g, c.route),
        leaveBy: c.leaveBy,
        curve: c.curve,
        atLeaveBy: c.leavePoint,
        hotspots: c.atLeaveBy.hotspots.slice().sort((a, b) => b.p90Sec - a.p90Sec).slice(0, 6).map((h) => ({
          lat: h.lat, lon: h.lon, name: h.name, control: h.control, assumed: h.inferred, typicalSec: h.p50Sec, badSec: h.p90Sec,
        })),
      };
    }),
  };
}

// AreaPack: an area's RoadData and calibration in a compact JSON the client loads.
// Columns, not objects, so a city fits in a few hundred kilobytes gzipped.

import type { Control, ControlDirection, ControlPoint, RoadClass, RoadData, SurveyedControl } from "./osm.ts";
import type { Calibration } from "./traffic.ts";
import type { BBox } from "./geo.ts";

export interface AreaPack {
  v: 1;
  id: string;
  name: string;
  bbox: BBox;
  osmTimestamp: string;
  calibration: Partial<Calibration> | null;
  /** [id, cls, link, name index, oneway, lanes|0, maxspeed kph|0, flags(1 roundabout, 2 destination), node ids...] */
  ways: (number | string)[][];
  names: string[];
  /** Flat [id, lat*1e7, lon*1e7, control index + 1 or 0, direction index + 1 or 0] repeated. */
  nodes: number[];
  /** Flat [fromWay, viaNode, toWay, 0 = no / 1 = only] repeated. */
  restrictions: number[];
  /** Surveyed intersections: [lat*1e7, lon*1e7, control index, ...street keys]. */
  controlPoints?: (number | string)[][];
}

const SURVEYED: SurveyedControl[] = ["none", "stop", "all_way_stop", "signal", "give_way"];

const CONTROLS: Control[] = ["signal", "stop", "all_way_stop", "give_way", "mini_roundabout"];
const DIRECTIONS: Exclude<ControlDirection, null>[] = ["forward", "backward", "both"];

export function toPack(
  meta: { id: string; name: string; bbox: BBox; osmTimestamp: string }, data: RoadData, calibration: Partial<Calibration> | null,
): AreaPack {
  const names: string[] = [];
  const nameIdx = new Map<string, number>();
  const ni = (n: string) => { let i = nameIdx.get(n); if (i === undefined) { i = names.length; names.push(n); nameIdx.set(n, i); } return i; };
  return {
    v: 1, ...meta, calibration, names,
    ways: data.ways.map((w) => [w.id, w.cls, w.link ? 1 : 0, ni(w.name), w.oneway, w.lanes ?? 0, Math.round(w.maxspeedKph ?? 0), (w.roundabout ? 1 : 0) | (w.destinationOnly ? 2 : 0), ...w.nodes]),
    nodes: data.nodes.flatMap((n) => [n.id, Math.round(n.lat * 1e7), Math.round(n.lon * 1e7),
      n.control ? CONTROLS.indexOf(n.control) + 1 : 0, n.controlDirection ? DIRECTIONS.indexOf(n.controlDirection) + 1 : 0]),
    restrictions: data.restrictions.flatMap((r) => [r.fromWay, r.viaNode, r.toWay, r.kind === "only" ? 1 : 0]),
    ...(data.controlPoints ? {
      controlPoints: data.controlPoints.map((c) => [Math.round(c.lat * 1e7), Math.round(c.lon * 1e7), SURVEYED.indexOf(c.control), ...c.streets]),
    } : {}),
  };
}

export function fromPack(p: AreaPack): RoadData {
  const ways = p.ways.map((w) => ({
    id: w[0] as number, cls: w[1] as RoadClass, link: w[2] === 1, name: p.names[w[3] as number] ?? "",
    oneway: w[4] as -1 | 0 | 1, lanes: (w[5] as number) || null, maxspeedKph: (w[6] as number) || null,
    roundabout: ((w[7] as number) & 1) !== 0, destinationOnly: ((w[7] as number) & 2) !== 0, nodes: w.slice(8) as number[],
  }));
  const nodes: RoadData["nodes"] = [];
  for (let i = 0; i < p.nodes.length; i += 5) {
    const c = p.nodes[i + 3]!, d = p.nodes[i + 4]!;
    nodes.push({ id: p.nodes[i]!, lat: p.nodes[i + 1]! / 1e7, lon: p.nodes[i + 2]! / 1e7,
      control: c ? CONTROLS[c - 1]! : null, controlDirection: d ? DIRECTIONS[d - 1]! : null });
  }
  const restrictions: RoadData["restrictions"] = [];
  for (let i = 0; i < p.restrictions.length; i += 4)
    restrictions.push({ fromWay: p.restrictions[i]!, viaNode: p.restrictions[i + 1]!, toWay: p.restrictions[i + 2]!, kind: p.restrictions[i + 3] ? "only" as const : "no" as const });
  const out: RoadData = { ways, nodes, restrictions };
  if (p.controlPoints) {
    out.controlPoints = p.controlPoints.map((c): ControlPoint => ({
      lat: (c[0] as number) / 1e7, lon: (c[1] as number) / 1e7, control: SURVEYED[c[2] as number]!, streets: c.slice(3) as string[],
    }));
  }
  return out;
}

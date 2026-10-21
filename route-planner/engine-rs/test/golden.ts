// The golden trips: the bench's three trips (trips.json) and 20 fixed random trips in the same
// area, the inputs the parity harness runs through every engine. Drawn from the pack each run,
// with the engine's own seeded generator, so they are the same every time.
import { distance, type LatLon } from "../../engine/src/geo.ts";
import type { RoadData } from "../../engine/src/osm.ts";
import { fromPack, type AreaPack } from "../../engine/src/pack.ts";
import { hash, rng } from "../../engine/src/random.ts";
import { packText, SPEC } from "../../area.ts";

export interface GoldenTrip {
  /** "trip: <id>" for the bench's trips, "random <n>" for the drawn ones. */
  label: string;
  from: LatLon;
  to: LatLon;
  /** Arrive by, minutes since midnight. */
  arriveBy: number;
}

export const RANDOM_TRIPS = 20;
/** Straight-line length of a random trip: long enough to cross junctions, short enough to plan quickly. */
const MIN_M = 1000, MAX_M = 15000;

/**
 * 20 trips between road nodes of the area, drawn with the engine's own generator seeded by the
 * area's id. Endpoints are on streets a trip can start or end on: no freeway, trunk road, ramp
 * or destination-only way. Arrivals are 7:30 to 9:30, on the five minutes.
 */
export function randomTrips(areaId: string, data: RoadData): GoldenTrip[] {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const seen = new Set<number>();
  const ends: LatLon[] = [];
  for (const w of data.ways) {
    if (w.link || w.destinationOnly || w.cls === "motorway" || w.cls === "trunk") continue;
    for (const id of w.nodes) {
      const n = byId.get(id);
      if (!n || seen.has(id)) continue;
      seen.add(id);
      ends.push({ lat: n.lat, lon: n.lon });
    }
  }
  if (ends.length < 2) throw new Error(`${areaId}: no streets to draw trips on`);
  const r = rng(hash(`golden-trips:${areaId}`));
  const trips: GoldenTrip[] = [];
  for (let tries = 0; trips.length < RANDOM_TRIPS; tries++) {
    if (tries > 100_000) throw new Error(`${areaId}: no ${RANDOM_TRIPS} pairs ${MIN_M}–${MAX_M} m apart`);
    const from = ends[Math.floor(r.next() * ends.length)]!, to = ends[Math.floor(r.next() * ends.length)]!;
    const d = distance(from, to);
    if (d < MIN_M || d > MAX_M) continue;
    trips.push({ label: `random ${trips.length + 1}`, from, to, arriveBy: 450 + 5 * Math.floor(r.next() * 25) });
  }
  return trips;
}

export function goldenTrips(): GoldenTrip[] {
  const data = fromPack(JSON.parse(packText()) as AreaPack);
  return [
    ...SPEC.trips.map((t) => ({ label: `trip: ${t.id}`, from: t.from, to: t.to, arriveBy: t.arriveByMinute })),
    ...randomTrips(SPEC.area, data),
  ];
}

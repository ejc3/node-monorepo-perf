// The benchmark's inputs: the area pack (OpenStreetMap data, data/README.md) and the trips
// (trips.json), read the same way by the tests, the bench and the plan entry.
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import type { LatLon } from "./engine/src/geo.ts";

export interface Trip {
  id: string;
  name: string;
  from: LatLon;
  to: LatLon;
  arriveByMinute: number;
}

export interface TripsSpec {
  area: string;
  pack: string;
  request: { goal: { confidence: number; earlyMinutes: number }; runs: number; windowMinutes: number; stepMinutes: number };
  trips: Trip[];
}

const here = new URL(".", import.meta.url);

export const SPEC = JSON.parse(readFileSync(new URL("trips.json", here), "utf8")) as TripsSpec;

/** The pack's JSON text, decompressed. */
export function packText(): string {
  return brotliDecompressSync(readFileSync(new URL(SPEC.pack, here))).toString("utf8");
}

/** A trip's plan request, as JSON text: what every engine is given. */
export function planRequest(t: Pick<Trip, "from" | "to" | "arriveByMinute">, request = SPEC.request): string {
  return JSON.stringify({
    from: t.from, to: t.to, goal: { arriveByMinute: t.arriveByMinute, ...request.goal },
    runs: request.runs, windowMinutes: request.windowMinutes, stepMinutes: request.stepMinutes,
  });
}

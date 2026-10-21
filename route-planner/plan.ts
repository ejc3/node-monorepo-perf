// The smallest use of the engine: load the area pack, plan one trip, print each route's
// length and leave-by time.
//
//   node route-planner/plan.ts [long|medium|short]
import { packText, planRequest, SPEC } from "./area.ts";
import { loadArea, planTrip, type PlanRequest } from "./engine/src/compute.ts";
import type { AreaPack } from "./engine/src/pack.ts";

const id = process.argv[2] ?? "short";
const trip = SPEC.trips.find((t) => t.id === id);
if (!trip) throw new Error(`no trip ${id}: one of ${SPEC.trips.map((t) => t.id).join(", ")}`);
const area = loadArea(SPEC.area, JSON.parse(packText()) as AreaPack);
const t0 = performance.now();
const result = planTrip(area, JSON.parse(planRequest(trip)) as PlanRequest);
const ms = performance.now() - t0;
const clock = (m: number | null) => (m === null ? "never" : `${Math.floor(m / 60)}:${String(Math.floor(m % 60)).padStart(2, "0")}`);
console.log(`${trip.name}, arriving by ${clock(trip.arriveByMinute)}: ${result.routes.length} routes in ${(ms / 1000).toFixed(2)} s`);
for (const r of result.routes) console.log(`  ${r.key}  ${r.miles.toFixed(1)} mi  leave by ${clock(r.leaveBy)}  via ${r.via.join(", ")}`);

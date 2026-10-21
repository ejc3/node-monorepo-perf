// The planner's plan call as a library: Scriptc compiles this module and the engine under it to
// a static library with the C interface in profile.json; Node and the Hermes bundles run the
// same module. One call at a time, JSON in and out.
import type { AreaPack } from "../engine/src/pack.ts";
import { loadArea, planTrip, type AreaModel, type PlanRequest } from "../engine/src/compute.ts";

const areas: AreaModel[] = [];

/** Loads an area from its pack's JSON; the handle its calls take. */
export function load(id: string, packJson: string): number {
  areas.push(loadArea(id, JSON.parse(packJson) as unknown as AreaPack));
  return areas.length - 1;
}

/**
 * A call ("plan") on a loaded area: `{"ok": result}`, or `{"error": message}` when the call
 * refuses. An error must not escape: in a native library an escaped exception is a panic.
 */
export function call(handle: number, op: string, requestJson: string): string {
  try {
    return `{"ok":${run(handle, op, requestJson)}}`;
  } catch (e) {
    return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
  }
}

function run(handle: number, op: string, requestJson: string): string {
  const area = areas[handle];
  if (!area) throw new Error(`no area ${handle}`);
  if (op === "plan") return JSON.stringify(planTrip(area, JSON.parse(requestJson) as unknown as PlanRequest));
  throw new Error(`unknown call ${op}`);
}

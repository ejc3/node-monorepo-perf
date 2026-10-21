// OSM (Overpass JSON) → RoadData: the plain records the graph is built from, and the
// shape an extract is kept in. Everything tag-specific is decided here.

export const ROAD_CLASSES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];

/** Higher is busier. Used to decide which approaches at a junction are the major road. */
export const CLASS_RANK: Record<RoadClass, number> = {
  motorway: 7,
  trunk: 6,
  primary: 5,
  secondary: 4,
  tertiary: 3,
  unclassified: 2,
  residential: 1,
  living_street: 0,
};

export interface WayRec {
  id: number;
  cls: RoadClass;
  link: boolean;
  name: string;
  /** 1: only along node order; -1: only against it; 0: both. */
  oneway: -1 | 0 | 1;
  lanes: number | null;
  maxspeedKph: number | null;
  roundabout: boolean;
  /** Passable only to reach a destination on it (access=destination). */
  destinationOnly: boolean;
  nodes: number[];
}

export type Control = "signal" | "stop" | "all_way_stop" | "give_way" | "mini_roundabout";
export type ControlDirection = "forward" | "backward" | "both" | null;

export interface NodeRec {
  id: number;
  lat: number;
  lon: number;
  control: Control | null;
  /** Relative to the node order of the way the node is on. Null: untagged. */
  controlDirection: ControlDirection;
}

export interface Restriction {
  fromWay: number;
  viaNode: number;
  toWay: number;
  kind: "no" | "only";
}

/** What a survey (a city's traffic-control inventory) says governs an intersection. */
export type SurveyedControl = "none" | "stop" | "all_way_stop" | "signal" | "give_way";

/**
 * One surveyed intersection: where it is, the streets that meet there (as `streetKey`s),
 * and its control. "stop" and "give_way" govern the lesser approaches; "none" means no
 * approach is controlled.
 */
export interface ControlPoint {
  lat: number;
  lon: number;
  streets: string[];
  control: SurveyedControl;
}

export interface RoadData {
  ways: WayRec[];
  nodes: NodeRec[];
  restrictions: Restriction[];
  controlPoints?: ControlPoint[];
}

const STREET_SUFFIXES = new Set([
  "AV", "AVE", "AVENUE", "DR", "DRIVE", "ST", "STREET", "RD", "ROAD", "LN", "LANE", "WY", "WAY", "CT", "COURT",
  "BL", "BLVD", "BOULEVARD", "PL", "PLACE", "EX", "EXPY", "EXPRESSWAY", "CR", "CIR", "CIRCLE", "TER", "TERRACE",
  "PKWY", "PY", "PARKWAY", "HWY", "HIGHWAY", "LOOP", "SQ", "SQUARE", "TR", "TRL", "TRAIL",
]);
const DIRECTIONS = new Set(["N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST"]);

/** A street name reduced to what two sources agree on: "Oak Avenue" and "OAK AV" are both "OAK". */
export function streetKey(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  while (words.length > 1 && DIRECTIONS.has(words[0]!)) words.shift();
  while (words.length > 1 && STREET_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
  members?: { type: string; ref: number; role: string }[];
}

const NOT_FOR_CARS = new Set(["no", "private", "agricultural", "forestry", "delivery", "customers", "permit"]);

function parseSpeed(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "mph" ? n * 1.609344 : n;
}

function parseOneway(tags: Record<string, string>, cls: RoadClass, roundabout: boolean): -1 | 0 | 1 | "skip" {
  const v = tags["oneway:motor_vehicle"] ?? tags["oneway"];
  if (v === "yes" || v === "1" || v === "true") return 1;
  if (v === "-1" || v === "reverse") return -1;
  if (v === "reversible" || v === "alternating") return "skip"; // direction depends on the hour; not modelled
  if (v === "no" || v === "0" || v === "false") return 0;
  return cls === "motorway" || roundabout ? 1 : 0;
}

export function controlOf(tags: Record<string, string> | undefined): { control: Control | null; direction: ControlDirection } {
  if (!tags) return { control: null, direction: null };
  const dir = (v: string | undefined): ControlDirection =>
    v === "forward" || v === "backward" || v === "both" ? v : null;
  switch (tags["highway"]) {
    case "traffic_signals":
      return { control: "signal", direction: dir(tags["traffic_signals:direction"] ?? tags["direction"]) };
    case "stop":
      return {
        control: tags["stop"] === "all" ? "all_way_stop" : "stop",
        direction: dir(tags["stop:direction"] ?? tags["direction"]),
      };
    case "give_way":
      return { control: "give_way", direction: dir(tags["give_way:direction"] ?? tags["direction"]) };
    case "mini_roundabout":
      return { control: "mini_roundabout", direction: null };
    default:
      return { control: null, direction: null };
  }
}

/** Overpass JSON elements → RoadData, keeping only ways a car may drive and the nodes they use. */
export function fromOverpass(elements: OverpassElement[]): RoadData {
  const ways: WayRec[] = [];
  for (const e of elements) {
    if (e.type !== "way" || !e.tags || !e.nodes || e.nodes.length < 2) continue;
    const t = e.tags;
    const hw = t["highway"] ?? "";
    const link = hw.endsWith("_link");
    const cls = (link ? hw.slice(0, -5) : hw) as RoadClass;
    if (!(cls in CLASS_RANK)) continue;
    // The most specific mode wins: motorcar over motor_vehicle over vehicle over access.
    const access = t["motorcar"] ?? t["motor_vehicle"] ?? t["vehicle"] ?? t["access"];
    if (access && NOT_FOR_CARS.has(access)) continue;
    // Both are one-way rings; only a roundabout gives circulating traffic priority.
    const roundabout = t["junction"] === "roundabout";
    const oneway = parseOneway(t, cls, roundabout || t["junction"] === "circular");
    if (oneway === "skip") continue;
    const lanes = t["lanes"] ? Number.parseInt(t["lanes"], 10) : NaN;
    ways.push({
      id: e.id,
      cls,
      link,
      name: t["name"] ?? t["ref"] ?? "",
      oneway,
      lanes: Number.isFinite(lanes) && lanes > 0 ? lanes : null,
      maxspeedKph: parseSpeed(t["maxspeed"]),
      roundabout,
      destinationOnly: access === "destination",
      nodes: e.nodes,
    });
  }
  const used = new Set(ways.flatMap((w) => w.nodes));
  const nodes: NodeRec[] = [];
  for (const e of elements) {
    if (e.type !== "node" || !used.has(e.id) || e.lat === undefined || e.lon === undefined) continue;
    const { control, direction } = controlOf(e.tags);
    nodes.push({ id: e.id, lat: e.lat, lon: e.lon, control, controlDirection: direction });
  }
  const restrictions: Restriction[] = [];
  for (const e of elements) {
    if (e.type !== "relation" || e.tags?.["type"] !== "restriction" || !e.members) continue;
    const r = e.tags["restriction:motorcar"] ?? e.tags["restriction"] ?? "";
    if (e.tags["except"]?.includes("motorcar")) continue;
    const from = e.members.find((m) => m.role === "from" && m.type === "way");
    const via = e.members.filter((m) => m.role === "via");
    const to = e.members.find((m) => m.role === "to" && m.type === "way");
    // Node-via only. A via-way restriction needs path state the router does not carry yet.
    if (!from || !to || via.length !== 1 || via[0]?.type !== "node") continue;
    const kind = r.startsWith("no_") ? "no" : r.startsWith("only_") ? "only" : null;
    if (kind) restrictions.push({ fromWay: from.ref, viaNode: via[0].ref, toWay: to.ref, kind });
  }
  return { ways, nodes, restrictions };
}

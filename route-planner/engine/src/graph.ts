// RoadData → Graph: vertices, directed edges, and the control each approach meets.
//
// A vertex is a node where ways meet or end. A *junction* is a vertex with three or
// more physical directions (a bend where two ways happen to be split is a vertex, not a
// junction, and costs nothing). Junction vertices close together (a divided road's
// two carriageways) form one *complex*: its control is charged once, on entry.

import type { EdgeTerms } from "./traffic.ts";
import { bearing, distance, projectOnSegment, turnAngle, type LatLon } from "./geo.ts";
import { CLASS_RANK, streetKey, type Control, type ControlPoint, type NodeRec, type RoadClass, type RoadData, type WayRec } from "./osm.ts";

export interface Edge {
  id: number;
  from: number; // vertex index
  to: number;
  /** OSM node ids of `from` and `to`: what a calibration's stretches name, stable across rebuilds. */
  fromNode: number;
  toNode: number;
  way: number; // OSM way id
  cls: RoadClass;
  link: boolean;
  name: string;
  lanes: number | null;
  /** The OSM way is one-way (its `lanes` are all this edge's). */
  oneway: boolean;
  roundabout: boolean;
  lengthM: number;
  freeSpeedKph: number;
  /** Heading leaving `from` and heading arriving at `to`, measured over the edge's end pieces. */
  startBearing: number;
  endBearing: number;
  geometry: LatLon[];
  /** Control met on arrival at `to`. */
  control: Control | null;
  /** True when no tag said so: the control was inferred from the classes meeting. */
  controlInferred: boolean;
  destinationOnly: boolean;
  /**
   * The edge's traffic terms under the last calibration it was priced with (traffic.ts), kept
   * on the edge: a map from edges to terms was slow to look up, most of all compiled ahead of time.
   */
  terms?: EdgeTerms;
}

export interface Vertex {
  node: number; // OSM node id
  lat: number;
  lon: number;
  out: number[]; // edge ids
  in: number[];
  /** Distinct physical directions; 3+ is a junction. */
  degree: number;
  complex: number; // complex id; equal for vertices of one intersection
}

export interface Complex {
  id: number;
  vertices: number[];
  /** Highest class rank of any way meeting here. */
  majorRank: number;
  /** Names of the busiest roads meeting here, for explanations. */
  majorName: string;
  signalized: boolean;
  allWay: boolean;
  /** What a survey says governs this intersection, when one covers it. */
  surveyed: ControlPoint["control"] | null;
}

export interface Graph {
  vertices: Vertex[];
  edges: Edge[];
  complexes: Complex[];
  vertexOfNode: Map<number, number>;
  /** "fromWay:viaNode" → restriction. */
  restrictions: Map<string, { kind: "no" | "only"; toWays: Set<number> }>;
}

const DEFAULT_SPEED_KPH: Record<RoadClass, number> = {
  motorway: 105,
  trunk: 80,
  primary: 64,
  secondary: 56,
  tertiary: 48,
  unclassified: 40,
  residential: 40,
  living_street: 15,
};

/**
 * How busy a road ranks at a junction. A ramp ranks just above a residential street
 * whatever it serves: it peels off or joins the road it meets and never makes that
 * road the one that stops.
 */
export function roadRank(e: Pick<Edge, "cls" | "link">): number {
  return e.link ? 1.5 : CLASS_RANK[e.cls];
}

/** A stop or signal tag up to this far before a junction governs it. */
export const CONTROL_REACH_M = 60;
const SURVEY_REACH_M = 35; // a surveyed point this close to a junction, naming one of its streets, is that junction
const COMPLEX_LINK_M = 30; // junction vertices this close, joined by an edge, are one intersection

function endBearing(points: LatLon[], fromEnd: boolean): number {
  // Measure over ~20 m so a kink in the last metre does not decide the turn.
  const pts = fromEnd ? [...points].reverse() : points;
  const a = pts[0]!;
  let b = pts[1]!;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += distance(pts[i - 1]!, pts[i]!);
    b = pts[i]!;
    if (acc >= 20) break;
  }
  return fromEnd ? bearing(b, a) : bearing(a, b);
}

/** A way's run between two vertices, by index into its nodes: one edge each way it is open. */
export interface WayPiece { startIdx: number; endIdx: number; lengthM: number }

/**
 * Each way cut at its vertices: a vertex is a way end, or a node shared by ways (counted
 * occurrences > 2). A way with a node the data does not hold (clipped at the area's edge) has
 * no entry, and a closed run under a metre long is no piece.
 */
export function wayPieces(data: RoadData): Map<number, WayPiece[]> {
  const nodes = new Map<number, NodeRec>(data.nodes.map((n) => [n.id, n]));
  const uses = new Map<number, number>();
  for (const w of data.ways) {
    w.nodes.forEach((n, i) => {
      const end = i === 0 || i === w.nodes.length - 1;
      uses.set(n, (uses.get(n) ?? 0) + (end ? 1 : 2));
    });
  }
  const isVertex = (n: number, i: number, w: WayRec) => i === 0 || i === w.nodes.length - 1 || (uses.get(n) ?? 0) > 2;
  const out = new Map<number, WayPiece[]>();
  for (const w of data.ways) {
    if (!w.nodes.every((n) => nodes.has(n))) continue;
    const pieces: WayPiece[] = [];
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (!isVertex(w.nodes[i]!, i, w)) continue;
      let lengthM = 0;
      for (let k = start + 1; k <= i; k++) lengthM += distance(nodes.get(w.nodes[k - 1]!)!, nodes.get(w.nodes[k]!)!);
      if (!(w.nodes[start] === w.nodes[i] && lengthM < 1)) pieces.push({ startIdx: start, endIdx: i, lengthM });
      start = i;
    }
    out.set(w.id, pieces);
  }
  return out;
}

/**
 * A tagged control carried to an approach it governs: along piece `piece` of way `way` (an
 * index into its `wayPieces`), travelling in node order (`forward`) or against it, arriving at
 * node `at`. `node` is the tagged node.
 */
export interface ControlPlacement { way: number; piece: number; forward: boolean; at: number; control: Control; node: number }

/**
 * Which approaches each tagged signal, stop, give-way or mini-roundabout governs: the rule
 * `buildGraph` charges controls by, exported for anything that must agree with it (the long
 * area's cut keeps the side streets of the junctions a control governs).
 *
 * - A signal, all-way stop or mini-roundabout on a vertex, with no direction: every approach
 *   on its ways there.
 * - A direction-tagged control: that direction only, to the end of its piece, within
 *   `CONTROL_REACH_M`.
 * - An untagged stop or give-way: toward the nearer end of its piece, within `CONTROL_REACH_M`.
 * - An untagged signal before a vertex: both directions, to each end within `CONTROL_REACH_M`.
 *
 * Only directions a car may travel are placed: a one-way way governs nothing against it.
 */
export function placeControls(data: RoadData, pieces: Map<number, WayPiece[]> = wayPieces(data)): ControlPlacement[] {
  const nodes = new Map<number, NodeRec>(data.nodes.map((n) => [n.id, n]));
  const out: ControlPlacement[] = [];
  for (const w of data.ways) {
    const ps = pieces.get(w.id);
    if (!ps) continue;
    const place = (piece: number, forward: boolean, control: Control, node: number) => {
      if (w.oneway === (forward ? -1 : 1)) return;
      const p = ps[piece]!;
      out.push({ way: w.id, piece, forward, at: w.nodes[forward ? p.endIdx : p.startIdx]!, control, node });
    };
    w.nodes.forEach((nodeId, idx) => {
      const n = nodes.get(nodeId)!;
      const control = n.control;
      if (!control) return;
      ps.forEach((p, k) => {
        if (idx < p.startIdx || idx > p.endIdx) return;
        // Distance from the tagged node to each end of this piece.
        let toEnd = 0, toStart = 0;
        for (let j = idx; j < p.endIdx; j++) toEnd += distance(nodes.get(w.nodes[j]!)!, nodes.get(w.nodes[j + 1]!)!);
        for (let j = p.startIdx; j < idx; j++) toStart += distance(nodes.get(w.nodes[j]!)!, nodes.get(w.nodes[j + 1]!)!);
        const dir = n.controlDirection;
        const atVertex = idx === p.startIdx || idx === p.endIdx;
        if (atVertex && dir === null && control !== "stop" && control !== "give_way") {
          // A signal or all-way stop on the junction node: every approach on this way.
          if (idx === p.endIdx) place(k, true, control, nodeId);
          if (idx === p.startIdx) place(k, false, control, nodeId);
          return;
        }
        // forward = travelling in node order, toward the piece's end.
        const forward = dir === "forward" || dir === "both" || (dir === null && toEnd <= toStart);
        const backward = dir === "backward" || dir === "both" || (dir === null && toStart < toEnd);
        if (forward && toEnd <= CONTROL_REACH_M && idx !== p.startIdx) place(k, true, control, nodeId);
        if (backward && toStart <= CONTROL_REACH_M && idx !== p.endIdx) place(k, false, control, nodeId);
        if (control === "signal" && dir === null && !atVertex) {
          // An untagged-direction signal before a junction governs both directions through it.
          if (toEnd <= CONTROL_REACH_M) place(k, true, "signal", nodeId);
          if (toStart <= CONTROL_REACH_M) place(k, false, "signal", nodeId);
        }
      });
    });
  }
  return out;
}

export function buildGraph(data: RoadData): Graph {
  const nodes = new Map<number, NodeRec>(data.nodes.map((n) => [n.id, n]));
  const vertices: Vertex[] = [];
  const vertexOfNode = new Map<number, number>();
  const vertexFor = (id: number): number => {
    let v = vertexOfNode.get(id);
    if (v === undefined) {
      const n = nodes.get(id)!;
      v = vertices.length;
      vertices.push({ node: id, lat: n.lat, lon: n.lon, out: [], in: [], degree: 0, complex: -1 });
      vertexOfNode.set(id, v);
    }
    return v;
  };

  const edges: Edge[] = [];
  const pieces = wayPieces(data);
  // Each piece's edge in node order and against it (null where the way is one-way).
  const edgesOfWay = new Map<number, { fwd: number | null; bwd: number | null }[]>();
  const neighbours = new Map<number, Set<number>>();

  for (const w of data.ways) {
    const ps = pieces.get(w.id);
    if (!ps) continue; // clipped at the area's edge
    // A way's first node is a vertex even when its only piece is too short to keep.
    if (w.nodes.length > 1) vertexFor(w.nodes[0]!);
    const made: { fwd: number | null; bwd: number | null }[] = [];
    for (const { startIdx: start, endIdx: i, lengthM } of ps) {
      const ids = w.nodes.slice(start, i + 1);
      const geometry = ids.map((id) => ({ lat: nodes.get(id)!.lat, lon: nodes.get(id)!.lon }));
      const a = vertexFor(ids[0]!), b = vertexFor(ids[ids.length - 1]!);
      const speed = w.maxspeedKph ?? DEFAULT_SPEED_KPH[w.cls] * (w.link ? 0.75 : 1);
      const make = (from: number, to: number, geom: LatLon[]): number => {
        const id = edges.length;
        edges.push({
          id, from, to, fromNode: vertices[from]!.node, toNode: vertices[to]!.node, way: w.id, cls: w.cls, link: w.link, name: w.name, lanes: w.lanes, oneway: w.oneway !== 0, roundabout: w.roundabout, lengthM,
          freeSpeedKph: speed, startBearing: endBearing(geom, false), endBearing: endBearing(geom, true),
          geometry: geom, control: null, controlInferred: false, destinationOnly: w.destinationOnly,
        });
        vertices[from]!.out.push(id);
        vertices[to]!.in.push(id);
        return id;
      };
      const fwd = w.oneway === -1 ? null : make(a, b, geometry);
      const bwd = w.oneway === 1 ? null : make(b, a, [...geometry].reverse());
      made.push({ fwd, bwd });
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      if (!neighbours.has(b)) neighbours.set(b, new Set());
      // Direction keyed by the neighbouring node id, so a two-way street counts once.
      neighbours.get(a)!.add(w.nodes[start + 1]!);
      neighbours.get(b)!.add(w.nodes[i - 1]!);
    }
    edgesOfWay.set(w.id, made);
  }
  for (const [v, set] of neighbours) vertices[v]!.degree = set.size;

  // Controls: each tagged node on the approaches (directed edges) it governs. A signal
  // outranks a stop outranks a yield if two tags reach one approach.
  const order: Control[] = ["give_way", "mini_roundabout", "stop", "all_way_stop", "signal"];
  for (const p of placeControls(data, pieces)) {
    const made = edgesOfWay.get(p.way)![p.piece]!;
    const e = edges[(p.forward ? made.fwd : made.bwd)!]!;
    if (e.control === null || order.indexOf(p.control) > order.indexOf(e.control)) e.control = p.control;
  }

  // Complexes: union junction vertices joined by a short edge.
  const parent = vertices.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const e of edges) {
    if (e.lengthM <= COMPLEX_LINK_M && vertices[e.from]!.degree >= 3 && vertices[e.to]!.degree >= 3) {
      parent[find(e.from)] = find(e.to);
    }
  }
  const complexOfRoot = new Map<number, number>();
  const complexes: Complex[] = [];
  vertices.forEach((v, i) => {
    const r = find(i);
    let c = complexOfRoot.get(r);
    if (c === undefined) {
      c = complexes.length;
      complexOfRoot.set(r, c);
      complexes.push({ id: c, vertices: [], majorRank: -1, majorName: "", signalized: false, allWay: false, surveyed: null });
    }
    v.complex = c;
    complexes[c]!.vertices.push(i);
  });
  for (const e of edges) {
    for (const vi of [e.from, e.to]) {
      const c = complexes[vertices[vi]!.complex]!;
      const rank = roadRank(e);
      if (rank > c.majorRank) { c.majorRank = rank; c.majorName = e.name; }
      else if (rank === c.majorRank && e.name && !c.majorName.split(" / ").includes(e.name) && c.majorName.split(" / ").length < 2)
        c.majorName = c.majorName ? `${c.majorName} / ${e.name}` : e.name;
    }
    if (e.control === "signal") complexes[vertices[e.to]!.complex]!.signalized = true;
    if (e.control === "all_way_stop") complexes[vertices[e.to]!.complex]!.allWay = true;
  }

  // A street carries on through an intersection when two or more of its physical arms meet
  // it. A two-way arm is identified by the first point of road beyond the junction, so its in
  // and out edges are one arm, and two arms of a loop reaching one far junction are two. A
  // one-way carriageway is identified by where it comes from or goes, so the two halves of a
  // divided road that rejoin beyond the junction are one arm.
  const armKey = (e: Edge, arriving: boolean) => {
    if (e.oneway) return `v${arriving ? e.from : e.to}`;
    const p = arriving ? e.geometry[e.geometry.length - 2]! : e.geometry[1]!;
    return `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  };
  const carriesOn = (cx: number, key: string): boolean => {
    if (!key) return false;
    const arms = new Set<string>();
    for (const vi of complexes[cx]!.vertices) {
      for (const ai of vertices[vi]!.in) { const a = edges[ai]!; if (vertices[a.from]!.complex !== cx && streetKey(a.name) === key) arms.add(armKey(a, true)); }
      for (const ai of vertices[vi]!.out) { const a = edges[ai]!; if (vertices[a.to]!.complex !== cx && streetKey(a.name) === key) arms.add(armKey(a, false)); }
    }
    return arms.size >= 2;
  };
  // Which approaches a surveyed side-street stop or yield governs. The lesser road, or a
  // street that ends here. Where equal streets both carry on, a stop or yield sign mapped in
  // OSM on one of those streets says which; with none, the survey cannot say, so all of them
  // are governed, as assumed. Only signs mapped in OSM count (`osmControl`, taken before any
  // survey or inference), and only approach signs: a signal or all-way stop says nothing
  // about which street has priority.
  const sideStreet = (cx: number, e: Edge): { governed: boolean; assumed: boolean } => {
    const c = complexes[cx]!;
    if (roadRank(e) < c.majorRank) return { governed: true, assumed: false };
    const key = streetKey(e.name);
    if (!carriesOn(cx, key)) return { governed: true, assumed: false };
    const contenders = new Set<string>([key]);
    for (const vi of c.vertices) for (const ai of vertices[vi]!.in) {
      const a = edges[ai]!, k = streetKey(a.name);
      if (vertices[a.from]!.complex !== cx && roadRank(a) === c.majorRank && carriesOn(cx, k)) contenders.add(k);
    }
    if (contenders.size === 1) return { governed: false, assumed: false };
    const signed = new Set<string>();
    for (const vi of c.vertices) for (const ai of vertices[vi]!.in) {
      const a = edges[ai]!, k = streetKey(a.name), sign = osmControl[ai];
      if (vertices[a.from]!.complex !== cx && contenders.has(k) && (sign === "stop" || sign === "give_way")) signed.add(k);
    }
    if (signed.size > 0) return { governed: signed.has(key), assumed: false };
    return { governed: true, assumed: true };
  };

  const complexHasFreeway = complexes.map(() => false);
  for (const e of edges) {
    if (!e.link && (e.cls === "motorway" || e.cls === "trunk")) complexHasFreeway[vertices[e.to]!.complex] = true;
  }

  // Surveyed controls: each point to the junction that names the most of its streets, then
  // the nearest. Two surveys landing on one intersection: the stronger control holds.
  const streetsAt = (vi: number) => new Set([...vertices[vi]!.in, ...vertices[vi]!.out].map((ei) => streetKey(edges[ei]!.name)));
  const cell = (lat: number, lon: number) => `${Math.round(lat * 500)}:${Math.round(lon * 500)}`; // ~200 m cells
  const junctionsByCell = new Map<string, number[]>();
  vertices.forEach((v, i) => {
    if (v.degree < 3) return;
    const k = cell(v.lat, v.lon);
    junctionsByCell.set(k, [...(junctionsByCell.get(k) ?? []), i]);
  });
  const STRENGTH: ControlPoint["control"][] = ["none", "give_way", "stop", "all_way_stop", "signal"];
  for (const p of data.controlPoints ?? []) {
    let best = -1, bestScore = 0, bestD = Infinity;
    const [la, lo] = [Math.round(p.lat * 500), Math.round(p.lon * 500)];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const vi of junctionsByCell.get(`${la + dy}:${lo + dx}`) ?? []) {
        const d = distance(p, vertices[vi]!);
        if (d > SURVEY_REACH_M) continue;
        const here = streetsAt(vi);
        const score = p.streets.filter((s) => here.has(s)).length;
        if (score > bestScore || (score === bestScore && score > 0 && d < bestD)) { best = vi; bestScore = score; bestD = d; }
      }
    }
    if (best < 0) continue;
    const c = complexes[vertices[best]!.complex]!;
    if (c.surveyed === null || STRENGTH.indexOf(p.control) > STRENGTH.indexOf(c.surveyed)) c.surveyed = p.control;
  }

  // Untagged approaches into a junction: a survey says, or infer and say so.
  const osmControl = edges.map((e) => e.control);
  for (const e of edges) {
    if (e.control !== null) continue;
    const to = vertices[e.to]!;
    if (to.degree < 3) continue;
    // Entering a roundabout: yield to the traffic already circulating.
    if (!e.roundabout && to.out.some((o) => edges[o]!.roundabout)) { e.control = "give_way"; e.controlInferred = true; continue; }
    const from = vertices[e.from]!;
    if (from.complex === to.complex) continue; // inside an intersection: charged on entry
    const c = complexes[to.complex]!;
    if (c.surveyed !== null) {
      switch (c.surveyed) {
        case "signal": e.control = "signal"; break;
        case "all_way_stop": e.control = "all_way_stop"; break;
        case "stop":
        case "give_way": {
          const side = sideStreet(c.id, e);
          if (side.governed) { e.control = c.surveyed; e.controlInferred = side.assumed; }
          break;
        }
        case "none": break;
      }
      continue;
    }
    if (c.signalized) { e.control = "signal"; e.controlInferred = true; continue; }
    if (c.allWay) { e.control = "all_way_stop"; e.controlInferred = true; continue; }
    const rank = roadRank(e);
    // A ramp onto a freeway or expressway merges in its own lane: no control.
    if (e.link && complexHasFreeway[to.complex]) continue;
    if (rank < c.majorRank) {
      // US convention: the lesser road stops; a ramp onto a surface street yields.
      e.control = e.link ? "give_way" : "stop";
      e.controlInferred = true;
    }
  }

  const restrictions = new Map<string, { kind: "no" | "only"; toWays: Set<number> }>();
  for (const r of data.restrictions) {
    // An "only" onto a road this extract does not hold (cut off at the area's edge, or left
    // out of a long area) would forbid every way out: it is dropped, not obeyed.
    if (r.kind === "only") {
      const v = vertexOfNode.get(r.viaNode);
      if (v === undefined || !vertices[v]!.out.some((e) => edges[e]!.way === r.toWay)) continue;
    }
    const key = `${r.fromWay}:${r.viaNode}`;
    const cur = restrictions.get(key);
    if (cur && cur.kind === r.kind) cur.toWays.add(r.toWay);
    else if (!cur || r.kind === "only") restrictions.set(key, { kind: r.kind, toWays: new Set([r.toWay]) });
  }

  return { vertices, edges, complexes, vertexOfNode, restrictions };
}

/** May a vehicle on `inEdge` continue onto `outEdge`? */
export function movementAllowed(g: Graph, inEdge: Edge, outEdge: Edge): boolean {
  const v = g.vertices[inEdge.to]!;
  if (outEdge.from !== inEdge.to) return false;
  // No U-turn back down the same piece, not even at a dead end: drivers do not turn round in
  // a cul-de-sac to dodge a turn, and no trip needs to (one starting there can leave either way).
  if (outEdge.to === inEdge.from && outEdge.way === inEdge.way) return false;
  const r = g.restrictions.get(`${inEdge.way}:${v.node}`);
  if (!r) return true;
  if (r.kind === "only") return r.toWays.has(outEdge.way);
  if (!r.toWays.has(outEdge.way)) return true;
  // A "no" whose from and to are the same way (no_u_turn) forbids turning back along
  // it, not carrying on along it.
  if (outEdge.way === inEdge.way) return Math.abs(turnAngle(inEdge.endBearing, outEdge.startBearing)) <= 150;
  return false;
}

/**
 * The road a moving car is on: the nearest edge within `maxM` whose direction agrees with the
 * car's heading (within 60°), so a two-way street gives the carriageway it is driving, not the
 * one back. With no heading, the nearest edge. -1 when no road is that near.
 */
export function edgeUnder(g: Graph, p: LatLon, headingDeg: number | null, maxM = 50): number {
  let best = -1, bestD = Infinity;
  g.edges.forEach((e, i) => {
    for (let k = 1; k < e.geometry.length; k++) {
      const a = e.geometry[k - 1]!, b = e.geometry[k]!;
      const d = projectOnSegment(p, a, b).distance;
      if (d > maxM || d >= bestD) continue;
      if (headingDeg !== null && Math.abs(turnAngle(bearing(a, b), headingDeg)) > 60) continue;
      bestD = d; best = i;
    }
  });
  return best;
}

/** Nearest vertex to a point among those a car can leave and reach (degree ≥ 1, not a motorway). */
export function nearestVertex(g: Graph, p: LatLon): number {
  // The address is on the nearest road a car can use (not a freeway); the trip starts or
  // ends at that road's nearer end. Snapping to the nearest junction instead can put a
  // house on the cross street round the corner.
  let bestEdge = -1, bestD = Infinity;
  g.edges.forEach((e, i) => {
    if (e.cls === "motorway" || e.cls === "trunk" || e.link) return;
    for (let k = 1; k < e.geometry.length; k++) {
      const d = projectOnSegment(p, e.geometry[k - 1]!, e.geometry[k]!).distance;
      if (d < bestD) { bestD = d; bestEdge = i; }
    }
  });
  if (bestEdge < 0) return -1;
  const e = g.edges[bestEdge]!;
  const usable = (vi: number) => g.vertices[vi]!.out.length > 0 && g.vertices[vi]!.in.length > 0;
  const [a, b] = [e.from, e.to];
  if (!usable(a)) return b;
  if (!usable(b)) return a;
  return distance(p, g.vertices[a]!) <= distance(p, g.vertices[b]!) ? a : b;
}

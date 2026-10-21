// The route planner, ported to the typed subset Static Hermes compiles with `shermes -typed`.
// A measurement port of engine/src (plan() and everything it reaches, plus pack decoding,
// buildGraph, nearestVertex, viaNames and planTrip's result), not shipped code. The arithmetic keeps the
// TypeScript's order, so every result is the same number.
//
// The syntax is the overlap of Flow (what -typed parses) and TypeScript (so esbuild and Node
// can strip it): class fields, `as` casts, `T[]`, `T | null` on objects only.
//
// The tuned port: port.js with the hot path's builtins and allocations replaced by typed code
// that gives the same numbers: number-keyed hash tables for MovementStats' Maps, restrictions
// looked up by edge, per-search arrays reused, results through scratch fields instead of a new
// object per call, no Math.min/max calls. Bit operations and Math functions go through the
// PRIMS block, which ffi.py swaps for C (tuned-ffi.js).
'use strict';
(function main() {

const PI: number = Math.PI;
const INF: number = Infinity;

// PRIMS-BEGIN: JS's operators and Math functions, as functions ffi.py can swap for C.
function xor32(a: number, b: number): number { return a ^ b; }
function or32(a: number, b: number): number { return a | b; }
function ushr(a: number, b: number): number { return a >>> b; }
function shr(a: number, b: number): number { return a >> b; }
function imul(a: number, b: number): number { return Math.imul(a, b); }
function exp(x: number): number { return Math.exp(x); }
function expm1(x: number): number { return Math.expm1(x); }
function log(x: number): number { return Math.log(x); }
function cos(x: number): number { return Math.cos(x); }
function floor(x: number): number { return Math.floor(x); }
function pow(x: number, y: number): number { return x ** y; }
// PRIMS-END

// Math.min and Math.max of two numbers that are never NaN here (and where a zero's sign
// does not matter): no call.
function min2(a: number, b: number): number { return a < b ? a : b; }
function max2(a: number, b: number): number { return a > b ? a : b; }

// ---------------------------------------------------------------- geo.ts

class LatLon {
  lat: number;
  lon: number;
  constructor(lat: number, lon: number) { this.lat = lat; this.lon = lon; }
}

const R: number = 6371008.8;
function rad(d: number): number { return (d * PI) / 180; }

function distance(a: LatLon, b: LatLon): number {
  const dLat: number = rad(b.lat - a.lat);
  const dLon: number = rad(b.lon - a.lon);
  const h: number = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(a: LatLon, b: LatLon): number {
  const y: number = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x: number =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / PI + 360) % 360;
}

function turnAngle(inBearing: number, outBearing: number): number {
  let d: number = (outBearing - inBearing) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** projectOnSegment's distance (nearestVertex reads only that). */
function segmentDistance(p: LatLon, a: LatLon, b: LatLon): number {
  const k: number = Math.cos(rad((a.lat + b.lat) / 2));
  const ax: number = a.lon * k, ay: number = a.lat, bx: number = b.lon * k, by: number = b.lat, px: number = p.lon * k, py: number = p.lat;
  const dx: number = bx - ax, dy: number = by - ay;
  const len2: number = dx * dx + dy * dy;
  const t: number = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return distance(p, new LatLon(a.lat + t * (b.lat - a.lat), a.lon + t * (b.lon - a.lon)));
}

// ---------------------------------------------------------------- random.ts

class Rng {
  s: number;
  constructor(seed: number) {
    const s: number = ushr(seed, 0) || 0x9e3779b9;
    this.s = s;
  }
  next(): number {
    // mulberry32
    this.s = ushr(this.s + 0x6d2b79f5, 0);
    let t: number = this.s;
    t = imul(xor32(t, ushr(t, 15)), or32(t, 1));
    t = xor32(t, t + imul(xor32(t, ushr(t, 7)), or32(t, 61)));
    return ushr(xor32(t, ushr(t, 14)), 0) / 4294967296;
  }
  uniform(a: number, b: number): number { return a + (b - a) * this.next(); }
  exponential(rate: number): number { return -log(1 - this.next()) / rate; }
  normal(): number {
    const u: number = 1 - this.next(), v: number = this.next();
    return Math.sqrt(-2 * log(u)) * cos(2 * PI * v);
  }
  geometric(p: number): number {
    if (p <= 0) return 0;
    return floor(log(1 - this.next()) / log(p));
  }
}

const DIGITS: number[] = [];
/** h folded over the decimal digits of a non-negative integer, as `${x}` writes them. */
function hashDigits(h0: number, x0: number): number {
  let h: number = h0, x: number = x0, n: number = 0;
  do {
    const d: number = x % 10;
    if (n === DIGITS.length) DIGITS.push(d); else DIGITS[n] = d;
    n++;
    x = (x - d) / 10;
  } while (x > 0);
  for (let i = n - 1; i >= 0; i--) h = imul(xor32(h, 48 + DIGITS[i]), 16777619);
  return h;
}
/** hash(`${a}>${b}`). */
function hashPair(a: number, b: number): number {
  let h: number = hashDigits(2166136261, a);
  h = imul(xor32(h, 62), 16777619);
  return ushr(hashDigits(h, b), 0);
}

function hash(str: string): number {
  const s: any = str;
  const len: number = s.length;
  let h: number = 2166136261;
  for (let i = 0; i < len; i++) {
    const c: number = s.charCodeAt(i);
    h = Math.imul(h ^ c, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- osm.ts (what the graph reads)

// Road classes by index: ROAD_CLASSES' order.
const ROAD_CLASSES: string[] = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street"];
const CLASS_RANK: number[] = [7, 6, 5, 4, 3, 2, 1, 0];
function classIndex(cls: string): number {
  for (let i = 0; i < ROAD_CLASSES.length; i++) if (ROAD_CLASSES[i] === cls) return i;
  return -1;
}

class WayRec {
  id: number;
  cls: string;
  clsIdx: number;
  link: boolean;
  name: string;
  oneway: number;
  /** 0: none (the pack's 0 is TypeScript's null). */
  lanes: number;
  maxspeedKph: number;
  roundabout: boolean;
  destinationOnly: boolean;
  nodes: number[];
  constructor(id: number, cls: string, link: boolean, name: string, oneway: number, lanes: number, maxspeedKph: number,
    roundabout: boolean, destinationOnly: boolean, nodes: number[]) {
    this.id = id; this.cls = cls; this.clsIdx = classIndex(cls); this.link = link; this.name = name; this.oneway = oneway;
    this.lanes = lanes; this.maxspeedKph = maxspeedKph; this.roundabout = roundabout; this.destinationOnly = destinationOnly; this.nodes = nodes;
  }
}

class NodeRec extends LatLon {
  id: number;
  /** "" for none. */
  control: string;
  controlDirection: string;
  constructor(id: number, lat: number, lon: number, control: string, controlDirection: string) {
    super(lat, lon);
    this.id = id; this.control = control; this.controlDirection = controlDirection;
  }
}

class Restriction {
  fromWay: number;
  viaNode: number;
  toWay: number;
  kind: string;
  constructor(fromWay: number, viaNode: number, toWay: number, kind: string) {
    this.fromWay = fromWay; this.viaNode = viaNode; this.toWay = toWay; this.kind = kind;
  }
}

class ControlPoint extends LatLon {
  streets: string[];
  control: string;
  constructor(lat: number, lon: number, streets: string[], control: string) {
    super(lat, lon);
    this.streets = streets; this.control = control;
  }
}

class RoadData {
  ways: WayRec[];
  nodes: NodeRec[];
  restrictions: Restriction[];
  controlPoints: ControlPoint[];
  constructor(ways: WayRec[], nodes: NodeRec[], restrictions: Restriction[], controlPoints: ControlPoint[]) {
    this.ways = ways; this.nodes = nodes; this.restrictions = restrictions; this.controlPoints = controlPoints;
  }
}

const STREET_SUFFIXES: any = new Set();
const SUFFIX_LIST: string[] = [
  "AV", "AVE", "AVENUE", "DR", "DRIVE", "ST", "STREET", "RD", "ROAD", "LN", "LANE", "WY", "WAY", "CT", "COURT",
  "BL", "BLVD", "BOULEVARD", "PL", "PLACE", "EX", "EXPY", "EXPRESSWAY", "CR", "CIR", "CIRCLE", "TER", "TERRACE",
  "PKWY", "PY", "PARKWAY", "HWY", "HIGHWAY", "LOOP", "SQ", "SQUARE", "TR", "TRL", "TRAIL",
];
for (let i = 0; i < SUFFIX_LIST.length; i++) STREET_SUFFIXES.add(SUFFIX_LIST[i]);
const COMPASS: any = new Set();
const COMPASS_LIST: string[] = ["N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST"];
for (let i = 0; i < COMPASS_LIST.length; i++) COMPASS.add(COMPASS_LIST[i]);

function streetKey(name: string): string {
  const n: any = name;
  const words: any = n.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  while (words.length > 1 && COMPASS.has(words[0])) words.shift();
  while (words.length > 1 && STREET_SUFFIXES.has(words[words.length - 1])) words.pop();
  const out: string = words.join(" ");
  return out;
}

// ---------------------------------------------------------------- pack.ts (decoding)

const SURVEYED: string[] = ["none", "stop", "all_way_stop", "signal", "give_way"];
const CONTROLS: string[] = ["signal", "stop", "all_way_stop", "give_way", "mini_roundabout"];
const DIRECTIONS: string[] = ["forward", "backward", "both"];

function fromPack(p: any): RoadData {
  const ways: WayRec[] = [];
  const pw: any = p.ways, names: any = p.names;
  for (let i = 0; i < pw.length; i++) {
    const w: any = pw[i];
    const nameAt: any = names[w[3]];
    const name: string = nameAt === undefined ? "" : nameAt;
    const ids: number[] = [];
    for (let j = 8; j < w.length; j++) ids.push(w[j]);
    const flags: number = w[7];
    ways.push(new WayRec(w[0], w[1], w[2] === 1, name, w[4], w[5], w[6], (flags & 1) !== 0, (flags & 2) !== 0, ids));
  }
  const nodes: NodeRec[] = [];
  const pn: any = p.nodes;
  const nn: number = pn.length;
  for (let i = 0; i < nn; i += 5) {
    const c: number = pn[i + 3], d: number = pn[i + 4];
    const lat: number = pn[i + 1], lon: number = pn[i + 2];
    nodes.push(new NodeRec(pn[i], lat / 1e7, lon / 1e7, c ? CONTROLS[c - 1] : "", d ? DIRECTIONS[d - 1] : ""));
  }
  const restrictions: Restriction[] = [];
  const pr: any = p.restrictions;
  for (let i = 0; i < pr.length; i += 4)
    restrictions.push(new Restriction(pr[i], pr[i + 1], pr[i + 2], pr[i + 3] ? "only" : "no"));
  const cps: ControlPoint[] = [];
  const pc: any = p.controlPoints;
  if (pc) {
    for (let i = 0; i < pc.length; i++) {
      const c: any = pc[i];
      const streets: string[] = [];
      for (let j = 3; j < c.length; j++) streets.push(c[j]);
      const lat: number = c[0], lon: number = c[1];
      cps.push(new ControlPoint(lat / 1e7, lon / 1e7, streets, SURVEYED[c[2]]));
    }
  }
  return new RoadData(ways, nodes, restrictions, cps);
}

// ---------------------------------------------------------------- traffic.ts

const PEAK_VPH: number[] = [3600, 1500, 950, 700, 420, 160, 45, 10];
const DEFAULT_LANES_PER_DIR: number[] = [3, 2, 2, 2, 1, 1, 1, 1];
const LANE_CAPACITY: number[] = [1900, 1500, 1100, 1000, 850, 700, 600, 400];
// BPR: the freeway fit on motorway and trunk, the arterial one elsewhere.
const BPR_ALPHA: number[] = [0.83, 0.83, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15];
const BPR_BETA: number[] = [5.5, 5.5, 4, 4, 4, 4, 4, 4];

const PROFILE_M: number[] = [0, 300, 360, 405, 420, 435, 450, 465, 475, 495, 510, 540, 600, 720, 900, 1020, 1080, 1200, 1320, 1440];
const PROFILE_F: number[] = [0.06, 0.12, 0.35, 0.55, 0.68, 0.8, 0.9, 0.97, 1.0, 1.0, 0.9, 0.78, 0.65, 0.75, 0.88, 1.0, 0.9, 0.5, 0.25, 0.06];
const AT: number[] = [], SHARE: number[] = [], D_SHARE: number[] = [], D_MINUTE: number[] = [];
for (let i = 0; i < PROFILE_M.length; i++) {
  AT.push(PROFILE_M[i]);
  SHARE.push(PROFILE_F[i]);
  D_SHARE.push(i ? PROFILE_F[i] - PROFILE_F[i - 1] : 0);
  D_MINUTE.push(i ? PROFILE_M[i] - PROFILE_M[i - 1] : 0);
}

function demandShare(minuteOfDay: number): number {
  const m: number = ((minuteOfDay % 1440) + 1440) % 1440;
  for (let i = 1; i < AT.length; i++) {
    if (m <= AT[i]) return SHARE[i - 1] + (D_SHARE[i] * (m - AT[i - 1])) / D_MINUTE[i];
  }
  return SHARE[SHARE.length - 1];
}

class Calibration {
  volumeScale: number;
  speedScale: number;
  daySigma: number;
  edgeSigma: number;
  peakExponent: number;
  leftTurnShare: number;
  // Read once per edge (termsOf): left as the JSON they come in.
  classVolume: any;
  classSpeed: any;
  wayVolume: any;
  stretches: any;
  /** stretchOf's index ("fromNode>toNode@way" → stretch), built on first use. */
  stretchIndex: any;
  /**
   * wayVolume as a Map, built on first use: Hermes interns the key of every obj[string]
   * lookup as an identifier (an old-generation allocation), and termsOf makes one per edge.
   */
  wayVolumeMap: any;
  constructor() {
    this.volumeScale = 1; this.speedScale = 1; this.daySigma = 0.15; this.edgeSigma = 0.1; this.peakExponent = 1; this.leftTurnShare = 0.15;
    this.classVolume = {}; this.classSpeed = {}; this.wayVolume = {}; this.stretches = {}; this.stretchIndex = null; this.wayVolumeMap = null;
  }
}
const DEFAULT_CALIBRATION: Calibration = new Calibration();

/** { ...DEFAULT_CALIBRATION, ...partial }. */
function withCalibration(pc: any): Calibration {
  const c: Calibration = new Calibration();
  if (pc.volumeScale !== undefined) c.volumeScale = pc.volumeScale;
  if (pc.speedScale !== undefined) c.speedScale = pc.speedScale;
  if (pc.daySigma !== undefined) c.daySigma = pc.daySigma;
  if (pc.edgeSigma !== undefined) c.edgeSigma = pc.edgeSigma;
  if (pc.peakExponent !== undefined) c.peakExponent = pc.peakExponent;
  if (pc.leftTurnShare !== undefined) c.leftTurnShare = pc.leftTurnShare;
  if (pc.classVolume !== undefined) c.classVolume = pc.classVolume;
  if (pc.classSpeed !== undefined) c.classSpeed = pc.classSpeed;
  if (pc.wayVolume !== undefined) c.wayVolume = pc.wayVolume;
  if (pc.stretches !== undefined) c.stretches = pc.stretches;
  return c;
}

class EdgeTerms {
  cal: Calibration;
  base: number;
  t0: number;
  cap: number;
  spread: number;
  classVolume: number;
  wayVolume: number;
  stretchVolume: number;
  alpha: number;
  beta: number;
  constructor(cal: Calibration, base: number, classVolume: number, wayVolume: number, t0: number, cap: number, alpha: number, beta: number,
    stretchVolume: number, spread: number) {
    this.cal = cal; this.base = base; this.t0 = t0; this.cap = cap; this.spread = spread; this.classVolume = classVolume;
    this.wayVolume = wayVolume; this.stretchVolume = stretchVolume; this.alpha = alpha; this.beta = beta;
  }
}

function lanesPerDirection(e: Edge): number {
  if (e.lanes === 0) return DEFAULT_LANES_PER_DIR[e.clsIdx];
  return Math.max(1, e.oneway ? e.lanes : Math.ceil(e.lanes / 2));
}

/** The stretch an edge is on under a calibration, or null. */
function stretchOf(e: Edge, cal: Calibration): any {
  let index: any = cal.stretchIndex;
  if (!index) {
    index = new Map();
    const ss: any = Object.values(cal.stretches ? cal.stretches : {});
    for (let k = 0; k < ss.length; k++) {
      const s: any = ss[k];
      for (let i = 1; i < s.nodes.length; i++) index.set(`${s.nodes[i - 1]}>${s.nodes[i]}@${s.ways[i - 1]}`, s);
    }
    cal.stretchIndex = index;
  }
  if (!index.size) return null;
  const s: any = index.get(`${e.fromNode}>${e.toNode}@${e.way}`);
  return s === undefined ? null : s;
}

function orOne(v: any): number {
  if (v === undefined || v === null) return 1;
  const n: number = v;
  return n;
}

/** cal.wayVolume[String(way)] ?? 1, through a Map of wayVolume's own keys. */
function wayVolumeOf(cal: Calibration, way: number): number {
  let m: any = cal.wayVolumeMap;
  if (!m) {
    m = new Map();
    const wv: any = cal.wayVolume, keys: any = Object.keys(wv);
    for (let i = 0; i < keys.length; i++) m.set(keys[i], wv[keys[i]]);
    cal.wayVolumeMap = m;
  }
  return m.size ? orOne(m.get(String(way))) : 1;
}

function termsOf(e: Edge, cal: Calibration): EdgeTerms {
  const t: EdgeTerms | null = e.terms;
  if (t !== null && t.cal === cal) return t;
  const stretch: any = stretchOf(e, cal);
  const lanes: number = lanesPerDirection(e);
  const laneFactor: number = lanes / DEFAULT_LANES_PER_DIR[e.clsIdx];
  const cv: any = cal.classVolume, cs: any = cal.classSpeed;
  const nt: EdgeTerms = new EdgeTerms(
    cal,
    PEAK_VPH[e.clsIdx] * (e.link ? 0.4 : 1) * Math.min(2, Math.max(0.5, laneFactor)),
    orOne(cv ? cv[e.cls] : undefined),
    wayVolumeOf(cal, e.way),
    e.lengthM / ((e.freeSpeedKph * cal.speedScale * orOne(cs ? cs[e.cls] : undefined)) / 3.6),
    LANE_CAPACITY[e.clsIdx] * lanes,
    BPR_ALPHA[e.clsIdx], BPR_BETA[e.clsIdx],
    stretch ? orOne(stretch.volume) : 1,
    stretch ? orOne(stretch.spread) : 1,
  );
  e.terms = nt;
  return nt;
}

// The last minute's demand, raised to the peak exponent: fields of one object, as a store to a
// closure variable is a runtime call.
class DemandMemo {
  minute: number;
  exponent: number;
  demand: number;
  constructor() { this.minute = NaN; this.exponent = NaN; this.demand = 0; }
}
const MEMO: DemandMemo = new DemandMemo();

function edgeVolume(e: Edge, minuteOfDay: number, cal: Calibration): number {
  const t: EdgeTerms = termsOf(e, cal);
  const memo: DemandMemo = MEMO;
  if (minuteOfDay !== memo.minute || cal.peakExponent !== memo.exponent) {
    memo.demand = pow(demandShare(minuteOfDay), cal.peakExponent);
    memo.minute = minuteOfDay;
    memo.exponent = cal.peakExponent;
  }
  return t.base * memo.demand * cal.volumeScale * t.classVolume * t.wayVolume * t.stretchVolume;
}

function edgeDayFactor(e: Edge, cal: Calibration, dayFactor: number): number {
  const s: number = termsOf(e, cal).spread;
  return s === 1 ? dayFactor : pow(dayFactor, s);
}

function freeFlowTime(e: Edge, cal: Calibration): number {
  return termsOf(e, cal).t0;
}

function runningTime(e: Edge, minuteOfDay: number, cal: Calibration, dayFactor: number): number {
  const t: EdgeTerms = termsOf(e, cal);
  const vc: number = (edgeVolume(e, minuteOfDay, cal) * edgeDayFactor(e, cal, dayFactor)) / t.cap;
  return t.t0 * (1 + t.alpha * pow(vc, t.beta));
}

// ---------------------------------------------------------------- graph.ts

class Edge {
  to: number;
  from: number;
  way: number;
  terms: EdgeTerms | null;
  destinationOnly: boolean;
  id: number;
  fromNode: number;
  toNode: number;
  cls: string;
  clsIdx: number;
  link: boolean;
  name: string;
  lanes: number;
  oneway: boolean;
  roundabout: boolean;
  lengthM: number;
  freeSpeedKph: number;
  startBearing: number;
  endBearing: number;
  geometry: LatLon[];
  /** "" for none. */
  control: string;
  controlInferred: boolean;
  /** lanesPerDirection(this), worked out once. */
  lanesDir: number;
  /** The turn restriction at this edge's end (from this way, via the vertex): an index into Graph.restrs, or -1. */
  restr: number;
  constructor(id: number, from: number, to: number, fromNode: number, toNode: number, w: WayRec, lengthM: number, freeSpeedKph: number,
    startBearing: number, endBearing: number, geometry: LatLon[]) {
    this.to = to; this.from = from; this.way = w.id; this.terms = null; this.destinationOnly = w.destinationOnly;
    this.id = id; this.fromNode = fromNode; this.toNode = toNode; this.cls = w.cls; this.clsIdx = w.clsIdx; this.link = w.link;
    this.name = w.name; this.lanes = w.lanes; this.oneway = w.oneway !== 0; this.roundabout = w.roundabout; this.lengthM = lengthM;
    this.freeSpeedKph = freeSpeedKph; this.startBearing = startBearing; this.endBearing = endBearing; this.geometry = geometry;
    this.control = ""; this.controlInferred = false;
    this.lanesDir = 0; this.restr = -1;
    this.lanesDir = lanesPerDirection(this);
  }
}

class Vertex extends LatLon {
  out: number[];
  in: number[];
  complex: number;
  node: number;
  degree: number;
  constructor(node: number, lat: number, lon: number) {
    super(lat, lon);
    this.out = []; this.in = []; this.complex = -1; this.node = node; this.degree = 0;
  }
}

class Complex {
  id: number;
  vertices: number[];
  majorRank: number;
  majorName: string;
  signalized: boolean;
  allWay: boolean;
  /** "" for none. */
  surveyed: string;
  constructor(id: number) {
    this.id = id; this.vertices = []; this.majorRank = -1; this.majorName = ""; this.signalized = false; this.allWay = false; this.surveyed = "";
  }
}

class Restr {
  kind: string;
  toWays: any;
  constructor(kind: string, toWays: any) { this.kind = kind; this.toWays = toWays; }
}

/** A restriction as movementAllowed reads it: "only" or "no", onto these ways. */
class EdgeRestr {
  only: boolean;
  toWays: number[];
  constructor(only: boolean, toWays: number[]) { this.only = only; this.toWays = toWays; }
}

function hasWay(ways: number[], w: number): boolean {
  for (let i = 0; i < ways.length; i++) if (ways[i] === w) return true;
  return false;
}

class Graph {
  vertices: Vertex[];
  edges: Edge[];
  complexes: Complex[];
  vertexOfNode: any;
  restrictions: any;
  /** freeFlowTo's searches: calibration → (destination → FreeFlow). */
  freeFlow: any;
  /** Edge.restr's targets. */
  restrs: EdgeRestr[];
  /** shortestPath's arrays, one per edge, reset at the start of each search. */
  cost: number[];
  clock: number[];
  prev: number[];
  done: number[];
  constructor(vertices: Vertex[], edges: Edge[], complexes: Complex[], vertexOfNode: any, restrictions: any) {
    this.vertices = vertices; this.edges = edges; this.complexes = complexes; this.vertexOfNode = vertexOfNode;
    this.restrictions = restrictions; this.freeFlow = new Map();
    this.restrs = [];
    const n: number = edges.length;
    this.cost = filled(n, INF); this.clock = filled(n, 0); this.prev = filled(n, -1); this.done = filled(n, 0);
    // Each edge's restriction, looked up once by the key movementAllowed builds.
    const index: any = new Map();
    for (let ei = 0; ei < n; ei++) {
      const e: Edge = edges[ei];
      const key: string = `${e.way}:${vertices[e.to].node}`;
      const got: any = restrictions.get(key);
      if (!got) continue;
      const known: any = index.get(key);
      if (known !== undefined) { e.restr = known; continue; }
      const r: Restr = got;
      const ways: number[] = [];
      r.toWays.forEach((w: any): void => { ways.push(w); });
      e.restr = this.restrs.length;
      index.set(key, e.restr);
      this.restrs.push(new EdgeRestr(r.kind === "only", ways));
    }
  }
}

const DEFAULT_SPEED_KPH: number[] = [105, 80, 64, 56, 48, 40, 40, 15];

function roadRank(e: Edge): number {
  return e.link ? 1.5 : CLASS_RANK[e.clsIdx];
}

const CONTROL_REACH_M: number = 60;
const SURVEY_REACH_M: number = 35;
const COMPLEX_LINK_M: number = 30;

function endBearing(points: LatLon[], fromEnd: boolean): number {
  const pts: LatLon[] = fromEnd ? reversed(points) : points;
  const a: LatLon = pts[0];
  let b: LatLon = pts[1];
  let acc: number = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += distance(pts[i - 1], pts[i]);
    b = pts[i];
    if (acc >= 20) break;
  }
  return fromEnd ? bearing(b, a) : bearing(a, b);
}

function reversed(xs: LatLon[]): LatLon[] {
  const out: LatLon[] = [];
  for (let i = xs.length - 1; i >= 0; i--) out.push(xs[i]);
  return out;
}

class WayPiece {
  startIdx: number;
  endIdx: number;
  lengthM: number;
  constructor(startIdx: number, endIdx: number, lengthM: number) { this.startIdx = startIdx; this.endIdx = endIdx; this.lengthM = lengthM; }
}

function nodeMap(data: RoadData): any {
  const nodes: any = new Map();
  for (let i = 0; i < data.nodes.length; i++) nodes.set(data.nodes[i].id, data.nodes[i]);
  return nodes;
}

function nodeAt(nodes: any, id: number): NodeRec {
  const n: NodeRec = nodes.get(id);
  return n;
}

function wayPieces(data: RoadData): any {
  const nodes: any = nodeMap(data);
  const uses: any = new Map();
  for (let wi = 0; wi < data.ways.length; wi++) {
    const w: WayRec = data.ways[wi];
    for (let i = 0; i < w.nodes.length; i++) {
      const n: number = w.nodes[i];
      const end: boolean = i === 0 || i === w.nodes.length - 1;
      const u: any = uses.get(n);
      const prev: number = u === undefined ? 0 : u;
      uses.set(n, prev + (end ? 1 : 2));
    }
  }
  const out: any = new Map();
  for (let wi = 0; wi < data.ways.length; wi++) {
    const w: WayRec = data.ways[wi];
    let all: boolean = true;
    for (let i = 0; i < w.nodes.length; i++) if (!nodes.has(w.nodes[i])) { all = false; break; }
    if (!all) continue;
    const pieces: WayPiece[] = [];
    let start: number = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      const u: any = uses.get(w.nodes[i]);
      const used: number = u === undefined ? 0 : u;
      const isVertex: boolean = i === 0 || i === w.nodes.length - 1 || used > 2;
      if (!isVertex) continue;
      let lengthM: number = 0;
      for (let k = start + 1; k <= i; k++) lengthM += distance(nodeAt(nodes, w.nodes[k - 1]), nodeAt(nodes, w.nodes[k]));
      if (!(w.nodes[start] === w.nodes[i] && lengthM < 1)) pieces.push(new WayPiece(start, i, lengthM));
      start = i;
    }
    out.set(w.id, pieces);
  }
  return out;
}

class ControlPlacement {
  way: number;
  piece: number;
  forward: boolean;
  at: number;
  control: string;
  node: number;
  constructor(way: number, piece: number, forward: boolean, at: number, control: string, node: number) {
    this.way = way; this.piece = piece; this.forward = forward; this.at = at; this.control = control; this.node = node;
  }
}

function placeControls(data: RoadData, pieces: any): ControlPlacement[] {
  const nodes: any = nodeMap(data);
  const out: ControlPlacement[] = [];
  for (let wi = 0; wi < data.ways.length; wi++) {
    const w: WayRec = data.ways[wi];
    const psAny: any = pieces.get(w.id);
    if (!psAny) continue;
    const ps: WayPiece[] = psAny;
    const place = (piece: number, forward: boolean, control: string, node: number): void => {
      if (w.oneway === (forward ? -1 : 1)) return;
      const p: WayPiece = ps[piece];
      out.push(new ControlPlacement(w.id, piece, forward, w.nodes[forward ? p.endIdx : p.startIdx], control, node));
    };
    for (let idx = 0; idx < w.nodes.length; idx++) {
      const nodeId: number = w.nodes[idx];
      const n: NodeRec = nodeAt(nodes, nodeId);
      const control: string = n.control;
      if (control === "") continue;
      for (let k = 0; k < ps.length; k++) {
        const p: WayPiece = ps[k];
        if (idx < p.startIdx || idx > p.endIdx) continue;
        let toEnd: number = 0, toStart: number = 0;
        for (let j = idx; j < p.endIdx; j++) toEnd += distance(nodeAt(nodes, w.nodes[j]), nodeAt(nodes, w.nodes[j + 1]));
        for (let j = p.startIdx; j < idx; j++) toStart += distance(nodeAt(nodes, w.nodes[j]), nodeAt(nodes, w.nodes[j + 1]));
        const dir: string = n.controlDirection;
        const atVertex: boolean = idx === p.startIdx || idx === p.endIdx;
        if (atVertex && dir === "" && control !== "stop" && control !== "give_way") {
          if (idx === p.endIdx) place(k, true, control, nodeId);
          if (idx === p.startIdx) place(k, false, control, nodeId);
          continue;
        }
        const forward: boolean = dir === "forward" || dir === "both" || (dir === "" && toEnd <= toStart);
        const backward: boolean = dir === "backward" || dir === "both" || (dir === "" && toStart < toEnd);
        if (forward && toEnd <= CONTROL_REACH_M && idx !== p.startIdx) place(k, true, control, nodeId);
        if (backward && toStart <= CONTROL_REACH_M && idx !== p.endIdx) place(k, false, control, nodeId);
        if (control === "signal" && dir === "" && !atVertex) {
          if (toEnd <= CONTROL_REACH_M) place(k, true, "signal", nodeId);
          if (toStart <= CONTROL_REACH_M) place(k, false, "signal", nodeId);
        }
      }
    }
  }
  return out;
}

class Made {
  fwd: number;
  bwd: number;
  constructor(fwd: number, bwd: number) { this.fwd = fwd; this.bwd = bwd; }
}

const CONTROL_ORDER: string[] = ["give_way", "mini_roundabout", "stop", "all_way_stop", "signal"];
const STRENGTH: string[] = ["none", "give_way", "stop", "all_way_stop", "signal"];
function indexIn(xs: string[], x: string): number {
  for (let i = 0; i < xs.length; i++) if (xs[i] === x) return i;
  return -1;
}

class Side {
  governed: boolean;
  assumed: boolean;
  constructor(governed: boolean, assumed: boolean) { this.governed = governed; this.assumed = assumed; }
}

function buildGraph(data: RoadData): Graph {
  const nodes: any = nodeMap(data);
  const vertices: Vertex[] = [];
  const vertexOfNode: any = new Map();
  const vertexFor = (id: number): number => {
    const got: any = vertexOfNode.get(id);
    if (got === undefined) {
      const n: NodeRec = nodeAt(nodes, id);
      const v: number = vertices.length;
      vertices.push(new Vertex(id, n.lat, n.lon));
      vertexOfNode.set(id, v);
      return v;
    }
    const v: number = got;
    return v;
  };

  const edges: Edge[] = [];
  const pieces: any = wayPieces(data);
  const edgesOfWay: any = new Map();
  const neighbours: any = new Map();

  for (let wi = 0; wi < data.ways.length; wi++) {
    const w: WayRec = data.ways[wi];
    const psAny: any = pieces.get(w.id);
    if (!psAny) continue;
    const ps: WayPiece[] = psAny;
    if (w.nodes.length > 1) vertexFor(w.nodes[0]);
    const made: Made[] = [];
    for (let pi = 0; pi < ps.length; pi++) {
      const start: number = ps[pi].startIdx, i: number = ps[pi].endIdx, lengthM: number = ps[pi].lengthM;
      const ids: number[] = [];
      for (let j = start; j < i + 1; j++) ids.push(w.nodes[j]);
      const geometry: LatLon[] = [];
      for (let j = 0; j < ids.length; j++) { const n: NodeRec = nodeAt(nodes, ids[j]); geometry.push(new LatLon(n.lat, n.lon)); }
      const a: number = vertexFor(ids[0]), b: number = vertexFor(ids[ids.length - 1]);
      const speed: number = w.maxspeedKph !== 0 ? w.maxspeedKph : DEFAULT_SPEED_KPH[w.clsIdx] * (w.link ? 0.75 : 1);
      const make = (from: number, to: number, geom: LatLon[]): number => {
        const id: number = edges.length;
        edges.push(new Edge(id, from, to, vertices[from].node, vertices[to].node, w, lengthM, speed, endBearing(geom, false), endBearing(geom, true), geom));
        vertices[from].out.push(id);
        vertices[to].in.push(id);
        return id;
      };
      const fwd: number = w.oneway === -1 ? -1 : make(a, b, geometry);
      const bwd: number = w.oneway === 1 ? -1 : make(b, a, reversed(geometry));
      made.push(new Made(fwd, bwd));
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      if (!neighbours.has(b)) neighbours.set(b, new Set());
      neighbours.get(a).add(w.nodes[start + 1]);
      neighbours.get(b).add(w.nodes[i - 1]);
    }
    edgesOfWay.set(w.id, made);
  }
  neighbours.forEach((set: any, v: any): void => { const vi: number = v; vertices[vi].degree = set.size; });

  const placements: ControlPlacement[] = placeControls(data, pieces);
  for (let i = 0; i < placements.length; i++) {
    const p: ControlPlacement = placements[i];
    const madeOf: Made[] = edgesOfWay.get(p.way);
    const made: Made = madeOf[p.piece];
    const e: Edge = edges[p.forward ? made.fwd : made.bwd];
    if (e.control === "" || indexIn(CONTROL_ORDER, p.control) > indexIn(CONTROL_ORDER, e.control)) e.control = p.control;
  }

  const parent: number[] = [];
  for (let i = 0; i < vertices.length; i++) parent.push(i);
  function find(i: number): number {
    if (parent[i] === i) return i;
    const r: number = find(parent[i]);
    parent[i] = r;
    return r;
  }
  for (let ei = 0; ei < edges.length; ei++) {
    const e: Edge = edges[ei];
    if (e.lengthM <= COMPLEX_LINK_M && vertices[e.from].degree >= 3 && vertices[e.to].degree >= 3) {
      const ra: number = find(e.from);
      parent[ra] = find(e.to);
    }
  }
  const complexOfRoot: any = new Map();
  const complexes: Complex[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const v: Vertex = vertices[i];
    const r: number = find(i);
    const got: any = complexOfRoot.get(r);
    let c: number = 0;
    if (got === undefined) {
      c = complexes.length;
      complexOfRoot.set(r, c);
      complexes.push(new Complex(c));
    } else c = got;
    v.complex = c;
    complexes[c].vertices.push(i);
  }
  for (let ei = 0; ei < edges.length; ei++) {
    const e: Edge = edges[ei];
    for (let side = 0; side < 2; side++) {
      const vi: number = side === 0 ? e.from : e.to;
      const c: Complex = complexes[vertices[vi].complex];
      const rank: number = roadRank(e);
      if (rank > c.majorRank) { c.majorRank = rank; c.majorName = e.name; }
      else if (rank === c.majorRank && e.name !== "") {
        const mn: any = c.majorName;
        const parts: any = mn.split(" / ");
        if (!parts.includes(e.name) && parts.length < 2) c.majorName = c.majorName !== "" ? `${c.majorName} / ${e.name}` : e.name;
      }
    }
    if (e.control === "signal") complexes[vertices[e.to].complex].signalized = true;
    if (e.control === "all_way_stop") complexes[vertices[e.to].complex].allWay = true;
  }

  const armKey = (e: Edge, arriving: boolean): string => {
    if (e.oneway) return `v${arriving ? e.from : e.to}`;
    const p: LatLon = arriving ? e.geometry[e.geometry.length - 2] : e.geometry[1];
    const la: any = p.lat, lo: any = p.lon;
    return `${la.toFixed(7)},${lo.toFixed(7)}`;
  };
  const carriesOn = (cx: number, key: string): boolean => {
    if (key === "") return false;
    const arms: any = new Set();
    const cvs: number[] = complexes[cx].vertices;
    for (let q = 0; q < cvs.length; q++) {
      const vi: number = cvs[q];
      const ins: number[] = vertices[vi].in, outs: number[] = vertices[vi].out;
      for (let j = 0; j < ins.length; j++) { const a: Edge = edges[ins[j]]; if (vertices[a.from].complex !== cx && streetKey(a.name) === key) arms.add(armKey(a, true)); }
      for (let j = 0; j < outs.length; j++) { const a: Edge = edges[outs[j]]; if (vertices[a.to].complex !== cx && streetKey(a.name) === key) arms.add(armKey(a, false)); }
    }
    return arms.size >= 2;
  };
  const osmControl: string[] = [];
  const sideStreet = (cx: number, e: Edge): Side => {
    const c: Complex = complexes[cx];
    if (roadRank(e) < c.majorRank) return new Side(true, false);
    const key: string = streetKey(e.name);
    if (!carriesOn(cx, key)) return new Side(true, false);
    const contenders: any = new Set();
    contenders.add(key);
    for (let q = 0; q < c.vertices.length; q++) {
      const ins: number[] = vertices[c.vertices[q]].in;
      for (let j = 0; j < ins.length; j++) {
        const a: Edge = edges[ins[j]], k: string = streetKey(a.name);
        if (vertices[a.from].complex !== cx && roadRank(a) === c.majorRank && carriesOn(cx, k)) contenders.add(k);
      }
    }
    if (contenders.size === 1) return new Side(false, false);
    const signed: any = new Set();
    for (let q = 0; q < c.vertices.length; q++) {
      const ins: number[] = vertices[c.vertices[q]].in;
      for (let j = 0; j < ins.length; j++) {
        const ai: number = ins[j];
        const a: Edge = edges[ai], k: string = streetKey(a.name), sign: string = osmControl[ai];
        if (vertices[a.from].complex !== cx && contenders.has(k) && (sign === "stop" || sign === "give_way")) signed.add(k);
      }
    }
    if (signed.size > 0) return new Side(signed.has(key), false);
    return new Side(true, true);
  };

  const complexHasFreeway: boolean[] = [];
  for (let i = 0; i < complexes.length; i++) complexHasFreeway.push(false);
  for (let ei = 0; ei < edges.length; ei++) {
    const e: Edge = edges[ei];
    if (!e.link && (e.cls === "motorway" || e.cls === "trunk")) complexHasFreeway[vertices[e.to].complex] = true;
  }

  const streetsAt = (vi: number): any => {
    const s: any = new Set();
    const ins: number[] = vertices[vi].in, outs: number[] = vertices[vi].out;
    for (let j = 0; j < ins.length; j++) s.add(streetKey(edges[ins[j]].name));
    for (let j = 0; j < outs.length; j++) s.add(streetKey(edges[outs[j]].name));
    return s;
  };
  const junctionsByCell: any = new Map();
  for (let i = 0; i < vertices.length; i++) {
    const v: Vertex = vertices[i];
    if (v.degree < 3) continue;
    const k: string = `${Math.round(v.lat * 500)}:${Math.round(v.lon * 500)}`;
    const got: any = junctionsByCell.get(k);
    if (got === undefined) { const list: number[] = [i]; junctionsByCell.set(k, list); }
    else { const list: number[] = got; list.push(i); }
  }
  for (let pi = 0; pi < data.controlPoints.length; pi++) {
    const p: ControlPoint = data.controlPoints[pi];
    let best: number = -1, bestScore: number = 0, bestD: number = INF;
    const la: number = Math.round(p.lat * 500), lo: number = Math.round(p.lon * 500);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const got: any = junctionsByCell.get(`${la + dy}:${lo + dx}`);
      if (got === undefined) continue;
      const list: number[] = got;
      for (let j = 0; j < list.length; j++) {
        const vi: number = list[j];
        const d: number = distance(p, vertices[vi]);
        if (d > SURVEY_REACH_M) continue;
        const here: any = streetsAt(vi);
        let score: number = 0;
        for (let q = 0; q < p.streets.length; q++) if (here.has(p.streets[q])) score++;
        if (score > bestScore || (score === bestScore && score > 0 && d < bestD)) { best = vi; bestScore = score; bestD = d; }
      }
    }
    if (best < 0) continue;
    const c: Complex = complexes[vertices[best].complex];
    if (c.surveyed === "" || indexIn(STRENGTH, p.control) > indexIn(STRENGTH, c.surveyed)) c.surveyed = p.control;
  }

  for (let ei = 0; ei < edges.length; ei++) osmControl.push(edges[ei].control);
  for (let ei = 0; ei < edges.length; ei++) {
    const e: Edge = edges[ei];
    if (e.control !== "") continue;
    const to: Vertex = vertices[e.to];
    if (to.degree < 3) continue;
    let intoRoundabout: boolean = false;
    for (let j = 0; j < to.out.length; j++) if (edges[to.out[j]].roundabout) { intoRoundabout = true; break; }
    if (!e.roundabout && intoRoundabout) { e.control = "give_way"; e.controlInferred = true; continue; }
    const from: Vertex = vertices[e.from];
    if (from.complex === to.complex) continue;
    const c: Complex = complexes[to.complex];
    if (c.surveyed !== "") {
      if (c.surveyed === "signal") e.control = "signal";
      else if (c.surveyed === "all_way_stop") e.control = "all_way_stop";
      else if (c.surveyed === "stop" || c.surveyed === "give_way") {
        const side: Side = sideStreet(c.id, e);
        if (side.governed) { e.control = c.surveyed; e.controlInferred = side.assumed; }
      }
      continue;
    }
    if (c.signalized) { e.control = "signal"; e.controlInferred = true; continue; }
    if (c.allWay) { e.control = "all_way_stop"; e.controlInferred = true; continue; }
    const rank: number = roadRank(e);
    if (e.link && complexHasFreeway[to.complex]) continue;
    if (rank < c.majorRank) {
      e.control = e.link ? "give_way" : "stop";
      e.controlInferred = true;
    }
  }

  const restrictions: any = new Map();
  for (let ri = 0; ri < data.restrictions.length; ri++) {
    const r: Restriction = data.restrictions[ri];
    if (r.kind === "only") {
      const got: any = vertexOfNode.get(r.viaNode);
      if (got === undefined) continue;
      const v: number = got;
      let reaches: boolean = false;
      const outs: number[] = vertices[v].out;
      for (let j = 0; j < outs.length; j++) if (edges[outs[j]].way === r.toWay) { reaches = true; break; }
      if (!reaches) continue;
    }
    const key: string = `${r.fromWay}:${r.viaNode}`;
    const cur: any = restrictions.get(key);
    if (cur && cur.kind === r.kind) cur.toWays.add(r.toWay);
    else if (!cur || r.kind === "only") { const s: any = new Set(); s.add(r.toWay); restrictions.set(key, new Restr(r.kind, s)); }
  }

  return new Graph(vertices, edges, complexes, vertexOfNode, restrictions);
}

function movementAllowed(g: Graph, inEdge: Edge, outEdge: Edge): boolean {
  if (outEdge.from !== inEdge.to) return false;
  if (outEdge.to === inEdge.from && outEdge.way === inEdge.way) return false;
  if (inEdge.restr < 0) return true;
  const r: EdgeRestr = g.restrs[inEdge.restr];
  if (r.only) return hasWay(r.toWays, outEdge.way);
  if (!hasWay(r.toWays, outEdge.way)) return true;
  if (outEdge.way === inEdge.way) return Math.abs(turnAngle(inEdge.endBearing, outEdge.startBearing)) <= 150;
  return false;
}

function nearestVertex(g: Graph, p: LatLon): number {
  let bestEdge: number = -1, bestD: number = INF;
  for (let i = 0; i < g.edges.length; i++) {
    const e: Edge = g.edges[i];
    if (e.cls === "motorway" || e.cls === "trunk" || e.link) continue;
    for (let k = 1; k < e.geometry.length; k++) {
      const d: number = segmentDistance(p, e.geometry[k - 1], e.geometry[k]);
      if (d < bestD) { bestD = d; bestEdge = i; }
    }
  }
  if (bestEdge < 0) return -1;
  const e: Edge = g.edges[bestEdge];
  const a: number = e.from, b: number = e.to;
  const usableA: boolean = g.vertices[a].out.length > 0 && g.vertices[a].in.length > 0;
  const usableB: boolean = g.vertices[b].out.length > 0 && g.vertices[b].in.length > 0;
  if (!usableA) return b;
  if (!usableB) return a;
  return distance(p, g.vertices[a]) <= distance(p, g.vertices[b]) ? a : b;
}

// ---------------------------------------------------------------- intersection.ts

// Turns and movement controls by number on the hot path; their names for the words.
const T_STRAIGHT: number = 0, T_RIGHT: number = 1, T_LEFT: number = 2, T_UTURN: number = 3;
const TURN_NAMES: string[] = ["straight", "right", "left", "uturn"];
const TURN_LOSS: number[] = [0, 2.5, 3.5, 12];
const C_SIGNAL: number = 0, C_ALL_WAY: number = 1, C_STOP: number = 2, C_GIVE_WAY: number = 3, C_MAJOR_LEFT: number = 4,
  C_FREE: number = 5, C_INTERNAL: number = 6, C_NONE: number = 7;
const CONTROL_NAMES: string[] = ["signal", "all_way_stop", "stop", "give_way", "major_left", "free", "internal", "none"];

class Approach {
  edge: number;
  major: boolean;
  constructor(edge: number, major: boolean) { this.edge = edge; this.major = major; }
}

class Movement {
  inEdge: number;
  outEdge: number;
  complex: number;
  turnK: number;
  controlK: number;
  approaches: Approach[];
  majorLanes: number;
  inferred: boolean;
  crossName: string;
  constructor(inEdge: number, outEdge: number, complex: number, turnK: number, controlK: number, inferred: boolean,
    approaches: Approach[], crossName: string, majorLanes: number) {
    this.inEdge = inEdge; this.outEdge = outEdge; this.complex = complex; this.turnK = turnK; this.controlK = controlK;
    this.approaches = approaches; this.majorLanes = majorLanes; this.inferred = inferred; this.crossName = crossName;
  }
}

function turnOf(inEdge: Edge, outEdge: Edge): number {
  const a: number = turnAngle(inEdge.endBearing, outEdge.startBearing);
  if (Math.abs(a) > 150) return T_UTURN;
  if (a > 40) return T_RIGHT;
  if (a < -40) return T_LEFT;
  return T_STRAIGHT;
}

function describeMovement(g: Graph, inId: number, outId: number): Movement {
  const inEdge: Edge = g.edges[inId], outEdge: Edge = g.edges[outId];
  const v: Vertex = g.vertices[inEdge.to];
  const cx: Complex = g.complexes[v.complex];
  const internal: boolean = g.vertices[inEdge.from].complex === v.complex;
  const approaches: Approach[] = [];
  for (let q = 0; q < cx.vertices.length; q++) {
    const ins: number[] = g.vertices[cx.vertices[q]].in;
    for (let j = 0; j < ins.length; j++) {
      const ei: number = ins[j];
      const e: Edge = g.edges[ei];
      if (g.vertices[e.from].complex === v.complex) continue;
      approaches.push(new Approach(ei, roadRank(e) >= cx.majorRank - 0.5));
    }
  }
  const turn: number = turnOf(inEdge, outEdge);
  let majorEdge: number = -1;
  for (let j = 0; j < approaches.length; j++) if (approaches[j].major) { majorEdge = approaches[j].edge; break; }
  const crossName: string = outEdge.name !== inEdge.name && outEdge.name !== "" ? outEdge.name : cx.majorName;
  const majorLanes: number = majorEdge >= 0 ? lanesPerDirection(g.edges[majorEdge]) : 1;
  let control: number = C_FREE;
  const ic: string = inEdge.control;
  if (v.degree < 3) control = C_NONE;
  else if (internal) control = C_INTERNAL;
  else if (ic === "signal") control = C_SIGNAL;
  else if (ic === "all_way_stop") control = C_ALL_WAY;
  else if (ic === "stop") control = C_STOP;
  else if (ic === "give_way" || ic === "mini_roundabout") control = C_GIVE_WAY;
  else if (turn === T_LEFT && roadRank(inEdge) >= cx.majorRank - 0.5 && approaches.length > 2) control = C_MAJOR_LEFT;
  else control = C_FREE;
  return new Movement(inId, outId, v.complex, turn, control, inEdge.controlInferred, approaches, crossName, majorLanes);
}

// HCM-style critical headway and follow-up time by kind: right, straight, left.
const GAP_TC: number[] = [6.2, 6.5, 7.1];
const GAP_TF: number[] = [3.3, 4.0, 3.5];

function gapCapacity(vc: number, tc: number, tf: number): number {
  if (vc < 1e-6) return 3600 / tf;
  const q: number = vc / 3600;
  return (vc * exp(-q * tc)) / -expm1(-q * tf);
}

function sampleGapWait(vph: number, tc: number, rng: Rng): number {
  if (vph < 1) return 0;
  const rate: number = vph / 3600;
  let t: number = 0;
  for (let i = 0; i < 400; i++) {
    const gap: number = rng.exponential(rate);
    if (gap >= tc) return t;
    t += gap;
  }
  return t;
}

/**
 * What the TypeScript returns as small objects (flows' three flows, sampleQueue's queue,
 * sampleDelay's overflow), written to one object's fields instead.
 */
class Out {
  conflict: number;
  approach: number;
  total: number;
  queueOverflow: boolean;
  overflow: boolean;
  constructor() { this.conflict = 0; this.approach = 0; this.total = 0; this.queueOverflow = false; this.overflow = false; }
}
const OUT: Out = new Out();

function flows(g: Graph, m: Movement, minuteOfDay: number, dayFactor: number, cal: Calibration, out: Out): void {
  const inEdge: Edge = g.edges[m.inEdge];
  const own: number = edgeVolume(inEdge, minuteOfDay, cal) * edgeDayFactor(inEdge, cal, dayFactor);
  let majorOthers: number = 0, total: number = 0;
  const aps: Approach[] = m.approaches;
  for (let j = 0; j < aps.length; j++) {
    const a: Approach = aps[j];
    const ae: Edge = g.edges[a.edge];
    const v: number = edgeVolume(ae, minuteOfDay, cal) * edgeDayFactor(ae, cal, dayFactor);
    total += v;
    if (a.major && a.edge !== m.inEdge) majorOthers += v;
  }
  let conflict: number = 0;
  if (m.controlK === C_MAJOR_LEFT) conflict = majorOthers;
  else if (m.turnK === T_RIGHT) conflict = majorOthers * 0.5;
  else conflict = majorOthers;
  out.conflict = conflict; out.approach = own; out.total = total;
}

const MAX_MOVEMENT_DELAY_S: number = 900;
const MIN_CAPACITY_VPH: number = 60;
const STOP_LOSS: number = 5;

/** The queue's length; whether it overflowed goes to out.queueOverflow. */
function sampleQueue(rho: number, capacityVph: number, rng: Rng, out: Out): number {
  const r: number = min2(rho, 0.95);
  const n: number = rng.geometric(r);
  out.queueOverflow = false;
  if (rho <= 0.95) return n;
  const extra: number = ((rho - 0.95) * capacityVph * rng.uniform(0, 1200)) / 3600;
  out.queueOverflow = true;
  return n + Math.round(extra);
}

/** sampleDelay's seconds; its overflow goes to out.overflow. */
function sampleDelay(g: Graph, m: Movement, minuteOfDay: number, dayFactor: number, cal: Calibration, rng: Rng, out: Out): number {
  const turnLoss: number = TURN_LOSS[m.turnK];
  const control: number = m.controlK;
  out.overflow = false;
  if (control === C_NONE || control === C_INTERNAL) return turnLoss;
  if (control === C_FREE) return turnLoss + (m.turnK === T_STRAIGHT ? 0 : 0.5);
  if (control === C_MAJOR_LEFT) {
    flows(g, m, minuteOfDay, dayFactor, cal, out);
    const wait: number = sampleGapWait(out.conflict, 4.1, rng);
    return turnLoss + wait + (wait > 0 ? 2 : 0);
  }
  if (control === C_STOP || control === C_GIVE_WAY) {
    flows(g, m, minuteOfDay, dayFactor, cal, out);
    const kind: number = m.turnK === T_RIGHT ? 0 : m.turnK === T_STRAIGHT ? 1 : 2;
    const wide: number = m.majorLanes >= 2 && kind !== 0 ? 0.7 : 0;
    const yieldOnly: boolean = control === C_GIVE_WAY;
    const tc: number = GAP_TC[kind] + wide - (yieldOnly ? 0.8 : 0);
    const tf: number = GAP_TF[kind];
    const cap: number = max2(MIN_CAPACITY_VPH, gapCapacity(out.conflict, tc, tf));
    const conflict: number = out.conflict;
    const qn: number = sampleQueue(out.approach / cap, cap, rng, out);
    let t: number = 0;
    for (let i = 0; i < qn; i++) t += rng.exponential(cap / 3600);
    t += sampleGapWait(conflict, tc, rng);
    t += yieldOnly && t < 1 ? 1.5 : STOP_LOSS;
    out.overflow = out.queueOverflow;
    return min2(MAX_MOVEMENT_DELAY_S, t + turnLoss);
  }
  if (control === C_ALL_WAY) {
    flows(g, m, minuteOfDay, dayFactor, cal, out);
    const hSat: number = 4.0 + (m.turnK === T_LEFT ? 0.4 : m.turnK === T_RIGHT ? -0.4 : 0);
    const rhoAll: number = (out.total * hSat) / 3600;
    const cap: number = 3600 / hSat / max2(1, m.approaches.length / 2);
    const qn: number = sampleQueue(max2(rhoAll, out.approach / cap), cap, rng, out);
    let t: number = STOP_LOSS;
    for (let i = 0; i < qn; i++) t += rng.uniform(0.6, 1.4) * hSat * min2(2, 1 + rhoAll);
    if (rng.next() < min2(0.9, rhoAll)) t += rng.uniform(1, hSat);
    out.overflow = out.queueOverflow;
    return min2(MAX_MOVEMENT_DELAY_S, t + turnLoss);
  }
  // signal
  flows(g, m, minuteOfDay, dayFactor, cal, out);
  const cx: Complex = g.complexes[m.complex];
  const cycle: number = cx.majorRank >= 5 ? 130 : cx.majorRank >= 4 ? 110 : cx.majorRank >= 3 ? 90 : 70;
  let onMajor: boolean = false;
  const aps: Approach[] = m.approaches;
  for (let j = 0; j < aps.length; j++) if (aps[j].edge === m.inEdge) { onMajor = aps[j].major; break; }
  let gShare: number = onMajor ? 0.55 : 0.3;
  if (m.turnK === T_LEFT) gShare = onMajor ? 0.14 : 0.12;
  const green: number = gShare * cycle, red: number = cycle - green;
  const left: boolean = m.turnK === T_LEFT;
  const lanes: number = left ? 1 : g.edges[m.inEdge].lanesDir;
  const demand: number = out.approach * (left ? cal.leftTurnShare : 1 - cal.leftTurnShare);
  const x: number = demand / (1800 * lanes * gShare);
  const progressed: boolean = onMajor && m.turnK === T_STRAIGHT && rng.next() < 0.3;
  const arrival: number = progressed ? rng.uniform(0, green) : rng.uniform(0, cycle);
  let t: number = 0;
  if (arrival >= green) {
    const waitRed: number = cycle - arrival;
    const ahead: number = (demand / lanes / 3600) * (arrival - green);
    t = waitRed + 2 * ahead + 2 + STOP_LOSS;
  }
  const missP: number = max2(0, min2(0.9, (x - 0.8) / 0.4));
  let overflow: boolean = false;
  while (rng.next() < missP && t < cycle * 4) { t += red + (t === 0 ? STOP_LOSS : 0); overflow = x > 1; }
  out.overflow = overflow;
  return t + turnLoss;
}

function shortName(n: string): string {
  const s: any = n;
  const out: string = s.replace(/\bAvenue\b/, "Ave").replace(/\bExpressway\b/, "Expy").replace(/\bBoulevard\b/, "Blvd")
    .replace(/\bLane\b/, "Ln").replace(/\bRoad\b/, "Rd").replace(/\bStreet\b/, "St").replace(/\bDrive\b/, "Dr");
  return out;
}

function nameControl(m: Movement): string {
  const at: string = shortName(m.crossName !== "" ? m.crossName : "cross street");
  const turn: string = m.turnK === T_LEFT ? " (left)" : "";
  const c: number = m.controlK;
  if (c === C_SIGNAL) return `Signal at ${at}${turn}`;
  if (c === C_ALL_WAY) return `All-way stop at ${at}`;
  if (c === C_STOP) return `Stop at ${at}${turn}`;
  if (c === C_GIVE_WAY) return `Yield at ${at}`;
  if (c === C_MAJOR_LEFT) return `Left onto ${at}`;
  return m.turnK === T_STRAIGHT ? at : `${m.turnK === T_LEFT ? "Left" : "Right"} onto ${at}`;
}

function explainControl(m: Movement): string {
  const cross: string = m.crossName !== "" ? m.crossName : "the cross street";
  const c: number = m.controlK;
  if (c === C_SIGNAL) return `signal at ${cross}${m.turnK === T_LEFT ? " (left turn)" : ""}`;
  if (c === C_ALL_WAY) return `all-way stop at ${cross}`;
  if (c === C_STOP)
    return `${m.turnK === T_LEFT ? "left onto" : m.turnK === T_RIGHT ? "right onto" : "cross"} ${cross} from a stop sign${m.inferred ? " (assumed)" : ""}`;
  if (c === C_GIVE_WAY) return `yield to ${cross}${m.inferred ? " (assumed)" : ""}`;
  if (c === C_MAJOR_LEFT) return `left across oncoming traffic onto ${cross}`;
  return m.turnK === T_STRAIGHT ? `through ${cross}` : `${TURN_NAMES[m.turnK]} onto ${cross}`;
}

// ---------------------------------------------------------------- router.ts

class Route {
  edges: number[];
  lengthM: number;
  constructor(edges: number[], lengthM: number) { this.edges = edges; this.lengthM = lengthM; }
}

const STATS_SAMPLES: number = 48;

class Stat {
  mean: number;
  sd: number;
  constructor(mean: number, sd: number) { this.mean = mean; this.sd = sd; }
}

// Table sizes for IdxMap: primes, about doubling.
const PRIMES: number[] = [4093, 8191, 16381, 32749, 65521, 131071, 262139, 524287, 1048573, 2097143, 4194301, 8388593,
  16777213, 33554393, 67108859, 134217689];

/**
 * A hash table from non-negative integer keys to non-negative integers (indices into a typed
 * array), in typed code: what MovementStats' Maps were. Open addressing, linear probing, keys
 * hashed by remainder modulo a prime (the % of two numbers is a C fmod, not a runtime call).
 */
class IdxMap {
  keys: number[];
  vals: number[];
  size: number;
  cap: number;
  prime: number;
  constructor() { this.prime = 0; this.cap = PRIMES[0]; this.keys = filled(this.cap, -1); this.vals = filled(this.cap, -1); this.size = 0; }
  get(key: number): number {
    const keys: number[] = this.keys, cap: number = this.cap;
    let i: number = key % cap;
    let k: number = keys[i];
    while (k !== key) {
      if (k === -1) return -1;
      i++;
      if (i === cap) i = 0;
      k = keys[i];
    }
    return this.vals[i];
  }
  /** key must not be in the table. */
  add(key: number, val: number): void {
    if (2 * (this.size + 1) > this.cap) this.grow();
    this.insert(key, val);
    this.size++;
  }
  insert(key: number, val: number): void {
    const keys: number[] = this.keys, cap: number = this.cap;
    let i: number = key % cap;
    while (keys[i] !== -1) { i++; if (i === cap) i = 0; }
    keys[i] = key; this.vals[i] = val;
  }
  grow(): void {
    const oldKeys: number[] = this.keys, oldVals: number[] = this.vals;
    this.prime++;
    this.cap = PRIMES[this.prime];
    this.keys = filled(this.cap, -1); this.vals = filled(this.cap, -1);
    for (let i = 0; i < oldKeys.length; i++) if (oldKeys[i] !== -1) this.insert(oldKeys[i], oldVals[i]);
  }
}

class MovementStats {
  /** (in edge × edge count + out edge) → index into movementList. */
  movements: IdxMap;
  movementList: Movement[];
  /** ((in edge × edge count + out edge) × 4096 + bucket / 5) → index into statList. */
  stats: IdxMap;
  statList: Stat[];
  g: Graph;
  cal: Calibration;
  constructor(g: Graph, cal: Calibration) {
    this.movements = new IdxMap();
    this.movementList = [];
    this.stats = new IdxMap();
    this.statList = [];
    this.g = g;
    this.cal = cal;
  }

  movement(inId: number, outId: number): Movement {
    const key: number = inId * this.g.edges.length + outId;
    const at: number = this.movements.get(key);
    if (at >= 0) return this.movementList[at];
    const m: Movement = describeMovement(this.g, inId, outId);
    this.movements.add(key, this.movementList.length);
    this.movementList.push(m);
    return m;
  }

  delay(inId: number, outId: number, minuteOfDay: number): Stat {
    const bucket: number = floor(minuteOfDay / 5) * 5;
    const pair: number = inId * this.g.edges.length + outId;
    const key: number = pair * 4096 + bucket / 5; // buckets 0 to 4095: minutes below 20480
    const at: number = this.stats.get(key);
    if (at >= 0) return this.statList[at];
    const m: Movement = this.movement(inId, outId);
    const r: Rng = new Rng(hashPair(inId, outId));
    const cal: Calibration = this.cal, g: Graph = this.g, out: Out = OUT;
    let sum: number = 0, sum2: number = 0;
    for (let i = 0; i < STATS_SAMPLES; i++) {
      const dayFactor: number = exp(cal.daySigma * r.normal());
      const d: number = sampleDelay(g, m, bucket + 2.5, dayFactor, cal, r, out);
      sum += d; sum2 += d * d;
    }
    const mean: number = sum / STATS_SAMPLES;
    const s: Stat = new Stat(mean, Math.sqrt(max2(0, sum2 / STATS_SAMPLES - mean * mean)));
    this.stats.add(key, this.statList.length);
    this.statList.push(s);
    return s;
  }
}

const CAP_SPEED_MS: number = 40;

// Typed arrays have no pop: the heap keeps its own size and reuses the slots past it.
// pop returns the value and leaves its key in topKey (the TypeScript returns a pair).
class Heap {
  k: number[];
  v: number[];
  n: number;
  topKey: number;
  constructor() { this.k = []; this.v = []; this.n = 0; this.topKey = 0; }
  size(): number { return this.n; }
  clear(): void { this.n = 0; }
  push(key: number, val: number): void {
    const k: number[] = this.k, v: number[] = this.v;
    let i: number = this.n;
    if (i === k.length) { k.push(key); v.push(val); } else { k[i] = key; v[i] = val; }
    this.n = i + 1;
    while (i > 0) {
      const p: number = shr(i - 1, 1);
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k: number[] = this.k, v: number[] = this.v;
    this.topKey = k[0];
    const top: number = v[0];
    const n: number = this.n - 1;
    const lk: number = k[n], lv: number = v[n];
    this.n = n;
    if (n) {
      let i: number = 0;
      for (;;) {
        const l: number = 2 * i + 1, r: number = l + 1;
        let m: number = i, mk: number = lk;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

class FreeFlow {
  dist: number[];
  done: number[];
  open: Heap;
  reach: number;
  constructor(n: number) {
    const dist: number[] = [], done: number[] = [];
    for (let i = 0; i < n; i++) { dist.push(INF); done.push(0); }
    this.dist = dist; this.done = done; this.open = new Heap(); this.reach = 0;
  }
}

function freeFlowTo(g: Graph, cal: Calibration, to: number, from: number): FreeFlow {
  let byTo: any = g.freeFlow.get(cal);
  if (!byTo) { byTo = new Map(); g.freeFlow.set(cal, byTo); }
  let fa: any = byTo.get(to);
  if (!fa) {
    const nf: FreeFlow = new FreeFlow(g.vertices.length);
    nf.dist[to] = 0;
    nf.open.push(0, to);
    if (byTo.size >= 4) byTo.delete(byTo.keys().next().value);
    byTo.set(to, nf);
    fa = nf;
  }
  const f: FreeFlow = fa;
  const dist: number[] = f.dist, done: number[] = f.done, open: Heap = f.open;
  const cap: number = (4 * distance(g.vertices[from], g.vertices[to])) / CAP_SPEED_MS + 600;
  for (;;) {
    const enough: number = min2(cap, done[from] ? max2(2 * dist[from], dist[from] + 60) : INF);
    if (!(open.size() && f.reach < enough)) break;
    const v: number = open.pop();
    const d: number = open.topKey;
    if (done[v]) continue;
    done[v] = 1;
    f.reach = d;
    const ins: number[] = g.vertices[v].in;
    for (let j = 0; j < ins.length; j++) {
      const e: Edge = g.edges[ins[j]];
      const nd: number = d + freeFlowTime(e, cal);
      if (nd < dist[e.from]) { dist[e.from] = nd; open.push(nd, e.from); }
    }
  }
  if (!open.size()) f.reach = INF;
  return f;
}

/** The FreeFlow's lower bound at vertex v: what the TypeScript's returned closure gives. */
function toGo(f: FreeFlow, v: number): number {
  return f.done[v] ? f.dist[v] : f.reach;
}

function beatenCost(control: number): number {
  if (control === C_SIGNAL) return 15;
  if (control === C_ALL_WAY) return 8;
  if (control === C_STOP) return 6;
  if (control === C_GIVE_WAY) return 2;
  return 0;
}

class SearchOptions {
  departMinute: number;
  risk: number;
  cal: Calibration;
  beaten: boolean;
  /** The cost factor of each edge (alternatives), or empty for none: 1 everywhere. */
  penalty: number[];
  constructor(departMinute: number, risk: number, cal: Calibration, beaten: boolean, penalty: number[]) {
    this.departMinute = departMinute; this.risk = risk; this.cal = cal; this.beaten = beaten; this.penalty = penalty;
  }
}

function filled(n: number, x: number): number[] {
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(x);
  return a;
}

/** The running time edgeCost last worked out (the TypeScript returns it with the weighted cost). */
class CostOut {
  run: number;
  constructor() { this.run = 0; }
}
const COST: CostOut = new CostOut();

function edgeCost(g: Graph, o: SearchOptions, endWays: number[], ei: number, t: number, out: CostOut): number {
  const e: Edge = g.edges[ei];
  const run: number = runningTime(e, o.departMinute + t / 60, o.cal, 1);
  const destPenalty: number = e.destinationOnly && !hasWay(endWays, e.way) ? 120 : 0;
  const factor: number = o.penalty.length ? o.penalty[ei] : 1;
  out.run = run;
  return run * factor + destPenalty;
}

function shortestPath(g: Graph, stats: MovementStats, from: number, to: number, o: SearchOptions): Route | null {
  if (from === to) { const none: number[] = []; return new Route(none, 0); }
  const n: number = g.edges.length;
  const cost: number[] = g.cost, clock: number[] = g.clock, prev: number[] = g.prev, done: number[] = g.done;
  for (let i = 0; i < n; i++) { cost[i] = INF; clock[i] = 0; prev[i] = -1; done[i] = 0; }
  const open: Heap = new Heap();
  const target: Vertex = g.vertices[to];
  const endWays: number[] = [];
  const fv: Vertex = g.vertices[from];
  const lists: number[][] = [fv.out, fv.in, target.in, target.out];
  for (let q = 0; q < lists.length; q++) for (let j = 0; j < lists[q].length; j++) {
    const w: number = g.edges[lists[q][j]].way;
    if (!hasWay(endWays, w)) endWays.push(w);
  }
  const ff: FreeFlow = freeFlowTo(g, o.cal, to, from);
  const out: CostOut = COST;
  const starts: number[] = fv.out;
  for (let si = 0; si < starts.length; si++) {
    const ei: number = starts[si];
    const weighted: number = edgeCost(g, o, endWays, ei, 0, out);
    cost[ei] = weighted; clock[ei] = out.run;
    open.push(weighted + toGo(ff, g.edges[ei].to), ei);
  }
  let best: number = -1;
  while (open.size()) {
    const ei: number = open.pop();
    if (done[ei]) continue;
    done[ei] = 1;
    const e: Edge = g.edges[ei];
    if (e.to === to) { best = ei; break; }
    const outs: number[] = g.vertices[e.to].out;
    for (let oi = 0; oi < outs.length; oi++) {
      const fi: number = outs[oi];
      if (done[fi]) continue;
      const f: Edge = g.edges[fi];
      if (!movementAllowed(g, e, f)) continue;
      const tArrive: number = clock[ei];
      let delay: number = 0, weightedDelay: number = 0;
      if (o.beaten) {
        const m: Movement = stats.movement(ei, fi);
        delay = m.controlK === C_INTERNAL ? 0 : beatenCost(m.controlK);
        weightedDelay = delay;
      } else {
        const d: Stat = stats.delay(ei, fi, o.departMinute + tArrive / 60);
        delay = d.mean;
        weightedDelay = d.mean + o.risk * d.sd;
      }
      const weighted: number = edgeCost(g, o, endWays, fi, tArrive + delay, out);
      const nc: number = cost[ei] + weightedDelay + weighted;
      if (nc < cost[fi]) {
        cost[fi] = nc;
        clock[fi] = tArrive + delay + out.run;
        prev[fi] = ei;
        open.push(nc + toGo(ff, f.to), fi);
      }
    }
  }
  if (best < 0) return null;
  const back: number[] = [];
  for (let ei = best; ei >= 0; ei = prev[ei]) back.push(ei);
  const edges: number[] = [];
  for (let i = back.length - 1; i >= 0; i--) edges.push(back[i]);
  let lengthM: number = 0;
  for (let i = 0; i < edges.length; i++) lengthM = lengthM + g.edges[edges[i]].lengthM;
  return new Route(edges, lengthM);
}

function overlap(g: Graph, a: Route, b: Route): number {
  const inB: any = new Set();
  for (let i = 0; i < b.edges.length; i++) { const e: Edge = g.edges[b.edges[i]]; inB.add(`${e.way}:${e.from}`); }
  let shared: number = 0;
  for (let i = 0; i < a.edges.length; i++) { const e: Edge = g.edges[a.edges[i]]; if (inB.has(`${e.way}:${e.from}`)) shared += e.lengthM; }
  return a.lengthM ? shared / a.lengthM : 0;
}

function alternatives(g: Graph, stats: MovementStats, from: number, to: number, o: SearchOptions, k: number, maxOverlap: number): Route[] {
  const kept: Route[] = [];
  const penalty: number[] = filled(g.edges.length, 1);
  for (let attempt = 0; attempt < k * 3 && kept.length < k; attempt++) {
    const found: Route | null = shortestPath(g, stats, from, to, new SearchOptions(o.departMinute, o.risk, o.cal, o.beaten, penalty));
    if (found === null) break;
    const r: Route = found;
    if (r.edges.length === 0) { const only: Route[] = [r]; return only; }
    let distinct: boolean = true;
    for (let i = 0; i < kept.length; i++) {
      const x: Route = kept[i];
      if (!(overlap(g, r, x) < maxOverlap && overlap(g, x, r) < maxOverlap)) { distinct = false; break; }
    }
    if (distinct) kept.push(r);
    for (let i = 0; i < r.edges.length; i++) {
      const ei: number = r.edges[i];
      penalty[ei] = penalty[ei] * 1.35;
    }
  }
  return kept;
}

// ---------------------------------------------------------------- simulate.ts

class SimOptions {
  runs: number;
  seed: number;
  cal: Calibration;
  endOverheadSec: number;
  constructor(runs: number, seed: number, cal: Calibration) { this.runs = runs; this.seed = seed; this.cal = cal; this.endOverheadSec = 0; }
}

class Hotspot {
  complex: number;
  lat: number;
  lon: number;
  what: string;
  name: string;
  control: string;
  inferred: boolean;
  meanSec: number;
  p50Sec: number;
  p90Sec: number;
  overflowShare: number;
  constructor(complex: number, lat: number, lon: number, what: string, name: string, control: string, inferred: boolean,
    meanSec: number, p50Sec: number, p90Sec: number, overflowShare: number) {
    this.complex = complex; this.lat = lat; this.lon = lon; this.what = what; this.name = name; this.control = control;
    this.inferred = inferred; this.meanSec = meanSec; this.p50Sec = p50Sec; this.p90Sec = p90Sec; this.overflowShare = overflowShare;
  }
}

class SimResult {
  departMinute: number;
  samples: number[];
  meanSec: number;
  p10Sec: number;
  p50Sec: number;
  p90Sec: number;
  p95Sec: number;
  runningMeanSec: number;
  junctionMeanSec: number;
  hotspots: Hotspot[];
  constructor(departMinute: number, samples: number[], meanSec: number, p10Sec: number, p50Sec: number, p90Sec: number, p95Sec: number,
    runningMeanSec: number, junctionMeanSec: number, hotspots: Hotspot[]) {
    this.departMinute = departMinute; this.samples = samples; this.meanSec = meanSec; this.p10Sec = p10Sec; this.p50Sec = p50Sec;
    this.p90Sec = p90Sec; this.p95Sec = p95Sec; this.runningMeanSec = runningMeanSec; this.junctionMeanSec = junctionMeanSec; this.hotspots = hotspots;
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i: number = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/** Float64Array.prototype.sort: ascending numbers (there is no NaN or -0 here). Bottom-up merge sort. */
function sortNumbers(a: number[]): void {
  const n: number = a.length;
  let src: number[] = a, dst: number[] = filled(n, 0);
  for (let w = 1; w < n; w *= 2) {
    for (let lo = 0; lo < n; lo += 2 * w) {
      const mid: number = min2(lo + w, n), hi: number = min2(lo + 2 * w, n);
      let i: number = lo, j: number = mid, k: number = lo;
      while (i < mid && j < hi) { if (src[j] < src[i]) { dst[k] = src[j]; j++; } else { dst[k] = src[i]; i++; } k++; }
      while (i < mid) { dst[k] = src[i]; i++; k++; }
      while (j < hi) { dst[k] = src[j]; j++; k++; }
    }
    const t: number[] = src; src = dst; dst = t;
  }
  if (src !== a) for (let i = 0; i < n; i++) a[i] = src[i];
}

/**
 * A route's mornings, simulated: each morning's door-to-door time, the running and junction
 * seconds summed over every morning and edge (the TypeScript sums its Morning arrays in the
 * same order), and, when asked for, each morning's wait and overflow at each movement.
 */
class Mornings {
  totals: number[];
  runSum: number;
  juncSum: number;
  /** wait[k * movements + i]: morning k's wait at movement i (with hotspots only). */
  wait: number[];
  overflow: number[];
  movements: Movement[];
  constructor(movements: Movement[]) { this.totals = []; this.runSum = 0; this.juncSum = 0; this.wait = []; this.overflow = []; this.movements = movements; }
}

function simulateMornings(g: Graph, stats: MovementStats, route: Route, departMinute: number, o: SimOptions, keep: boolean): Mornings {
  const r: Rng = new Rng(o.seed);
  const movements: Movement[] = [];
  const re: number[] = route.edges;
  for (let i = 1; i < re.length; i++) movements.push(stats.movement(re[i - 1], re[i]));
  const n: number = re.length;
  const nm: number = movements.length;
  const cal: Calibration = o.cal;
  const out: Out = OUT;
  const res: Mornings = new Mornings(movements);
  const wait: number[] = res.wait, overflow: number[] = res.overflow;
  let runSum: number = 0, juncSum: number = 0;
  for (let k = 0; k < o.runs; k++) {
    const dayFactor: number = exp(cal.daySigma * r.normal());
    let t: number = 0;
    for (let i = 0; i < n; i++) {
      const e: Edge = g.edges[re[i]];
      const enter: number = t;
      t += runningTime(e, departMinute + t / 60, cal, dayFactor) * exp(cal.edgeSigma * r.normal());
      runSum += t - enter;
      if (i < nm) {
        const d: number = sampleDelay(g, movements[i], departMinute + t / 60, dayFactor, cal, r, out);
        if (keep) { wait.push(d); overflow.push(out.overflow ? 1 : 0); }
        juncSum += d;
        t += d;
      } else juncSum += 0;
    }
    res.totals.push(t + o.endOverheadSec);
  }
  res.runSum = runSum; res.juncSum = juncSum;
  return res;
}

function sum(xs: number[]): number {
  let s: number = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s;
}

class PerMove {
  all: number[];
  over: number;
  constructor(all: number[], over: number) { this.all = all; this.over = over; }
}

class ComplexSum {
  m: Movement;
  sums: number[];
  over: number;
  constructor(m: Movement, sums: number[], over: number) { this.m = m; this.sums = sums; this.over = over; }
}

function simulateRoute(g: Graph, stats: MovementStats, route: Route, departMinute: number, o: SimOptions, hotspots: boolean): SimResult {
  const sim: Mornings = simulateMornings(g, stats, route, departMinute, o, hotspots);
  const movements: Movement[] = sim.movements;
  const samples: number[] = sim.totals;
  const runSum: number = sim.runSum, juncSum: number = sim.juncSum;
  const runs: number = samples.length, nm: number = movements.length;
  sortNumbers(samples);
  const meanSec: number = sum(samples) / o.runs;
  const p10: number = quantile(samples, 0.1), p50: number = quantile(samples, 0.5), p90: number = quantile(samples, 0.9), p95: number = quantile(samples, 0.95);
  const spots: Hotspot[] = [];
  if (!hotspots) return new SimResult(departMinute, samples, meanSec, p10, p50, p90, p95, runSum / o.runs, juncSum / o.runs, spots);
  const perMove: PerMove[] = [];
  for (let i = 0; i < movements.length; i++) {
    const all: number[] = [];
    let over: number = 0;
    for (let k = 0; k < runs; k++) { all.push(sim.wait[k * nm + i]); over += sim.overflow[k * nm + i]; }
    perMove.push(new PerMove(all, over));
  }
  const byComplex: any = new Map();
  const order: ComplexSum[] = []; // byComplex's values in insertion order
  for (let i = 0; i < movements.length; i++) {
    const m: Movement = movements[i];
    if (m.controlK === C_NONE) continue;
    const pm: PerMove = perMove[i];
    const got: any = byComplex.get(m.complex);
    let h: ComplexSum = got === undefined ? new ComplexSum(m, filled(o.runs, 0), 0) : got;
    if (got === undefined) { byComplex.set(m.complex, h); order.push(h); }
    if (m.controlK !== C_INTERNAL) h.m = m;
    const sums: number[] = h.sums;
    for (let k = 0; k < o.runs; k++) sums[k] = sums[k] + pm.all[k];
    h.over = max2(h.over, pm.over);
  }
  for (let i = 0; i < order.length; i++) {
    const h: ComplexSum = order[i];
    const m: Movement = h.m;
    const sorted: number[] = [];
    for (let k = 0; k < h.sums.length; k++) sorted.push(h.sums[k]);
    sortNumbers(sorted);
    const v: Vertex = g.vertices[g.edges[m.inEdge].to];
    spots.push(new Hotspot(m.complex, v.lat, v.lon, explainControl(m), nameControl(m), CONTROL_NAMES[m.controlK], m.inferred,
      sum(sorted) / o.runs, quantile(sorted, 0.5), quantile(sorted, 0.9), h.over / o.runs));
  }
  // spots.sort((a, b) => b.meanSec - a.meanSec): stable, by insertion.
  for (let i = 1; i < spots.length; i++) {
    const x: Hotspot = spots[i];
    let j: number = i - 1;
    while (j >= 0 && x.meanSec - spots[j].meanSec > 0) { spots[j + 1] = spots[j]; j--; }
    spots[j + 1] = x;
  }
  return new SimResult(departMinute, samples, meanSec, p10, p50, p90, p95, runSum / o.runs, juncSum / o.runs, spots);
}

function onTimeShare(sim: SimResult, arriveByMinute: number): number {
  const budget: number = (arriveByMinute - sim.departMinute) * 60;
  const s: number[] = sim.samples;
  let lo: number = 0, hi: number = s.length;
  while (lo < hi) { const mid: number = shr(lo + hi, 1); if (s[mid] <= budget) lo = mid + 1; else hi = mid; }
  return lo / s.length;
}

// ---------------------------------------------------------------- plan.ts

class Goal {
  arriveByMinute: number;
  confidence: number;
  earlyMinutes: number;
  constructor(arriveByMinute: number, confidence: number, earlyMinutes: number) {
    this.arriveByMinute = arriveByMinute; this.confidence = confidence; this.earlyMinutes = earlyMinutes;
  }
}

class DeparturePoint {
  departMinute: number;
  p10Sec: number;
  p50Sec: number;
  p90Sec: number;
  onTime: number;
  dots: number[];
  constructor(departMinute: number, p10Sec: number, p50Sec: number, p90Sec: number, onTime: number, dots: number[]) {
    this.departMinute = departMinute; this.p10Sec = p10Sec; this.p50Sec = p50Sec; this.p90Sec = p90Sec; this.onTime = onTime; this.dots = dots;
  }
}

function departurePoint(sim: SimResult, departMinute: number, target: number): DeparturePoint {
  const dots: number[] = [];
  for (let i = 0; i < 20; i++) dots.push(quantile(sim.samples, (i + 0.5) / 20));
  return new DeparturePoint(departMinute, sim.p10Sec, sim.p50Sec, sim.p90Sec, onTimeShare(sim, target), dots);
}

function departureCurve(g: Graph, stats: MovementStats, route: Route, goal: Goal, fromMinute: number, toMinute: number, stepMinutes: number,
  o: SimOptions): DeparturePoint[] {
  const target: number = goal.arriveByMinute - goal.earlyMinutes;
  const out: DeparturePoint[] = [];
  for (let m = fromMinute; m <= toMinute + 1e-9; m += stepMinutes) {
    out.push(departurePoint(simulateRoute(g, stats, route, m, o, false), m, target));
  }
  for (let i = 1; i < out.length; i++) out[i].onTime = Math.min(out[i].onTime, out[i - 1].onTime);
  return out;
}

/** The latest departure meeting the goal, interpolated; NaN for TypeScript's null. */
function leaveBy(curve: DeparturePoint[], goal: Goal): number {
  let best: number = NaN;
  for (let i = 0; i < curve.length; i++) {
    const p: DeparturePoint = curve[i];
    if (p.onTime < goal.confidence) continue;
    best = p.departMinute;
    if (i + 1 < curve.length) {
      const n: DeparturePoint = curve[i + 1];
      if (n.onTime < goal.confidence)
        best = p.departMinute + ((p.onTime - goal.confidence) / (p.onTime - n.onTime)) * (n.departMinute - p.departMinute);
    }
  }
  return best;
}

class Candidate {
  label: string;
  route: Route;
  constructor(label: string, route: Route) { this.label = label; this.route = route; }
}

class RouteChoice {
  label: string;
  route: Route;
  /** NaN for null. */
  leaveBy: number;
  atLeaveBy: SimResult;
  leavePoint: DeparturePoint | null;
  curve: DeparturePoint[];
  constructor(label: string, route: Route, leaveBy: number, atLeaveBy: SimResult, leavePoint: DeparturePoint | null, curve: DeparturePoint[]) {
    this.label = label; this.route = route; this.leaveBy = leaveBy; this.atLeaveBy = atLeaveBy; this.leavePoint = leavePoint; this.curve = curve;
  }
}

class PlanOptions {
  goal: Goal;
  sim: SimOptions;
  maxRoutes: number;
  windowMinutes: number;
  stepMinutes: number;
  alternatives: number;
  constructor(goal: Goal, sim: SimOptions, windowMinutes: number, stepMinutes: number) {
    this.goal = goal; this.sim = sim; this.maxRoutes = 5; this.windowMinutes = windowMinutes; this.stepMinutes = stepMinutes; this.alternatives = 4;
  }
}

const NO_PENALTY: number[] = [];

function plan(g: Graph, stats: MovementStats, from: number, to: number, o: PlanOptions): RouteChoice[] {
  const window: number = o.windowMinutes;
  const step: number = o.stepMinutes;
  const departFrom: number = o.goal.arriveByMinute - window;
  const routeAt: number = o.goal.arriveByMinute - 25;
  const candidates: Candidate[] = [];
  const beaten: Route | null = shortestPath(g, stats, from, to, new SearchOptions(routeAt, 0, o.sim.cal, true, NO_PENALTY));
  if (beaten !== null) candidates.push(new Candidate("beaten", beaten));
  const risks: number[] = from === to ? [] : [0, 1.5];
  for (let ri = 0; ri < risks.length; ri++) {
    const alts: Route[] = alternatives(g, stats, from, to, new SearchOptions(routeAt, risks[ri], o.sim.cal, false, NO_PENALTY), o.alternatives, 0.75);
    for (let ai = 0; ai < alts.length; ai++) {
      const r: Route = alts[ai];
      let distinct: boolean = true;
      for (let ci = 0; ci < candidates.length; ci++) {
        const c: Candidate = candidates[ci];
        if (!(overlap(g, r, c.route) < 0.9 || overlap(g, c.route, r) < 0.9)) { distinct = false; break; }
      }
      if (distinct) candidates.push(new Candidate("analysed", r));
    }
  }
  const choices: RouteChoice[] = [];
  for (let ci = 0; ci < candidates.length; ci++) {
    const label: string = candidates[ci].label, route: Route = candidates[ci].route;
    const curve: DeparturePoint[] = departureCurve(g, stats, route, o.goal, departFrom, o.goal.arriveByMinute, step, o.sim);
    const target: number = o.goal.arriveByMinute - o.goal.earlyMinutes;
    let lb: number = leaveBy(curve, o.goal);
    const none: boolean = lb !== lb;
    let at: SimResult = simulateRoute(g, stats, route, none ? departFrom : Math.floor(lb), o.sim, true);
    if (!none) {
      let floor: number = departFrom;
      for (let i = 0; i < curve.length; i++) {
        const p: DeparturePoint = curve[i];
        if (p.departMinute <= lb && p.onTime >= o.goal.confidence && p.departMinute > floor) floor = p.departMinute;
      }
      let m: number = Math.floor(lb);
      while (m > floor && onTimeShare(at, target) < o.goal.confidence) {
        m -= 1;
        at = simulateRoute(g, stats, route, m, o.sim, true);
      }
      lb = m;
    }
    const leavePoint: DeparturePoint | null = none ? null : departurePoint(at, lb, target);
    choices.push(new RouteChoice(label, route, lb, at, leavePoint, curve));
  }
  // choices.sort((a, b) => (b.leaveBy ?? -Infinity) - (a.leaveBy ?? -Infinity)): stable, by insertion.
  for (let i = 1; i < choices.length; i++) {
    const x: RouteChoice = choices[i];
    const xl: number = x.leaveBy !== x.leaveBy ? -INF : x.leaveBy;
    let j: number = i - 1;
    for (; j >= 0; j--) {
      const y: RouteChoice = choices[j];
      const yl: number = y.leaveBy !== y.leaveBy ? -INF : y.leaveBy;
      if (!(xl - yl > 0)) break;
      choices[j + 1] = y;
    }
    choices[j + 1] = x;
  }
  const max: number = o.maxRoutes;
  const kept: RouteChoice[] = [];
  for (let i = 0; i < choices.length && i < max; i++) kept.push(choices[i]);
  let usual: RouteChoice | null = null;
  for (let i = 0; i < choices.length; i++) if (choices[i].label === "beaten") { usual = choices[i]; break; }
  if (usual !== null) {
    let inKept: boolean = false;
    for (let i = 0; i < kept.length; i++) if (kept[i] === usual) inKept = true;
    if (!inKept) kept[kept.length - 1] = usual;
  }
  return kept;
}

// ---------------------------------------------------------------- describe.ts

class NameUse {
  name: string;
  len: number;
  first: number;
  constructor(name: string, len: number, first: number) { this.name = name; this.len = len; this.first = first; }
}

function viaNames(g: Graph, route: Route, max: number): string[] {
  const byName: any = new Map();
  const order: NameUse[] = []; // byName's entries in insertion order
  for (let i = 0; i < route.edges.length; i++) {
    const e: Edge = g.edges[route.edges[i]];
    if (e.name === "") continue;
    const got: any = byName.get(e.name);
    let cur: NameUse = got === undefined ? new NameUse(e.name, 0, i) : got;
    if (got === undefined) { byName.set(e.name, cur); order.push(cur); }
    cur.len += e.lengthM;
  }
  // sort by len descending, keep `max`, then by first ascending: both stable.
  for (let i = 1; i < order.length; i++) {
    const x: NameUse = order[i];
    let j: number = i - 1;
    while (j >= 0 && x.len - order[j].len > 0) { order[j + 1] = order[j]; j--; }
    order[j + 1] = x;
  }
  const top: NameUse[] = [];
  for (let i = 0; i < order.length && i < max; i++) top.push(order[i]);
  for (let i = 1; i < top.length; i++) {
    const x: NameUse = top[i];
    let j: number = i - 1;
    while (j >= 0 && top[j].first - x.first > 0) { top[j + 1] = top[j]; j--; }
    top[j + 1] = x;
  }
  const out: string[] = [];
  for (let i = 0; i < top.length; i++) out.push(shortName(top[i].name));
  return out;
}

// ---------------------------------------------------------------- the plan call (compute.ts's planTrip, engine-lib.ts's call)

const P: any = PACK, Q: any = REQUEST, printOut: any = print, enc: any = JSON.stringify;
const pack: any = JSON.parse(P);
const g: Graph = buildGraph(fromPack(pack));
const cal: Calibration = pack.calibration ? withCalibration(pack.calibration) : DEFAULT_CALIBRATION;
const stats: MovementStats = new MovementStats(g, cal);
// Typed arrays have no join.
function join(xs: string[], sep: string): string {
  let out: string = "";
  for (let i = 0; i < xs.length; i++) out = i ? `${out}${sep}${xs[i]}` : xs[i];
  return out;
}
/** JSON.stringify's spelling of a number (NaN and ±Infinity as null) and of a string. */
function num(x: number): string { const s: any = enc(x); return s; }
function str(x: string): string { const s: any = enc(x); return s; }
function point(p: DeparturePoint): string {
  const dots: string[] = [];
  for (let i = 0; i < p.dots.length; i++) dots.push(num(p.dots[i]));
  return `{"departMinute":${num(p.departMinute)},"p10Sec":${num(p.p10Sec)},"p50Sec":${num(p.p50Sec)},"p90Sec":${num(p.p90Sec)},"onTime":${num(p.onTime)},"dots":[${join(dots, ",")}]}`;
}
/** The first k names of a route, joined: two routes must not read the same. */
function label(names: string[], k: number): string {
  const xs: string[] = [];
  for (let i = 0; i < names.length && i < k; i++) xs.push(names[i]);
  return join(xs, ", ");
}
/** planTrip's result as JSON.stringify writes it: the same keys in the same order. */
function planCall(reqText: any): string {
  const req: any = JSON.parse(reqText);
  const from: number = nearestVertex(g, new LatLon(req.from.lat, req.from.lon));
  const to: number = nearestVertex(g, new LatLon(req.to.lat, req.to.lon));
  const goal: Goal = new Goal(req.goal.arriveByMinute, req.goal.confidence, req.goal.earlyMinutes);
  const choices: RouteChoice[] = plan(g, stats, from, to, new PlanOptions(goal, new SimOptions(req.runs, 7, cal), req.windowMinutes, req.stepMinutes));
  const names: string[][] = [];
  for (let i = 0; i < choices.length; i++) names.push(viaNames(g, choices[i].route, 5));
  const routes: string[] = [];
  for (let i = 0; i < choices.length; i++) {
    const c: RouteChoice = choices[i];
    let n: number = 2;
    for (;;) {
      if (!(n < names[i].length)) break;
      let clash: boolean = false;
      for (let j = 0; j < choices.length; j++) if (j !== i && label(names[j], n) === label(names[i], n)) clash = true;
      if (!clash) break;
      n++;
    }
    const via: string[] = [];
    for (let k = 0; k < names[i].length && k < n; k++) via.push(str(names[i][k]));
    // routeLine: every edge's geometry, its first point dropped after the first edge.
    const line: string[] = [];
    for (let e = 0; e < c.route.edges.length; e++) {
      const geom: LatLon[] = g.edges[c.route.edges[e]].geometry;
      for (let k = line.length ? 1 : 0; k < geom.length; k++) line.push(`[${num(geom[k].lon)},${num(geom[k].lat)}]`);
    }
    const curve: string[] = [];
    for (let k = 0; k < c.curve.length; k++) curve.push(point(c.curve[k]));
    // hotspots.slice().sort((a, b) => b.p90Sec - a.p90Sec).slice(0, 6): stable, by insertion.
    const spots: Hotspot[] = [];
    for (let k = 0; k < c.atLeaveBy.hotspots.length; k++) spots.push(c.atLeaveBy.hotspots[k]);
    for (let k = 1; k < spots.length; k++) {
      const x: Hotspot = spots[k];
      let j: number = k - 1;
      for (; j >= 0; j--) {
        if (!(x.p90Sec - spots[j].p90Sec > 0)) break;
        spots[j + 1] = spots[j];
      }
      spots[j + 1] = x;
    }
    const hot: string[] = [];
    for (let k = 0; k < spots.length && k < 6; k++) {
      const h: Hotspot = spots[k];
      hot.push(`{"lat":${num(h.lat)},"lon":${num(h.lon)},"name":${str(h.name)},"control":${str(h.control)},"assumed":${h.inferred ? "true" : "false"},"typicalSec":${num(h.p50Sec)},"badSec":${num(h.p90Sec)}}`);
    }
    const lp: DeparturePoint | null = c.leavePoint;
    routes.push(`{"key":"r${i}","via":[${join(via, ",")}],"miles":${num(c.route.lengthM / 1609.344)},"line":[${join(line, ",")}],"leaveBy":${num(c.leaveBy)},"curve":[${join(curve, ",")}],"atLeaveBy":${lp === null ? "null" : point(lp)},"hotspots":[${join(hot, ",")}]}`);
  }
  return `{"ok":{"routes":[${join(routes, ",")}]}}`;
}
const t0: number = Date.now();
const out: string = planCall(Q);
const ms: number = Date.now() - t0;
printOut(out);
printOut(`plan ms ${ms}`);
})();

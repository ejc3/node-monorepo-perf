// The TypeScript side of the pack comparison: fromPack's records in the byte layout Rust's
// `AreaPack::canonical_bytes` writes (engine-rs/src/pack.rs), the counts, and the calibration
// as `Calibration::canonical_json` spells it. Change both sides together.
import type { AreaPack } from "../../engine/src/pack.ts";
import type { RoadData } from "../../engine/src/osm.ts";

class Writer {
  private buf = Buffer.alloc(1 << 20);
  private n = 0;
  private room(k: number) {
    if (this.n + k <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.n + k));
    this.buf.copy(next, 0, 0, this.n);
    this.buf = next;
  }
  raw(b: Uint8Array) { this.room(b.length); this.buf.set(b, this.n); this.n += b.length; }
  f64(x: number) { this.room(8); this.buf.writeDoubleLE(x, this.n); this.n += 8; }
  len(k: number) { this.room(4); this.buf.writeUInt32LE(k, this.n); this.n += 4; }
  str(s: string) { const b = Buffer.from(s, "utf8"); this.len(b.length); this.raw(b); }
  flag(x: boolean) { this.room(1); this.buf[this.n++] = x ? 1 : 0; }
  opt(x: number | null) { this.flag(x !== null); if (x !== null) this.f64(x); }
  bytes(): Buffer { return this.buf.subarray(0, this.n); }
}

export function canonicalBytes(pack: AreaPack, d: RoadData): Buffer {
  const w = new Writer();
  w.raw(Buffer.from("route-planner pack v1\n"));
  w.str(pack.id);
  w.str(pack.name);
  for (const x of [pack.bbox.south, pack.bbox.west, pack.bbox.north, pack.bbox.east]) w.f64(x);
  w.str(pack.osmTimestamp);
  w.len(d.ways.length);
  for (const way of d.ways) {
    w.f64(way.id); w.str(way.cls); w.flag(way.link); w.str(way.name); w.f64(way.oneway);
    w.opt(way.lanes); w.opt(way.maxspeedKph); w.flag(way.roundabout); w.flag(way.destinationOnly);
    w.len(way.nodes.length);
    for (const n of way.nodes) w.f64(n);
  }
  w.len(d.nodes.length);
  for (const n of d.nodes) { w.f64(n.id); w.f64(n.lat); w.f64(n.lon); w.str(n.control ?? ""); w.str(n.controlDirection ?? ""); }
  w.len(d.restrictions.length);
  for (const r of d.restrictions) { w.f64(r.fromWay); w.f64(r.viaNode); w.f64(r.toWay); w.str(r.kind); }
  w.flag(d.controlPoints !== undefined);
  if (d.controlPoints) {
    w.len(d.controlPoints.length);
    for (const c of d.controlPoints) {
      w.f64(c.lat); w.f64(c.lon); w.str(c.control); w.len(c.streets.length);
      for (const s of c.streets) w.str(s);
    }
  }
  return w.bytes();
}

export function counts(pack: AreaPack, d: RoadData) {
  return {
    ways: d.ways.length,
    wayNodes: d.ways.reduce((s, w) => s + w.nodes.length, 0),
    names: pack.names.length,
    nodes: d.nodes.length,
    controlledNodes: d.nodes.filter((n) => n.control !== null).length,
    restrictions: d.restrictions.length,
    controlPoints: d.controlPoints ? d.controlPoints.length : null,
    stretches: Object.keys(pack.calibration?.stretches ?? {}).length,
  };
}

/** The calibration's fields in `Calibration`'s declared order, maps as JavaScript holds them. */
export function calibrationJson(cal: AreaPack["calibration"]): string {
  if (cal === null) return "null";
  const stretches = cal.stretches && Object.fromEntries(Object.entries(cal.stretches).map(([k, s]) =>
    [k, { nodes: s.nodes, ways: s.ways, volume: s.volume, spread: s.spread }]));
  return JSON.stringify({
    volumeScale: cal.volumeScale, speedScale: cal.speedScale, daySigma: cal.daySigma, edgeSigma: cal.edgeSigma,
    peakExponent: cal.peakExponent, leftTurnShare: cal.leftTurnShare, classVolume: cal.classVolume, classSpeed: cal.classSpeed,
    wayVolume: cal.wayVolume, stretches,
  });
}

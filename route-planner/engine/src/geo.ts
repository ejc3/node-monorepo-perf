export interface LatLon {
  lat: number;
  lon: number;
}

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distance(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearing(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Signed change of heading from `inBearing` to `outBearing`, in (-180, 180]. Positive turns right. */
export function turnAngle(inBearing: number, outBearing: number): number {
  let d = (outBearing - inBearing) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Projection of p onto segment ab in a local equirectangular frame: the fraction along it and the distance off it. */
export function projectOnSegment(p: LatLon, a: LatLon, b: LatLon): { t: number; distance: number } {
  const k = Math.cos(rad((a.lat + b.lat) / 2));
  const ax = a.lon * k, ay = a.lat, bx = b.lon * k, by = b.lat, px = p.lon * k, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return { t, distance: distance(p, { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) }) };
}

export function interpolate(a: LatLon, b: LatLon, t: number): LatLon {
  return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
}

/** Slippy-map tile key at zoom z ("z/x/y"): the unit the horizons are summarised over. */
export function tileKey(p: LatLon, z = 14): string {
  const n = 2 ** z;
  const x = Math.floor(((p.lon + 180) / 360) * n);
  const latR = rad(p.lat);
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
  return `${z}/${x}/${y}`;
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export function bboxAround(points: LatLon[], marginMetres: number): BBox {
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  const dLat = marginMetres / 111_320;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLon = marginMetres / (111_320 * Math.cos(rad(midLat)));
  return {
    south: Math.min(...lats) - dLat,
    west: Math.min(...lons) - dLon,
    north: Math.max(...lats) + dLat,
    east: Math.max(...lons) + dLon,
  };
}

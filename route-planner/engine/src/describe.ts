import type { Graph } from "./graph.ts";
import type { Route } from "./router.ts";

/** "Main St, Oak Ave": the named roads a route spends the most distance on, in order of travel. */
export function viaNames(g: Graph, route: Route, max = 3): string[] {
  const byName = new Map<string, { len: number; first: number }>();
  route.edges.forEach((ei, i) => {
    const e = g.edges[ei]!;
    if (!e.name) return;
    const cur = byName.get(e.name) ?? { len: 0, first: i };
    cur.len += e.lengthM;
    byName.set(e.name, cur);
  });
  return [...byName.entries()]
    .sort((a, b) => b[1].len - a[1].len)
    .slice(0, max)
    .sort((a, b) => a[1].first - b[1].first)
    .map(([n]) => n.replace(/\bAvenue\b/, "Ave").replace(/\bExpressway\b/, "Expy").replace(/\bBoulevard\b/, "Blvd").replace(/\bLane\b/, "Ln").replace(/\bRoad\b/, "Rd").replace(/\bStreet\b/, "St").replace(/\bDrive\b/, "Dr"));
}

/** The route's line, for a map. */
export function routeLine(g: Graph, route: Route): [number, number][] {
  const out: [number, number][] = [];
  for (const ei of route.edges) {
    const geom = g.edges[ei]!.geometry;
    for (let i = out.length ? 1 : 0; i < geom.length; i++) out.push([geom[i]!.lon, geom[i]!.lat]);
  }
  return out;
}

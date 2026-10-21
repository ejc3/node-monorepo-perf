import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGraph, DEFAULT_CALIBRATION, describeMovement, fromOverpass, gapCapacity, leaveBy, MovementStats, movementAllowed,
  plan, rng, sampleDelay, shortestPath, simulateRoute, stableLeaveBy, type Graph,
} from "../src/index.ts";

// A plus-shaped junction: Main St (primary) east–west through node 1, Elm St (residential)
// north–south through it. Node ids: 1 centre; 10/11 west/east; 20/21 north/south; 22 a
// stop sign on Elm 20 m north of the centre.
const D = 0.0018; // ~200 m in latitude
function plus(extra: { stopTags?: Record<string, string>; centreTags?: Record<string, string>; relations?: object[] } = {}): Graph {
  const n = (id: number, lat: number, lon: number, tags?: Record<string, string>) => ({ type: "node", id, lat, lon, ...(tags ? { tags } : {}) });
  return buildGraph(fromOverpass([
    n(1, 0, 0, extra.centreTags), n(10, 0, -D), n(11, 0, D), n(20, D, 0), n(21, -D, 0),
    n(22, 0.00018, 0, extra.stopTags),
    { type: "way", id: 100, nodes: [10, 1], tags: { highway: "primary", name: "Main St" } },
    { type: "way", id: 101, nodes: [1, 11], tags: { highway: "primary", name: "Main St" } },
    { type: "way", id: 200, nodes: [20, 22, 1], tags: { highway: "residential", name: "Elm St" } },
    { type: "way", id: 201, nodes: [1, 21], tags: { highway: "residential", name: "Elm St" } },
    ...(extra.relations ?? []),
  ] as never));
}
const edge = (g: Graph, way: number, toNode: number) => g.edges.find((e) => e.way === way && g.vertices[e.to]!.node === toNode)!;

test("a stop tagged forward governs only the approach travelling in way order", () => {
  const g = plus({ stopTags: { highway: "stop", direction: "forward" } });
  assert.equal(edge(g, 200, 1).control, "stop");
  assert.equal(edge(g, 200, 1).controlInferred, false);
  assert.equal(edge(g, 200, 20).control, null, "leaving the junction meets nothing at its far end");
  assert.equal(edge(g, 100, 1).control, null, "the major road runs free");
});

test("an untagged minor approach is inferred to stop, and says it was inferred", () => {
  const g = plus();
  const south = edge(g, 201, 1);
  assert.equal(south.control, "stop");
  assert.equal(south.controlInferred, true);
});

test("a signal on the junction node governs every approach", () => {
  const g = plus({ centreTags: { highway: "traffic_signals" } });
  for (const [w, n] of [[100, 1], [101, 1], [200, 1], [201, 1]] as const) assert.equal(edge(g, w, n).control, "signal");
});

test("gap capacity is finite with no conflicting traffic and falls as it grows", () => {
  assert.equal(gapCapacity(0, 6.5, 4), 900);
  const c = [100, 500, 1000, 1500].map((v) => gapCapacity(v, 6.5, 4));
  for (let i = 1; i < c.length; i++) assert.ok(c[i]! < c[i - 1]!);
});

test("crossing the busy road from a stop sign is slower at the peak than at dawn", () => {
  const g = plus({ stopTags: { highway: "stop", direction: "forward" } });
  const cross = describeMovement(g, edge(g, 200, 1).id, g.edges.find((e) => e.way === 201 && g.vertices[e.from]!.node === 1)!.id);
  assert.equal(cross.control, "stop");
  assert.equal(cross.turn, "straight");
  const mean = (minute: number) => {
    const r = rng(1);
    let s = 0;
    for (let i = 0; i < 2000; i++) s += sampleDelay(g, cross, { minuteOfDay: minute, dayFactor: 1, cal: DEFAULT_CALIBRATION }, r).seconds;
    return s / 2000;
  };
  assert.ok(mean(8 * 60) > mean(5 * 60) + 2, `peak ${mean(8 * 60)} vs dawn ${mean(5 * 60)}`);
});

test("a no-left-turn restriction is obeyed by the movement check and the router", () => {
  const g = plus({ relations: [{ type: "relation", id: 9, tags: { type: "restriction", restriction: "no_left_turn" }, members: [
    { type: "way", ref: 200, role: "from" }, { type: "node", ref: 1, role: "via" }, { type: "way", ref: 101, role: "to" }] }] });
  const southbound = edge(g, 200, 1);
  const east = g.edges.find((e) => e.way === 101 && g.vertices[e.from]!.node === 1)!;
  assert.equal(movementAllowed(g, southbound, east), false);
  const stats = new MovementStats(g, DEFAULT_CALIBRATION);
  const route = shortestPath(g, stats, g.vertexOfNode.get(20)!, g.vertexOfNode.get(11)!, { departMinute: 480, risk: 0, cal: DEFAULT_CALIBRATION });
  assert.equal(route, null, "the only way east from Elm north is the forbidden left (no turning round at a dead end)");
});

test("a simulation is a pure function of its seed", () => {
  const g = plus();
  const stats = new MovementStats(g, DEFAULT_CALIBRATION);
  const route = shortestPath(g, stats, g.vertexOfNode.get(20)!, g.vertexOfNode.get(21)!, { departMinute: 480, risk: 0, cal: DEFAULT_CALIBRATION })!;
  const a = simulateRoute(g, stats, route, 480, { runs: 200, seed: 5, cal: DEFAULT_CALIBRATION });
  const b = simulateRoute(g, new MovementStats(g, DEFAULT_CALIBRATION), route, 480, { runs: 200, seed: 5, cal: DEFAULT_CALIBRATION });
  assert.deepEqual([...a.samples], [...b.samples]);
  assert.ok(a.p90Sec >= a.p50Sec && a.p50Sec >= a.p10Sec);
});

test("leave-by interpolates to the confidence line, and a small wobble does not move a routine", () => {
  const curve = [
    { departMinute: 450, p10Sec: 0, p50Sec: 0, p90Sec: 0, onTime: 1, dots: [] },
    { departMinute: 460, p10Sec: 0, p50Sec: 0, p90Sec: 0, onTime: 0.97, dots: [] },
    { departMinute: 470, p10Sec: 0, p50Sec: 0, p90Sec: 0, onTime: 0.87, dots: [] },
  ];
  assert.equal(leaveBy(curve, { arriveByMinute: 490, confidence: 0.95, earlyMinutes: 0 }), 462);
  assert.equal(leaveBy(curve, { arriveByMinute: 490, confidence: 1.01, earlyMinutes: 0 }), null);
  assert.equal(stableLeaveBy(462, 463.9), 462);
  assert.equal(stableLeaveBy(462, 458.5), 458);
});

test("a pack round-trips its road data", async () => {
  const { toPack, fromPack } = await import("../src/index.ts");
  const data = {
    ways: [{ id: 5, cls: "residential" as const, link: false, name: "Elm St", oneway: -1 as const, lanes: null, maxspeedKph: 40, roundabout: false, destinationOnly: true, nodes: [1, 2] }],
    nodes: [{ id: 1, lat: 37.1234567, lon: -121.7654321, control: "stop" as const, controlDirection: "backward" as const }, { id: 2, lat: 37.2, lon: -121.8, control: null, controlDirection: null }],
    restrictions: [{ fromWay: 5, viaNode: 2, toWay: 6, kind: "only" as const }],
    controlPoints: [{ lat: 37.1234567, lon: -121.7654321, streets: ["ELM", "MAIN"], control: "all_way_stop" as const }],
  };
  const pack = toPack({ id: "t", name: "t", bbox: { south: 0, west: 0, north: 1, east: 1 }, osmTimestamp: "" }, data, null);
  assert.deepEqual(fromPack(JSON.parse(JSON.stringify(pack))), data);
});

// Regression tests for the first review of the engine.
const node = (id: number, lat: number, lon: number, tags?: Record<string, string>) => ({ type: "node", id, lat, lon, ...(tags ? { tags } : {}) });

test("an only-turn onto a road the extract does not hold is dropped, not a dead end", () => {
  // Way 7 runs 1→2; at 2 the only allowed turn is onto way 99, which a long area left out.
  const g2 = buildGraph(fromOverpass([
    node(1, 0, 0), node(2, D, 0), node(3, D, D), node(4, 2 * D, 0),
    { type: "way", id: 7, nodes: [1, 2], tags: { highway: "primary" } },
    { type: "way", id: 8, nodes: [2, 3], tags: { highway: "primary" } },
    { type: "way", id: 9, nodes: [2, 4], tags: { highway: "primary" } },
    { type: "relation", id: 50, tags: { type: "restriction", restriction: "only_left_turn" }, members: [
      { type: "way", ref: 7, role: "from" }, { type: "node", ref: 2, role: "via" }, { type: "way", ref: 99, role: "to" }] },
  ] as never));
  const into = g2.edges.find((e) => e.way === 7 && g2.vertices[e.to]!.node === 2)!;
  const out = g2.vertices[into.to]!.out.map((i) => g2.edges[i]!).filter((e) => e.way !== 7);
  assert.equal(out.length, 2);
  assert.ok(out.every((e) => movementAllowed(g2, into, e)), "both ways on stay open");
});

test("a no_u_turn whose from and to are one way forbids turning back, not carrying on", () => {
  const g2 = buildGraph(fromOverpass([
    node(1, 0, 0), node(2, D, 0), node(3, -D, 0), node(4, 0, D),
    { type: "way", id: 7, nodes: [2, 1, 3], tags: { highway: "residential" } },
    { type: "way", id: 8, nodes: [1, 4], tags: { highway: "residential" } },
    { type: "relation", id: 9, tags: { type: "restriction", restriction: "no_u_turn" }, members: [
      { type: "way", ref: 7, role: "from" }, { type: "node", ref: 1, role: "via" }, { type: "way", ref: 7, role: "to" }] },
  ] as never));
  const southIn = edge(g2, 7, 1);
  const southOn = g2.edges.find((e) => e.way === 7 && g2.vertices[e.from]!.node === 1 && g2.vertices[e.to]!.node === 3)!;
  assert.equal(movementAllowed(g2, southIn, southOn), true, "straight on along the same way");
  const back = g2.edges.find((e) => e.way === 7 && g2.vertices[e.from]!.node === 1 && g2.vertices[e.to]!.node === 2)!;
  assert.equal(movementAllowed(g2, southIn, back), false, "but not back");
});

test("lanes on a one-way road are all its own", async () => {
  const { lanesPerDirection } = await import("../src/index.ts");
  const g = buildGraph(fromOverpass([
    node(1, 0, 0), node(2, 0, D), node(3, D, 0), node(4, D, D),
    { type: "way", id: 1, nodes: [1, 2], tags: { highway: "primary", oneway: "yes", lanes: "2" } },
    { type: "way", id: 2, nodes: [3, 4], tags: { highway: "primary", lanes: "2" } },
  ] as never));
  assert.equal(lanesPerDirection(g.edges.find((e) => e.way === 1)!), 2);
  assert.equal(lanesPerDirection(g.edges.find((e) => e.way === 2)!), 1);
});

test("a trip that starts where it ends is empty", () => {
  const g = plus();
  const v = g.vertexOfNode.get(20)!;
  assert.deepEqual(shortestPath(g, new MovementStats(g, DEFAULT_CALIBRATION), v, v, { departMinute: 480, risk: 0, cal: DEFAULT_CALIBRATION }), { edges: [], lengthM: 0 });
});

test("entering a roundabout yields; motorcar access overrides motor_vehicle", () => {
  const g = buildGraph(fromOverpass([
    node(1, 0, 0), node(2, 0.0002, 0.0002), node(3, 0, 0.0004), node(4, 0, -D), node(5, D, -D), node(6, D, 0),
    { type: "way", id: 1, nodes: [1, 2, 3, 1], tags: { highway: "residential", junction: "roundabout" } },
    { type: "way", id: 2, nodes: [4, 1], tags: { highway: "residential" } },
    { type: "way", id: 3, nodes: [5, 6], tags: { highway: "residential", motor_vehicle: "yes", motorcar: "no" } },
  ] as never));
  assert.equal(edge(g, 2, 1).control, "give_way");
  assert.equal(g.edges.some((e) => e.way === 3), false);
});

test("the A* bound never exceeds a route's free-flow time, at any speed scale", async () => {
  const { freeFlowTo, freeFlowTime } = await import("../src/index.ts");
  const g = plus();
  for (const cal of [DEFAULT_CALIBRATION, { ...DEFAULT_CALIBRATION, speedScale: 1.2 }]) {
    const stats = new MovementStats(g, cal);
    for (let to = 0; to < g.vertices.length; to++) {
      for (let from = 0; from < g.vertices.length; from++) {
        const bound = freeFlowTo(g, cal, to, from);
        // Every vertex, reached by the backward search or not, on every route from `from`.
        for (let v = 0; v < g.vertices.length; v++) {
          const r = shortestPath(g, stats, v, to, { departMinute: 480, risk: 0, cal });
          if (!r) continue;
          const free = r.edges.reduce((sum, ei) => sum + freeFlowTime(g.edges[ei]!, cal), 0);
          assert.ok(bound(v) <= free + 1e-9, `${v}->${to} (searching from ${from}): bound ${bound(v)} > ${free}`);
        }
      }
    }
  }
});

test("an origin that cannot reach the destination does not send the A* bound over the whole area", async () => {
  const { freeFlowTo, freeFlowTime } = await import("../src/index.ts");
  // A 33 km road from the destination (node 1), and a 100 m piece of road on its own beside it.
  const chain = Array.from({ length: 300 }, (_, i) => node(i + 1, 0, i * 0.001));
  const g = buildGraph(fromOverpass([
    ...chain, node(1001, 0.0009, 0), node(1002, 0.0009, 0.0005),
    // Separate ways, so the road has a vertex every 110 m, as a road with side streets has.
    ...chain.slice(1).map((n, i) => ({ type: "way", id: 10 + i, nodes: [chain[i]!.id, n.id], tags: { highway: "residential" } })),
    { type: "way", id: 2, nodes: [1001, 1002], tags: { highway: "residential" } },
  ] as never));
  const to = g.vertexOfNode.get(1)!, from = g.vertexOfNode.get(1001)!, far = g.vertexOfNode.get(300)!;
  const bound = freeFlowTo(g, DEFAULT_CALIBRATION, to, from);
  const farFree = g.edges.filter((e) => e.way >= 10 && g.vertices[e.to]!.node < g.vertices[e.from]!.node).reduce((s, e) => s + freeFlowTime(e, DEFAULT_CALIBRATION), 0);
  assert.ok(bound(far) < farFree / 2, `stopped near the destination: bound at the far end ${bound(far)} s of ${farFree} s`);
  assert.ok(bound(far) <= farFree, "and still a lower bound");
});

test("access=destination costs nothing along the whole way the trip starts on", () => {
  // A destination-only street split into three pieces; the trip starts at its far end.
  const g = buildGraph(fromOverpass([
    node(1, 0, 0), node(2, 0, D), node(3, 0, 2 * D), node(4, 0, 3 * D), node(5, D, D), node(6, D, 2 * D), node(7, -D, 3 * D),
    { type: "way", id: 1, nodes: [1, 2, 3, 4], tags: { highway: "residential", access: "destination" } },
    { type: "way", id: 2, nodes: [5, 2], tags: { highway: "residential" } },
    { type: "way", id: 3, nodes: [6, 3], tags: { highway: "residential" } },
    { type: "way", id: 4, nodes: [4, 7], tags: { highway: "residential" } },
    { type: "way", id: 5, nodes: [5, 6], tags: { highway: "residential" } }, // a detour round the middle piece
  ] as never));
  const stats = new MovementStats(g, DEFAULT_CALIBRATION);
  const r = shortestPath(g, stats, g.vertexOfNode.get(1)!, g.vertexOfNode.get(7)!, { departMinute: 300, risk: 0, cal: DEFAULT_CALIBRATION })!;
  assert.deepEqual([...new Set(r.edges.map((e) => g.edges[e]!.way))], [1, 4], "straight along the access way, no detour");
});

test("a ramp never makes the street it meets stop, and merges onto a freeway with no control", () => {
  const n = (id: number, lat: number, lon: number) => ({ type: "node", id, lat, lon });
  const g = buildGraph(fromOverpass([
    n(1, 0, 0), n(2, 0, -D), n(3, 0, D), n(4, D, 0), n(5, -D, D), n(6, -D, 2 * D), n(7, -D, 0),
    { type: "way", id: 1, nodes: [2, 1, 3], tags: { highway: "primary", name: "Oak Ave" } },
    { type: "way", id: 2, nodes: [1, 5], tags: { highway: "motorway_link", oneway: "yes" } },
    { type: "way", id: 3, nodes: [7, 5, 6], tags: { highway: "motorway", name: "CA-85" } },
    { type: "way", id: 4, nodes: [4, 1], tags: { highway: "residential", name: "Elm St" } },
  ] as never));
  assert.equal(edge(g, 1, 1).control, null, "the arterial does not stop for an on-ramp");
  assert.equal(edge(g, 4, 1).control, "stop", "the side street still does");
  assert.equal(edge(g, 2, 5).control, null, "the ramp merges");
});

test("a trip that starts where it ends plans one route; a circular junction is not a roundabout", () => {
  const g = plus();
  const v = g.vertexOfNode.get(20)!;
  const choices = plan(g, new MovementStats(g, DEFAULT_CALIBRATION), v, v, {
    goal: { arriveByMinute: 490, confidence: 0.95, earlyMinutes: 0 }, sim: { runs: 20, seed: 1, cal: DEFAULT_CALIBRATION }, windowMinutes: 10,
  });
  assert.equal(choices.length, 1);
  const c = buildGraph(fromOverpass([
    node(1, 0, 0), node(2, 0.0002, 0.0002), node(3, 0, 0.0004), node(4, 0, -D),
    { type: "way", id: 1, nodes: [1, 2, 3, 1], tags: { highway: "residential", junction: "circular" } },
    { type: "way", id: 2, nodes: [4, 1], tags: { highway: "residential" } },
  ] as never));
  assert.equal(edge(c, 2, 1).control, null);
});

test("a surveyed control replaces the guess: none, all-way, signal; a tagged sign is kept", () => {
  const at = (control: "none" | "all_way_stop" | "signal") => buildGraph({
    ...fromOverpass([
      node(1, 0, 0), node(10, 0, -D), node(11, 0, D), node(20, D, 0), node(21, -D, 0),
      { type: "way", id: 100, nodes: [10, 1, 11], tags: { highway: "primary", name: "Main Street" } },
      { type: "way", id: 200, nodes: [20, 1], tags: { highway: "residential", name: "Elm Avenue" } },
      { type: "way", id: 201, nodes: [1, 21], tags: { highway: "residential", name: "Elm Avenue" } },
    ] as never),
    controlPoints: [{ lat: 0.00005, lon: 0, streets: ["MAIN", "ELM"], control }],
  });
  const none = at("none");
  assert.equal(edge(none, 200, 1).control, null, "no stop where the city says there is none");
  assert.equal(edge(none, 200, 1).controlInferred, false);
  assert.equal(edge(at("all_way_stop"), 100, 1).control, "all_way_stop", "the main road stops too");
  assert.equal(edge(at("signal"), 200, 1).control, "signal");
  const kept = buildGraph({
    ...fromOverpass([
      node(1, 0, 0), node(10, 0, -D), node(11, 0, D), node(20, D, 0), node(22, 0.00018, 0, { highway: "stop", direction: "forward" }),
      { type: "way", id: 100, nodes: [10, 1, 11], tags: { highway: "primary", name: "Main Street" } },
      { type: "way", id: 200, nodes: [20, 22, 1], tags: { highway: "residential", name: "Elm Avenue" } },
    ] as never),
    controlPoints: [{ lat: 0, lon: 0, streets: ["MAIN"], control: "none" }],
  });
  assert.equal(edge(kept, 200, 1).control, "stop", "a sign mapped on the ground wins over the inventory");
});

test("street names from two sources agree: Oak Avenue is OAK AV", async () => {
  const { streetKey } = await import("../src/index.ts");
  assert.equal(streetKey("Oak Avenue"), streetKey("OAK AV"));
  assert.equal(streetKey("South Bascom Avenue"), streetKey("S BASCOM AV"));
  assert.equal(streetKey("Almaden Expressway"), streetKey("ALMADEN EX"));
});

// Regression tests for the review of the survey.
test("a one-way arterial carries on through a surveyed side-street stop", () => {
  const g = buildGraph({
    ...fromOverpass([
      node(1, 0, 0), node(10, 0, -D), node(11, 0, D), node(20, D, 0), node(21, -D, 0),
      { type: "way", id: 100, nodes: [10, 1, 11], tags: { highway: "primary", name: "Hillsdale Avenue", oneway: "yes" } },
      { type: "way", id: 200, nodes: [20, 1, 21], tags: { highway: "residential", name: "Jenkins Avenue" } },
    ] as never),
    controlPoints: [{ lat: 0, lon: 0, streets: ["HILLSDALE", "JENKINS"], control: "stop" }],
  });
  assert.equal(edge(g, 100, 1).control, null, "the one-way arterial does not stop");
  assert.equal(edge(g, 200, 1).control, "stop");
});

test("a survey lands on the junction naming both its streets; a nearby survey does not overwrite it", () => {
  const E = 0.00035; // ~39 m east: a second junction along Bird
  const g = buildGraph({
    ...fromOverpass([
      node(1, 0, 0), node(2, 0, E), node(10, 0, -D), node(11, 0, D), node(20, D, 0), node(21, -D, 0), node(30, D, E),
      { type: "way", id: 100, nodes: [10, 1, 2, 11], tags: { highway: "secondary", name: "Bird Avenue" } },
      { type: "way", id: 200, nodes: [20, 1, 21], tags: { highway: "secondary", name: "Minnesota Avenue" } },
      { type: "way", id: 300, nodes: [30, 2], tags: { highway: "residential", name: "Vernon Avenue" } },
    ] as never),
    controlPoints: [
      { lat: 0, lon: 0, streets: ["BIRD", "MINNESOTA"], control: "signal" },
      // The city's point for Bird & Vernon sits nearer Bird & Minnesota than to its own junction.
      { lat: 0, lon: 0.00015, streets: ["BIRD", "VERNON"], control: "stop" },
    ],
  });
  assert.equal(edge(g, 200, 1).control, "signal");
  assert.equal(edge(g, 300, 2).control, "stop");
});

test("a surveyed 2-way stop where two equal streets both cross: a mapped sign says which; with none, both, as assumed", () => {
  const cross = (stopTags?: Record<string, string>) => buildGraph({
    ...fromOverpass([
      node(1, 0, 0), node(10, 0, -D), node(11, 0, D), node(20, D, 0), node(21, -D, 0), node(22, 0.00018, 0, stopTags),
      { type: "way", id: 100, nodes: [10, 1, 11], tags: { highway: "residential", name: "Ewer Drive" } },
      { type: "way", id: 200, nodes: [20, 22, 1, 21], tags: { highway: "residential", name: "Samson Drive" } },
    ] as never),
    controlPoints: [{ lat: 0, lon: 0, streets: ["EWER", "SAMSON"], control: "stop" }],
  });
  const tagged = cross({ highway: "stop", direction: "forward" });
  assert.equal(edge(tagged, 200, 1).control, "stop", "the mapped stop");
  assert.equal(edge(tagged, 100, 1).control, null, "the crossing street stays free");
  const unmapped = cross();
  assert.equal(edge(unmapped, 100, 1).control, "stop");
  assert.equal(edge(unmapped, 100, 1).controlInferred, true);
  assert.equal(edge(unmapped, 200, 1).control, "stop");
});

test("a loop street carries on through its own junction: two arms reaching one far junction are two arms", () => {
  // Loop Lane leaves Main Street at 1 and comes back to it there; Main Street has a mapped stop.
  const g = buildGraph({
    ...fromOverpass([
      node(1, 0, 0), node(2, 0.0009, 0.0002), node(3, 0.0009, 0.0009), node(4, 0.0002, 0.0009), node(10, 0, -D), node(11, -D, 0),
      node(12, 0, -0.00018, { highway: "stop", direction: "forward" }),
      { type: "way", id: 100, nodes: [10, 12, 1, 11], tags: { highway: "residential", name: "Main Street" } },
      { type: "way", id: 300, nodes: [1, 2, 3, 4, 1], tags: { highway: "residential", name: "Loop Lane" } },
      // A court off the far side of the loop makes 3 a junction: both arms from 1 reach it.
      node(5, 0.0018, 0.0018), { type: "way", id: 400, nodes: [3, 5], tags: { highway: "residential", name: "Far Court" } },
    ] as never),
    controlPoints: [{ lat: 0, lon: 0, streets: ["MAIN", "LOOP"], control: "stop" }],
  });
  assert.equal(edge(g, 100, 1).control, "stop", "the mapped stop on Main Street");
  assert.equal(g.edges.filter((x) => x.way === 300 && g.vertices[x.to]!.node === 1).length, 2, "two arms of Loop Lane arrive at Main Street");
  for (const e of g.edges.filter((x) => x.way === 300 && g.vertices[x.to]!.node === 1)) {
    assert.equal(e.control, null, "Loop Lane carries on, so the mapped stop says Main is the street that stops");
  }
});

// Regression tests for the second review of the survey.
test("a court's surveyed stop is not evidence about the crossing streets, in either way order", () => {
  const ways = [
    { type: "way", id: 100, nodes: [10, 1, 11], tags: { highway: "residential", name: "Ewer Drive" } },
    { type: "way", id: 200, nodes: [20, 1, 21], tags: { highway: "residential", name: "Samson Drive" } },
    { type: "way", id: 300, nodes: [30, 1], tags: { highway: "residential", name: "Harmil Court" } },
  ];
  for (const order of [ways, [...ways].reverse()]) {
    const g = buildGraph({
      ...fromOverpass([node(1, 0, 0), node(10, 0, -D), node(11, 0, D), node(20, D, 0), node(21, -D, 0), node(30, D, D), ...order] as never),
      controlPoints: [{ lat: 0, lon: 0, streets: ["EWER", "SAMSON"], control: "stop" }],
    });
    assert.equal(edge(g, 300, 1).control, "stop", "the court ends here: it stops");
    assert.equal(edge(g, 300, 1).controlInferred, false);
    assert.equal(edge(g, 100, 1).controlInferred, true, "which crossing street stops is still unknown");
    assert.equal(edge(g, 200, 1).controlInferred, true);
  }
});

test("a mapped all-way stop on one approach does not free the crossing street", () => {
  const g = buildGraph({
    ...fromOverpass([
      node(1, 0, 0), node(10, 0, -D), node(11, 0, D), node(20, D, 0), node(21, -D, 0),
      node(22, 0.00018, 0, { highway: "stop", stop: "all", direction: "forward" }),
      { type: "way", id: 100, nodes: [10, 1, 11], tags: { highway: "residential", name: "Ewer Drive" } },
      { type: "way", id: 200, nodes: [20, 22, 1, 21], tags: { highway: "residential", name: "Samson Drive" } },
    ] as never),
    controlPoints: [{ lat: 0, lon: 0, streets: ["EWER", "SAMSON"], control: "stop" }],
  });
  assert.equal(edge(g, 100, 1).control, "stop");
});

test("a divided side street is one leg: the street it meets stays free", () => {
  // Elm Avenue (main) runs east-west through 1 and 2; Oak Avenue's two one-way halves leave
  // from 1 and 2 and rejoin at 5 to the south.
  const g = buildGraph({
    ...fromOverpass([
      node(1, 0, 0), node(2, 0, 0.0002), node(10, 0, -D), node(11, 0, D), node(5, -D, 0.0001), node(6, -2 * D, 0.0001),
      node(7, -D / 2, -0.00005), node(8, -D / 2, 0.00025), // each half bends on its way to 5
      { type: "way", id: 100, nodes: [10, 1, 2, 11], tags: { highway: "residential", name: "Elm Avenue" } },
      { type: "way", id: 200, nodes: [5, 7, 1], tags: { highway: "residential", name: "Oak Avenue", oneway: "yes" } },
      { type: "way", id: 201, nodes: [2, 8, 5], tags: { highway: "residential", name: "Oak Avenue", oneway: "yes" } },
      { type: "way", id: 202, nodes: [6, 5], tags: { highway: "residential", name: "Oak Avenue" } },
    ] as never),
    controlPoints: [{ lat: 0, lon: 0.0001, streets: ["ELM", "OAK"], control: "stop" }],
  });
  assert.equal(edge(g, 100, 1).control, null, "Elm Avenue does not stop for a divided side street");
  assert.equal(edge(g, 200, 1).control, "stop");
});

test("an address snaps to its own road, not the corner", async () => {
  const { nearestVertex } = await import("../src/index.ts");
  const g = plus({ stopTags: { highway: "stop", direction: "forward" } });
  // A house on Main St, 30 m from the junction but 5 m from Main St: it starts on Main St.
  const v = nearestVertex(g, { lat: 0.00005, lon: 0.0012 });
  assert.equal(g.vertices[v]!.node, 11);
});

test("a left turn at a signal queues only the left-turning share: about a cycle, not minutes", () => {
  const g = plus({ centreTags: { highway: "traffic_signals" } });
  const intoMain = edge(g, 100, 1);
  const left = g.edges.find((e) => e.way === 200 && g.vertices[e.from]!.node === 1)!; // eastbound on Main, turning north onto Elm
  const m = describeMovement(g, intoMain.id, left.id);
  assert.equal(m.control, "signal");
  assert.equal(m.turn, "left");
  const r = rng(3), waits: number[] = [];
  for (let i = 0; i < 2000; i++) waits.push(sampleDelay(g, m, { minuteOfDay: 480, dayFactor: 1, cal: { ...DEFAULT_CALIBRATION, volumeScale: 1.1 } }, r).seconds);
  waits.sort((a, b) => a - b);
  assert.ok(waits[1000]! < 150, `median ${waits[1000]} s`);
});

test("a crowded freeway slows far more than a crowded arterial, and class factors apply to their class only", async () => {
  const { runningTime } = await import("../src/index.ts");
  const g = buildGraph(fromOverpass([
    node(1, 0, 0), node(2, 0, D), node(3, D, 0), node(4, D, D),
    { type: "way", id: 1, nodes: [1, 2], tags: { highway: "motorway", lanes: "3", oneway: "yes" } },
    { type: "way", id: 2, nodes: [3, 4], tags: { highway: "primary", lanes: "4" } },
  ] as never));
  const fwy = g.edges.find((e) => e.way === 1)!, art = g.edges.find((e) => e.way === 2)!;
  const ratio = (e: typeof fwy, dayFactor: number) => runningTime(e, 480, DEFAULT_CALIBRATION, dayFactor) / runningTime(e, 180, DEFAULT_CALIBRATION, 1);
  assert.ok(ratio(fwy, 2) > 2 * ratio(art, 2), `freeway x${ratio(fwy, 2).toFixed(2)} vs arterial x${ratio(art, 2).toFixed(2)}`);
  const slow = { ...DEFAULT_CALIBRATION, classSpeed: { motorway: 0.5 } };
  assert.ok(runningTime(fwy, 180, slow) > 1.9 * runningTime(fwy, 180, DEFAULT_CALIBRATION));
  assert.equal(runningTime(art, 180, slow), runningTime(art, 180, DEFAULT_CALIBRATION));
});

test("a route's leave-by departure is simulated at the minute shown: its chance and its dots agree", () => {
  const g = plus();
  const [c] = plan(g, new MovementStats(g, DEFAULT_CALIBRATION), g.vertexOfNode.get(10)!, g.vertexOfNode.get(21)!, {
    goal: { arriveByMinute: 490, confidence: 0.95, earlyMinutes: 0 }, sim: { runs: 200, seed: 1, cal: DEFAULT_CALIBRATION }, windowMinutes: 10, stepMinutes: 5,
  });
  assert.ok(c && c.leaveBy !== null && c.leavePoint);
  const p = c.leavePoint;
  assert.equal(p.departMinute, Math.floor(c.leaveBy));
  assert.equal(c.atLeaveBy.departMinute, p.departMinute);
  const onTimeDots = p.dots.filter((s) => p.departMinute + s / 60 <= 490).length;
  assert.ok(Math.abs(onTimeDots / 20 - p.onTime) <= 0.05 + 1e-9, `${onTimeDots} of 20 dots on time vs ${p.onTime}`);
});

// Per-stretch calibration.

test("a stretch's factors change its own edges only, in its own direction", async () => {
  const { edgeDayFactor, runningTime, sampleDelay, describeMovement: movement } = await import("../src/index.ts");
  const g = plus({ centreTags: { highway: "traffic_signals" } });
  const west = edge(g, 100, 1), back = edge(g, 100, 10), east = edge(g, 101, 11);
  const cal = { ...DEFAULT_CALIBRATION, stretches: { s: { nodes: [10, 1], ways: [100], volume: 2, spread: 2 } } };
  assert.ok(runningTime(west, 480, cal, 1.5) > runningTime(west, 480, DEFAULT_CALIBRATION, 1.5), "busier on the stretch");
  assert.equal(edgeDayFactor(west, cal, 1.5), 1.5 ** 2);
  for (const e of [back, east]) {
    assert.equal(runningTime(e, 480, cal, 1.5), runningTime(e, 480, DEFAULT_CALIBRATION, 1.5));
    assert.equal(edgeDayFactor(e, cal, 1.5), 1.5);
  }
  // Its own approach to the light queues longer; the cross street's wait sees it as busier too.
  const mean = (inEdge: number, outEdge: number, c: typeof DEFAULT_CALIBRATION) => {
    const m = movement(g, inEdge, outEdge), r = rng(5);
    let s = 0;
    for (let i = 0; i < 400; i++) s += sampleDelay(g, m, { minuteOfDay: 480, dayFactor: 1.5, cal: c }, r).seconds;
    return s / 400;
  };
  assert.ok(mean(west.id, east.id, cal) > mean(west.id, east.id, DEFAULT_CALIBRATION), "the stretch's own approach waits longer");
});

test("a stretch's factors stay on its own road where another road joins the same two junctions", async () => {
  // Birch Road and Cedar Way both run between the same two nodes.
  const { runningTime } = await import("../src/index.ts");
  const g = buildGraph(fromOverpass([
    node(1, 0, 0), node(2, 0, D), node(3, D / 2, D / 2),
    { type: "way", id: 7, nodes: [1, 2], tags: { highway: "tertiary", name: "Birch Rd" } },
    { type: "way", id: 8, nodes: [1, 3, 2], tags: { highway: "tertiary", name: "Cedar Way" } },
  ] as never));
  const birch = g.edges.find((e) => e.way === 7 && e.fromNode === 1)!, cedar = g.edges.find((e) => e.way === 8 && e.fromNode === 1)!;
  const cal = { ...DEFAULT_CALIBRATION, stretches: { s: { nodes: [1, 2], ways: [7], volume: 3, spread: 1 } } };
  assert.ok(runningTime(birch, 480, cal, 1.5) > runningTime(birch, 480, DEFAULT_CALIBRATION, 1.5));
  assert.equal(runningTime(cedar, 480, cal, 1.5), runningTime(cedar, 480, DEFAULT_CALIBRATION, 1.5));
});

test("the leave-by minute meets the goal on its own simulation, at every confidence", () => {
  const g = plus();
  for (const confidence of [0.8, 0.9, 0.95, 0.99]) {
    for (const c of plan(g, new MovementStats(g, DEFAULT_CALIBRATION), g.vertexOfNode.get(10)!, g.vertexOfNode.get(21)!, {
      goal: { arriveByMinute: 490, confidence, earlyMinutes: 0 }, sim: { runs: 120, seed: 3, cal: DEFAULT_CALIBRATION }, windowMinutes: 20, stepMinutes: 5,
    })) {
      if (c.leaveBy === null) continue;
      assert.equal(c.leaveBy, Math.floor(c.leaveBy), "a whole minute");
      assert.ok(c.leavePoint!.onTime >= confidence, `${c.leavePoint!.onTime} at ${confidence}`);
    }
  }
});

test("a new route mid-drive starts on the road under the car, the way it is going, not back the way it came", async () => {
  const { edgeUnder } = await import("../src/index.ts");
  const g = plus();
  const stats = new MovementStats(g, DEFAULT_CALIBRATION);
  const car = { lat: 0.00002, lon: -D / 2 }; // on Main St, west of the junction
  const west = edgeUnder(g, car, 270), east = edgeUnder(g, car, 90);
  assert.equal(west, edge(g, 100, 10).id);
  assert.equal(east, edge(g, 100, 1).id);
  assert.equal(edgeUnder(g, { lat: 0.01, lon: 0 }, null), -1, "no road within reach");
  const north = g.vertexOfNode.get(20)!;
  const o = { departMinute: 480, risk: 0, cal: DEFAULT_CALIBRATION };
  assert.equal(shortestPath(g, stats, g.edges[west]!.from, north, { ...o, startEdge: west }), null, "west is a dead end, and the router never turns back down a street");
  const ahead = shortestPath(g, stats, g.edges[east]!.from, north, { ...o, startEdge: east })!;
  assert.deepEqual(ahead.edges, [east, edge(g, 200, 20).id], "heading east: straight on and left at the junction");
});

// The control-placement rule is exported (placeControls) so anything that must agree with
// buildGraph asks the same question. The edge controls are those buildGraph gave before it
// was split out, on the same fixture.
test("control placement: buildGraph charges each tagged control where placeControls places it", async () => {
  const { placeControls } = await import("../src/index.ts");
  const M = 1 / 111_195; // metres east (x) and north (y) of (0, 0)
  const n = (id: number, x: number, y: number, tags?: Record<string, string>) => node(id, y * M, x * M, tags);
  const w = (id: number, nodes: number[], highway: string, tags: Record<string, string> = {}) => ({ type: "way", id, nodes, tags: { highway, ...tags } });
  const data = fromOverpass([
    // Main Rd: an untagged signal 30 m before junction 3; an untagged stop 40 m past it (60 m
    // short of junction 6); a give-way tagged forward, 30 m before 6; a signal on 6.
    n(1, -200, 0), n(2, -30, 0, { highway: "traffic_signals" }), n(3, 0, 0), n(4, 40, 0, { highway: "stop" }),
    n(5, 70, 0, { highway: "give_way", direction: "forward" }), n(6, 100, 0, { highway: "traffic_signals" }), n(7, 300, 0),
    // Elm St through 3: a stop tagged backward, so toward 10, 180 m away: it governs nothing.
    n(10, 0, 200), n(11, 0, 20, { highway: "stop", direction: "backward" }), n(12, 0, -200),
    n(20, 100, -200),
    // A one-way street (against its node order) into 7, whose stop faces the way no car goes.
    n(30, 300, 200), n(31, 300, 30, { highway: "stop" }),
    w(100, [1, 2, 3, 4, 5, 6, 7], "primary"),
    w(200, [10, 11, 3, 12], "residential"),
    w(300, [6, 20], "residential"),
    w(400, [30, 31, 7], "residential", { oneway: "-1" }),
  ] as never);
  const g = buildGraph(data);
  const charged = g.edges.filter((e) => e.control && !e.controlInferred).map((e) => `${e.way} ${e.fromNode}>${e.toNode} ${e.control}`).sort();
  assert.deepEqual(charged, ["100 1>3 signal", "100 3>6 signal", "100 6>3 stop", "100 7>6 signal", "300 20>6 signal"]);
  const placed = [...new Set(placeControls(data).map((p) => `${p.way} ${p.forward ? "+" : "-"}${p.at} ${p.control}`))].sort();
  assert.deepEqual(placed, ["100 +3 signal", "100 +6 give_way", "100 +6 signal", "100 -3 stop", "100 -6 signal", "300 -6 signal"],
    "the give-way reaches 6 too, where the signal outranks it");
});

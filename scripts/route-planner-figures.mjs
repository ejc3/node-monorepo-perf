#!/usr/bin/env node
// The route-planner figures (ROUTE-PLANNER.md), in the figure grammar of scripts/_chartstyle.mjs:
//   fig-route-graph     OpenStreetMap ways and nodes to the graph the search runs on
//   fig-route-plan      one plan call: the searches, the candidates, the curves, the leave-by
//   fig-route-curve     the long trip's first route: its departure curve, leave-by and dots
//   fig-route-workload  what one plan of the long trip does, counted
//   fig-route-astar     the long trip in Node under each version of the A* estimate
//   fig-route-engines   every engine on every trip
//   fig-route-parity    where engines differ from V8 in the last bits
// Deterministic from bench/route-planner-bench.json and bench/route-planner-fixes.json (no Date,
// no hand numbers; missing or renamed fields throw) -> bench/charts/fig-route-*.svg + a 300 DPI
// PNG each, plus each figure's text alternative written into ROUTE-PLANNER.md's chart-data block.
//
//   node scripts/route-planner-figures.mjs                    (make route-planner-figures)
//   node scripts/route-planner-figures.mjs fig-route-curve    (only the named figures)

import { readFileSync } from "node:fs";
import {
  MUTED,
  GRID,
  REPO,
  SCOPE,
  SLATE,
  MACHINE_SERIES,
  CELL_INK2,
  FIG,
  box,
  txt,
  arrow,
  dot,
  node,
  figTitle,
  footer as footerLine,
  svgDoc as svgDocW,
  emitChart,
  assertComparable,
  mdTable,
  mdDetails,
  writeDocBlock,
  approxW,
  wrapPx,
  logScale,
} from "./_chartstyle.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const BENCH = read("bench/route-planner-bench.json");
const FIXES = read("bench/route-planner-fixes.json");
const DOC = "ROUTE-PLANNER.md";

const need = (o, path) => {
  let v = o;
  for (const k of path.split(".")) {
    v = v?.[k];
    if (v == null) throw new Error(`missing field ${path} in a cited bench JSON`);
  }
  return v;
};
const num = (o, path) => {
  const v = need(o, path);
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`field ${path} is not a number in a cited bench JSON`);
  return v;
};
const count = (o, path) => {
  const v = num(o, path);
  if (!Number.isInteger(v) || v < 0)
    throw new Error(`field ${path} is not a count in a cited bench JSON`);
  return v;
};
const str = (o, path) => {
  const v = need(o, path);
  if (typeof v !== "string" || v === "")
    throw new Error(`field ${path} is not a non-empty string in a cited bench JSON`);
  return v;
};
const posMs = (o, path) => {
  const v = num(o, path);
  if (v <= 0) throw new Error(`field ${path} is not a positive time in a cited bench JSON`);
  return v;
};
const int = (n) => n.toLocaleString("en-US");
const secs = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`);
const big = (n) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)} billion`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} million`
      : int(n);
const clock = (m) => `${Math.floor(m / 60)}:${String(Math.floor(m % 60)).padStart(2, "0")}`;

// The records are of record only from a dedicated box, and the two from one machine shape.
for (const [name, r] of [
  ["route-planner-bench", BENCH],
  ["route-planner-fixes", FIXES],
])
  if (need(r, "machine.sharedBox") !== false) throw new Error(`${name}: measured on a shared box`);
if (need(BENCH, "canonical") !== true)
  throw new Error("route-planner-bench is not a canonical run");
assertComparable(
  BENCH,
  FIXES,
  {
    fields: ["machine.instanceType", "machine.arch", "machine.cores", "machine.node"],
    versions: ["rustc", "scriptc", "cc"],
  },
  "route-planner bench vs fixes",
);
if (str(BENCH, "workload.packSha256") !== str(FIXES, "packSha256"))
  throw new Error("the two records ran different area packs");
const MACHINE = `${str(BENCH, "machine.instanceType")} · Node ${str(BENCH, "machine.node").replace(/^v/, "")}`;
const TRIPS = need(BENCH, "workload.trips");
const LONG = TRIPS.find((t) => t.id === "long");
if (!LONG) throw new Error("route-planner-bench has no long trip");
const REQ = need(BENCH, "workload.request");
const RUNS = count(BENCH, "workload.request.runs");
const ROUNDS = count(BENCH, "rounds");

// Each figure is laid out on a 660-wide grid whose left edge is x=16, placed 4px in on a 668
// canvas: the same 20px outer margin as every other figure (figures.mjs).
const W = 660;
const GRID_SHIFT = 4;
const svgDoc = (h, aria, body) =>
  svgDocW(W + 2 * GRID_SHIFT, h, aria, [
    `<g transform="translate(${GRID_SHIFT} 0)">`,
    ...body,
    "</g>",
  ]);
const footer = (y, sources) => footerLine(W, y, sources, 16);
const boxNote = { size: FIG.body, fill: CELL_INK2 };
const emit = (name, svg) => emitChart(name, svg, { strict: true });
const writeFigData = (id, summary, { head, rows, fields, lead, align }) =>
  writeDocBlock(
    DOC,
    id,
    mdDetails(
      summary,
      [lead, mdTable(head, rows, align), `Fields: ${fields}`].filter(Boolean).join("\n\n"),
    ),
  );
// a box of wrapped lines: a bold label, then body lines wrapped to the box
const textBox = (x, y, w, tint, label, body) => {
  const lines = body.flatMap((b) => wrapPx(b, FIG.body, w - 22));
  const h = 30 + lines.length * 14;
  return { h, parts: node(x, y, w, h, tint, label, lines) };
};

// ============================================================================
// fig-route-graph — OpenStreetMap to the search's states
// ============================================================================
function figRouteGraph() {
  const m = need(FIXES, "astar.map");
  const ways = count(m, "ways"),
    nodes = count(m, "nodes"),
    restrictions = count(m, "restrictions");
  const vertices = count(m, "vertices"),
    junctions = count(m, "junctions"),
    edges = count(m, "edges");
  const complexes = count(m, "complexes");
  if (!(junctions < vertices && complexes <= vertices && edges > vertices))
    throw new Error("route-graph: the map's counts are not in the shape the figure draws");
  const T = [];
  T.push(
    ...figTitle(
      16,
      24,
      "From OpenStreetMap to search states",
      `${need(BENCH, "workload.area")}: the counts of the bench's area`,
    ).parts,
  );
  const y0 = 54,
    bw = 196,
    gap = 20;
  const cols = [
    {
      tint: "blue",
      label: "OpenStreetMap extract",
      body: [
        `${int(ways)} drivable ways (class, lanes, speed, one-way)`,
        `${int(nodes)} nodes (signal, stop, give-way tags)`,
        `${int(restrictions)} turn restrictions`,
      ],
    },
    {
      tint: "blue",
      label: "Graph",
      body: [
        `${int(vertices)} vertices: way ends and shared nodes`,
        `${int(edges)} directed edges: a way's run between vertices, once per open direction`,
        `${int(junctions)} junctions: three or more directions`,
      ],
    },
    {
      tint: "green",
      label: "Intersections",
      body: [
        `${int(complexes)} complexes: junctions joined by an edge of 30 m or less are one intersection`,
        "its control is charged once, on entry",
      ],
    },
  ];
  // one height for the row: each box's parts with its rect redrawn at the tallest's height
  const built = cols.map((c, i) => textBox(16 + i * (bw + gap), y0, bw, c.tint, c.label, c.body));
  const h = Math.max(...built.map((b) => b.h));
  built.forEach((b, i) =>
    T.push(box(16 + i * (bw + gap), y0, bw, h, cols[i].tint), ...b.parts.slice(1)),
  );
  for (let i = 0; i < 2; i++) {
    const x = 16 + (i + 1) * (bw + gap);
    T.push(arrow(x - gap + 2, y0 + h / 2, x - 2, y0 + h / 2));
  }
  // the search's state and a movement
  const y1 = y0 + h + 22;
  const left = textBox(16, y1, 306, "amber", "Controls on each approach", [
    "a tagged signal, stop or give-way governs the approaches within 60 m of it",
    "untagged: the lesser road stops, a ramp onto a surface street yields, entering a roundabout yields (marked as assumed)",
  ]);
  const right = textBox(338, y1, 306, "green", "Search state: the edge arrived on", [
    "a movement is in-edge to out-edge: its turn (by angle), its control and turn restrictions",
    "so a left across traffic and a right turn at one junction cost differently",
  ]);
  const h1 = Math.max(left.h, right.h);
  T.push(box(16, y1, 306, h1, "amber"), ...left.parts.slice(1));
  T.push(box(338, y1, 306, h1, "green"), ...right.parts.slice(1));
  const y = y1 + h1 + 34;
  T.push(...footer(y, `bench/route-planner-fixes.json · ${MACHINE}`));
  writeFigData("fig-route-graph", "The figure's numbers as a table", {
    align: ["l", "r"],
    head: ["", "count"],
    rows: [
      ["drivable ways", int(ways)],
      ["nodes", int(nodes)],
      ["turn restrictions", int(restrictions)],
      ["vertices", int(vertices)],
      ["directed edges", int(edges)],
      ["junctions (3+ directions)", int(junctions)],
      ["complexes (intersections)", int(complexes)],
    ],
    fields:
      "`bench/route-planner-fixes.json`: `astar.map.{ways,nodes,restrictions,vertices,edges,junctions,complexes}`.",
  });
  return svgDoc(
    y + 12,
    `The area's OpenStreetMap extract (${int(ways)} ways, ${int(nodes)} nodes) becomes ${int(vertices)} vertices and ${int(edges)} directed edges; junction vertices within 30 m form ${int(complexes)} intersections; the search's state is the edge arrived on, so each movement from one edge to the next has its own turn, control and restrictions.`,
    T,
  );
}

// ============================================================================
// fig-route-plan — one plan call
// ============================================================================
function figRoutePlan() {
  const now = need(FIXES, "astar.results.long.now");
  const searches = count(now, "counters.searches");
  const sims = count(now, "counters.simulations");
  const routes = count(LONG, "routes");
  const departures = num(REQ, "windowMinutes") / num(REQ, "stepMinutes") + 1;
  if (!Number.isInteger(departures))
    throw new Error("route-plan: the window is not a whole number of steps");
  if (count(need(LONG, "curve"), "length") !== departures)
    throw new Error("route-plan: the first route's curve does not have one point per departure");
  const T = [];
  T.push(
    ...figTitle(
      16,
      24,
      "One plan call",
      `the long trip: ${searches} searches, ${sims} simulations of ${int(RUNS)} mornings, ${routes} routes back`,
    ).parts,
  );
  const x = 16,
    w = 628;
  let y = 54;
  const steps = [
    [
      "blue",
      "Snap the ends",
      [
        "each end to the nearer end of the nearest road a car can start on (no freeway, trunk road or ramp)",
      ],
    ],
    [
      "blue",
      "Search: the beaten route and the alternatives",
      [
        "one search with junctions priced flat (signal 15 s, all-way stop 8 s, stop 6 s, yield 2 s): the route a typical router gives",
        "then, at risk 0 and at risk 1.5, up to 4 alternatives each: search, make every edge used 1.35 times dearer, search again (at most 12 tries); keep a route sharing under 75% of its length with each kept",
        `routes priced at ${clock(num(LONG, "arriveByMinute") - 25)}, 25 minutes before the arrival; a candidate sharing 90% with one already taken both ways is dropped`,
      ],
    ],
    [
      "green",
      `Price each route: ${departures} departures × ${int(RUNS)} mornings`,
      [
        `every ${num(REQ, "stepMinutes")} minutes over the ${num(REQ, "windowMinutes")} before the arrival, the same ${int(RUNS)} seeded mornings: the share on time at each`,
        "a later departure is never likelier to arrive on time: a rise between two departures is held at the lower value",
      ],
    ],
    [
      "green",
      "Leave-by",
      [
        `the latest departure whose on-time share reaches ${num(REQ, "goal.confidence") * 100}%, interpolated between two departures`,
        "then simulated as a whole minute on its own, stepping back a minute until it meets the goal",
      ],
    ],
    [
      "blue",
      `Rank and keep ${routes}`,
      ["latest safe departure first; the beaten route is always among them"],
    ],
  ];
  steps.forEach(([tint, label, body], i) => {
    const b = textBox(x, y, w, tint, label, body);
    T.push(...b.parts);
    y += b.h;
    if (i < steps.length - 1) {
      T.push(arrow(x + w / 2, y + 2, x + w / 2, y + 16));
      y += 18;
    }
  });
  y += 34;
  T.push(
    ...footer(y, `bench/route-planner-bench.json · bench/route-planner-fixes.json · ${MACHINE}`),
  );
  writeFigData("fig-route-plan", "The figure's numbers as a table", {
    align: ["l", "r"],
    head: ["the long trip's plan", "count"],
    rows: [
      ["searches", int(searches)],
      ["simulations", int(sims)],
      ["mornings per simulation", int(RUNS)],
      ["departures per route", int(departures)],
      ["routes back", int(routes)],
    ],
    fields:
      "`bench/route-planner-fixes.json`: `astar.results.long.now.counters.{searches,simulations}`. `bench/route-planner-bench.json`: `workload.request.{runs,windowMinutes,stepMinutes,goal.confidence}`, the long trip's `routes`, `arriveByMinute` and `curve`.",
  });
  return svgDoc(
    y + 12,
    `One plan call: snap the ends to the road network; search once with junctions priced flat and then for alternatives at two risk levels, each search after the first making the edges already used dearer; price each candidate route at ${departures} departures over ${int(RUNS)} seeded mornings; find the latest departure that arrives on time ${num(REQ, "goal.confidence") * 100}% of the time and check it as a whole minute; rank the routes by it.`,
    T,
  );
}

// ============================================================================
// fig-route-curve — the long trip's first route: departure curve, leave-by, dots
// ============================================================================
function figRouteCurve() {
  const curve = need(LONG, "curve");
  const conf = num(REQ, "goal.confidence");
  const arrive = num(LONG, "arriveByMinute");
  const lb = need(LONG, "leaveBy")[0];
  const at = need(LONG, "atLeaveBy");
  if (typeof lb !== "number")
    throw new Error("route-curve: the long trip's first route has no leave-by");
  if (num(at, "departMinute") !== lb)
    throw new Error("route-curve: atLeaveBy is not at the leave-by minute");
  const pts = curve.map((p, i) => ({ m: num(p, "departMinute"), on: num(p, "onTime"), i }));
  for (let i = 1; i < pts.length; i++)
    if (pts[i].on > pts[i - 1].on) throw new Error("route-curve: the curve is not monotone");
  // the crossing the leave-by was interpolated from
  const k = pts.findIndex((p, i) => p.on >= conf && (pts[i + 1]?.on ?? -1) < conf);
  if (k < 0 || k + 1 >= pts.length)
    throw new Error("route-curve: no crossing of the confidence line");
  const a = pts[k],
    b = pts[k + 1];
  const cross = a.m + ((a.on - conf) / (a.on - b.on)) * (b.m - a.m);
  if (!(lb <= cross && lb >= a.m))
    throw new Error("route-curve: the leave-by is not at or before the crossing");
  const dots = need(at, "dots").map((d, i) => num(at, `dots.${i}`));
  if (dots.length !== 20) throw new Error("route-curve: not 20 dots");
  const atOn = num(at, "onTime");
  if (atOn < conf) throw new Error("route-curve: the leave-by minute does not meet the goal");

  const T = [];
  T.push(
    ...figTitle(
      16,
      24,
      "The departure curve and the leave-by",
      `the long trip (${need(LONG, "miles")[0].toFixed(1)} mi), first route, arriving by ${clock(arrive)}`,
    ).parts,
  );
  // left: on-time share against departure minute
  const px = 56,
    py = 82,
    pw = 340,
    ph = 200;
  const m0 = pts[0].m,
    m1 = pts[pts.length - 1].m;
  const sx = (m) => px + ((m - m0) / (m1 - m0)) * pw;
  const sy = (v) => py + ph - v * ph;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    T.push(`<line x1="${px}" y1="${sy(v)}" x2="${px + pw}" y2="${sy(v)}" stroke="${GRID}"/>`);
    T.push(txt(px - 8, sy(v) + 3.5, `${v * 100}%`, { size: FIG.note, fill: MUTED, anchor: "end" }));
  }
  for (let i = 0; i < pts.length; i += 2) {
    const tx = sx(pts[i].m);
    T.push(`<line x1="${tx}" y1="${py + ph}" x2="${tx}" y2="${py + ph + 4}" stroke="${MUTED}"/>`);
    T.push(
      txt(tx, py + ph + 17, clock(pts[i].m), { size: FIG.note, fill: MUTED, anchor: "middle" }),
    );
  }
  T.push(`<line x1="${px}" y1="${py + ph}" x2="${px + pw}" y2="${py + ph}" stroke="${MUTED}"/>`);
  T.push(
    txt(px, py - 10, `share of ${int(RUNS)} mornings on time, by departure`, {
      size: FIG.note,
      fill: MUTED,
    }),
  );
  // the confidence line
  T.push(
    `<line x1="${px}" y1="${sy(conf).toFixed(1)}" x2="${px + pw}" y2="${sy(conf).toFixed(1)}" stroke="${MUTED}"/>`,
  );
  T.push(
    txt(px + pw, sy(conf) - 5, `${conf * 100}%`, { size: FIG.note, fill: MUTED, anchor: "end" }),
  );
  T.push(
    `<polyline points="${pts.map((p) => `${sx(p.m).toFixed(1)},${sy(p.on).toFixed(1)}`).join(" ")}" fill="none" stroke="${REPO.mark}" stroke-width="2"/>`,
  );
  for (const p of pts)
    T.push(dot(+sx(p.m).toFixed(1), +sy(p.on).toFixed(1), REPO.mark, { r: 3.25 }));
  // the interpolated crossing (hollow) and the whole-minute leave-by (filled, cyan)
  T.push(dot(+sx(cross).toFixed(1), +sy(conf).toFixed(1), SCOPE.mark, { r: 4.5, hollow: true }));
  T.push(dot(+sx(lb).toFixed(1), +sy(atOn).toFixed(1), SCOPE.mark, { r: 4.5 }));
  T.push(
    txt(px, py + ph + 36, `hollow: the crossing, ${clock(cross)} (${cross.toFixed(1)} min)`, {
      size: FIG.note,
      fill: MUTED,
    }),
  );
  T.push(
    txt(
      px,
      py + ph + 50,
      `filled: leave by ${clock(lb)}, simulated on its own: ${(atOn * 100).toFixed(1)}% on time`,
      {
        size: FIG.note,
        fill: MUTED,
      },
    ),
  );
  // right: the 20 dots, minutes door to door at the leave-by
  const rx = 436,
    rw = 200;
  const dm = dots.map((s) => s / 60);
  const budget = arrive - lb;
  const lo = Math.floor(Math.min(...dm, budget) - 1),
    hi = Math.ceil(Math.max(...dm, budget) + 1);
  const dx = (v) => rx + ((v - lo) / (hi - lo)) * rw;
  T.push(
    txt(rx, py - 10, `the leave-by's 20 dots: minutes door to door`, {
      size: FIG.note,
      fill: MUTED,
    }),
  );
  const ry = py + 70;
  T.push(`<line x1="${rx}" y1="${ry + 30}" x2="${rx + rw}" y2="${ry + 30}" stroke="${MUTED}"/>`);
  for (let v = lo; v <= hi; v += Math.max(1, Math.round((hi - lo) / 5))) {
    T.push(
      `<line x1="${dx(v).toFixed(1)}" y1="${ry + 30}" x2="${dx(v).toFixed(1)}" y2="${ry + 34}" stroke="${MUTED}"/>`,
    );
    T.push(
      txt(+dx(v).toFixed(1), ry + 47, String(v), { size: FIG.note, fill: MUTED, anchor: "middle" }),
    );
  }
  // the budget: arriving on time means at or under it
  T.push(
    `<line x1="${dx(budget).toFixed(1)}" y1="${ry - 22}" x2="${dx(budget).toFixed(1)}" y2="${ry + 30}" stroke="${MUTED}"/>`,
  );
  T.push(
    txt(+dx(budget).toFixed(1), ry - 28, `${budget} min to the arrival`, {
      size: FIG.note,
      fill: MUTED,
      anchor: "end",
    }),
  );
  // stack equal-looking dots so none hides another
  const placed = [];
  for (const v of dm) {
    const cx = +dx(v).toFixed(1);
    let row = 0;
    while (placed.some((p) => p.row === row && Math.abs(p.cx - cx) < 9)) row++;
    placed.push({ cx, row });
    T.push(dot(cx, ry + 20 - row * 9, v <= budget ? SCOPE.mark : REPO.mark, { r: 3.5 }));
  }
  const late = dm.filter((v) => v > budget).length;
  T.push(
    txt(rx, ry + 66, `${20 - late} of 20 at or under the budget`, { size: FIG.note, fill: MUTED }),
  );
  T.push(
    txt(rx, ry + 80, "each dot a 2.5th, 7.5th, … 97.5th percentile", {
      size: FIG.note,
      fill: MUTED,
    }),
  );
  const y = py + ph + 86;
  T.push(...footer(y, `bench/route-planner-bench.json · Node's answer · ${MACHINE}`));
  writeFigData("fig-route-curve", "The figure's numbers as a table", {
    lead: `Leave by ${clock(lb)} (the crossing at ${cross.toFixed(2)} min, ${clock(cross)}); at ${clock(lb)} on its own: ${(atOn * 100).toFixed(1)}% on time. The 20 dots (minutes door to door): ${dm.map((v) => v.toFixed(1)).join(", ")}.`,
    align: ["l", "r", "r", "r", "r"],
    head: ["departure", "on time", "p10", "p50", "p90"],
    rows: curve.map((p, i) => [
      clock(num(p, "departMinute")),
      `${(num(p, "onTime") * 100).toFixed(1)}%`,
      `${(num(curve[i], "p10Sec") / 60).toFixed(1)} min`,
      `${(num(curve[i], "p50Sec") / 60).toFixed(1)} min`,
      `${(num(curve[i], "p90Sec") / 60).toFixed(1)} min`,
    ]),
    fields:
      "`bench/route-planner-bench.json`, the long trip: `curve[].{departMinute,onTime,p10Sec,p50Sec,p90Sec}`, `leaveBy[0]`, `atLeaveBy.{departMinute,onTime,dots}`, `arriveByMinute`; `workload.request.{runs,goal.confidence}`.",
  });
  return svgDoc(
    y + 12,
    `The long trip's first route: the share of ${int(RUNS)} simulated mornings arriving by ${clock(arrive)} at each departure from ${clock(m0)} to ${clock(m1)}, falling as the departure gets later; it crosses ${conf * 100}% at ${clock(cross)}, and the whole minute ${clock(lb)} simulated on its own arrives on time ${(atOn * 100).toFixed(1)}% of the time. Its 20 dots are the trip's durations at 20 evenly spaced percentiles.`,
    T,
  );
}

// ============================================================================
// fig-route-workload — what one plan of the long trip does
// ============================================================================
function figRouteWorkload() {
  const now = need(FIXES, "astar.results.long.now");
  const c = need(now, "counters");
  const m = need(FIXES, "astar.map");
  const statsSamples = 48;
  const tiles = [
    [
      "The map",
      "blue",
      [
        [count(m, "vertices"), "vertices"],
        [count(m, "edges"), "directed edges"],
        [count(m, "complexes"), "intersections"],
      ],
    ],
    [
      "The searches",
      "blue",
      [
        [count(c, "searches"), "searches"],
        [count(c, "settled"), "edges settled"],
        [count(now, "movementPairs"), "movements priced"],
        [count(c, "buckets") * statsSamples, "delays drawn for statistics"],
        [count(c, "boundSettled"), "vertices the bound settled"],
      ],
    ],
    [
      "The simulations",
      "green",
      [
        [count(c, "simulations"), "route simulations"],
        [count(c, "mornings"), "simulated mornings"],
        [count(c, "edgeDraws"), "edge running times drawn"],
        [count(c, "crossings"), "junction delays drawn"],
      ],
    ],
  ];
  const T = [];
  T.push(
    ...figTitle(
      16,
      24,
      "What one plan of the long trip does",
      `the long trip (${need(LONG, "miles")[0].toFixed(1)} mi): ${count(LONG, "routes")} routes`,
    ).parts,
  );
  const bw = 196,
    gap = 20,
    y0 = 54;
  let hmax = 0;
  for (const [, , rows] of tiles) hmax = Math.max(hmax, 30 + rows.length * 38);
  tiles.forEach(([label, tint, rows], i) => {
    const x = 16 + i * (bw + gap);
    T.push(box(x, y0, bw, hmax, tint));
    T.push(txt(x + 11, y0 + 18, label, { size: FIG.label, weight: "600" }));
    rows.forEach(([v, what], j) => {
      const yy = y0 + 42 + j * 38;
      T.push(txt(x + 11, yy, big(v), { size: FIG.value, weight: "650" }));
      const lines = wrapPx(what, FIG.body, bw - 22);
      if (lines.length > 1) throw new Error(`route-workload: "${what}" does not fit its tile`);
      T.push(txt(x + 11, yy + 15, what, boxNote));
    });
  });
  const y = y0 + hmax + 34;
  T.push(
    ...footer(y, `bench/route-planner-fixes.json (counters in a copy of the engine) · ${MACHINE}`),
  );
  writeFigData("fig-route-workload", "The figure's numbers as a table", {
    align: ["l", "l", "r"],
    head: ["", "", "count"],
    rows: tiles.flatMap(([label, , rows]) => rows.map(([v, what]) => [label, what, int(v)])),
    fields:
      "`bench/route-planner-fixes.json`: `astar.map.{vertices,edges,complexes}`; `astar.results.long.now.counters.{searches,settled,buckets,boundSettled,simulations,mornings,edgeDraws,crossings}` (counted in a copy of the engine with counters added, which change no arithmetic: its answer's hash is the timed copy's) and `movementPairs`. Delays drawn = buckets × 48.",
  });
  return svgDoc(
    y + 12,
    `One plan of the long trip on a map of ${int(count(m, "vertices"))} vertices: ${count(c, "searches")} searches settle ${int(count(c, "settled"))} edges and price ${int(count(now, "movementPairs"))} movements, drawing ${big(count(c, "buckets") * statsSamples)} junction delays for their statistics; ${count(c, "simulations")} simulations run ${int(count(c, "mornings"))} mornings, drawing ${big(count(c, "edgeDraws"))} running times and ${big(count(c, "crossings"))} junction delays.`,
    T,
  );
}

// ============================================================================
// fig-route-astar — the long trip under each version of the A* estimate
// ============================================================================
const VARIANTS = [
  ["straight", "straight line at top speed", "the estimate as first written"],
  ["bound", "free-flow bound, full", "per destination and per penalty"],
  ["lazy", "free-flow bound, lazy", "grown only past the origin"],
  ["skip", "+ curves skip hotspots", "departure curves sum no hotspots"],
  ["now", "+ the cap", "the engine as committed"],
];
const CATS = ["A* search", "movement statistics", "A* estimate", "simulation", "other"];
function figRouteAstar() {
  const res = need(FIXES, "astar.results.long");
  const rows = VARIANTS.map(([k, label, sub]) => {
    const r = need(res, k);
    const ms = posMs(r, "medianMs");
    const shares = need(FIXES, `astar.profiles.${k}.shares`);
    const total = CATS.reduce((s, c) => s + (shares[c] ?? 0), 0);
    if (Math.abs(total - 1) > 0.002) throw new Error(`route-astar: ${k}'s shares sum to ${total}`);
    return {
      k,
      label,
      sub,
      ms,
      shares,
      settled: count(r, "counters.settled"),
      pairs: count(r, "movementPairs"),
      sha: str(r, "answerSha256"),
    };
  });
  if (new Set(rows.map((r) => r.sha)).size !== 1)
    throw new Error("route-astar: the variants give different answers");
  if (rows[0].sha !== str(LONG, "answerSha256"))
    throw new Error("route-astar: the variants' answer is not the bench's");
  const T = [];
  T.push(
    ...figTitle(
      16,
      24,
      "The long trip under each A* estimate",
      `the TypeScript engine in Node, the same answer from every version`,
    ).parts,
  );
  // columns: label | one bar column per category (shared scale) | total
  const lx = 16,
    cx0 = 208,
    cw = 78,
    tx = 600;
  const maxCat = Math.max(...rows.flatMap((r) => CATS.map((c) => (r.shares[c] ?? 0) * r.ms)));
  const bar = (v) => Math.max(1, (v / maxCat) * (cw - 12));
  const hy = 58;
  CATS.forEach((c, i) => {
    for (const [j, ln] of wrapPx(c, FIG.note, cw - 6).entries())
      T.push(txt(cx0 + i * cw, hy + j * 12, ln, { size: FIG.note, fill: MUTED }));
  });
  T.push(txt(tx + 44, hy, "plan", { size: FIG.note, fill: MUTED, anchor: "end" }));
  const ry0 = hy + 30,
    rh = 40;
  rows.forEach((r, i) => {
    const y = ry0 + i * rh;
    T.push(txt(lx, y + 4, r.label, { size: FIG.label, weight: "600" }));
    T.push(txt(lx, y + 18, r.sub, { size: FIG.note, fill: MUTED }));
    CATS.forEach((c, j) => {
      const v = (r.shares[c] ?? 0) * r.ms;
      const x = cx0 + j * cw;
      T.push(
        `<rect x="${x}" y="${y - 8}" width="${bar(v).toFixed(1)}" height="10" rx="1.5" fill="${j === 0 ? SCOPE.mark : REPO.mark}"/>`,
      );
      T.push(txt(x, y + 16, secs(v), { size: FIG.note, fill: MUTED }));
    });
    T.push(txt(tx + 44, y + 4, secs(r.ms), { size: FIG.value, weight: "650", anchor: "end" }));
    T.push(
      txt(tx + 44, y + 18, `${int(r.settled)} edges`, {
        size: FIG.note,
        fill: MUTED,
        anchor: "end",
      }),
    );
  });
  const ny = ry0 + rows.length * rh + 2;
  T.push(
    txt(
      16,
      ny,
      `Bars: the plan's time by where a CPU profile's samples fall (the nearest of these frames), one shared scale.`,
      { size: FIG.note, fill: MUTED },
    ),
  );
  T.push(
    txt(
      16,
      ny + 14,
      `Time: the median of ${count(FIXES, "runs")} fresh processes. Edges: settled by the trip's searches.`,
      { size: FIG.note, fill: MUTED },
    ),
  );
  const y = ny + 48;
  T.push(...footer(y, `bench/route-planner-fixes.json · ${MACHINE}`));
  writeFigData("fig-route-astar", "The figure's numbers as a table", {
    align: ["l", "r", ...CATS.map(() => "r"), "r", "r"],
    head: ["estimate", "plan", ...CATS, "edges settled", "movements priced"],
    rows: rows.map((r) => [
      `${r.label} (${r.sub})`,
      secs(r.ms),
      ...CATS.map((c) => `${((r.shares[c] ?? 0) * 100).toFixed(1)}%`),
      int(r.settled),
      int(r.pairs),
    ]),
    fields:
      "`bench/route-planner-fixes.json`: `astar.results.long.<variant>.{medianMs,answerSha256,counters.settled,movementPairs}`, `astar.profiles.<variant>.shares`, `runs`; the long trip's `answerSha256` in `bench/route-planner-bench.json`.",
  });
  const [first, , , , last] = rows;
  return svgDoc(
    y + 12,
    `The long trip in the TypeScript engine under five versions of its A* estimate, all giving the same answer: straight-line distance at the top speed took ${secs(first.ms)} and settled ${int(first.settled)} edges; the committed engine takes ${secs(last.ms)} and settles ${int(last.settled)}. Each version's time is split by where its CPU profile's samples fall.`,
    T,
  );
}

// ============================================================================
// fig-route-engines — every engine on every trip
// ============================================================================
const GROUPS = [
  ["Native and V8", ["rust-native", "rust-wasm", "scriptc", "node"]],
  [
    "Static Hermes, compiled ahead of time",
    ["shermes-typed-ffi", "shermes-typed-tuned", "shermes-typed", "shermes"],
  ],
  ["Hermes, interpreted", ["hermes-v1-1g", "hermes-v1", "hermes-v1-babel", "hermes-classic"]],
];
function figRouteEngines() {
  const engines = need(BENCH, "engines");
  const label = (id) => {
    const e = engines.find((x) => x.id === id);
    if (!e) throw new Error(`route-engines: no engine ${id} in the record`);
    return str(e, "label");
  };
  const ids = GROUPS.flatMap(([, g]) => g);
  if (ids.length !== engines.length)
    throw new Error("route-engines: the record has engines the figure does not draw");
  const ms = (trip, id) => posMs(BENCH, `results.${trip}.${id}.medianMs`);
  const tripIds = ["short", "medium", "long"];
  for (const t of tripIds)
    if (!TRIPS.find((x) => x.id === t)) throw new Error(`route-engines: no trip ${t}`);
  const all = tripIds.flatMap((t) => ids.map((id) => ms(t, id)));
  const lo = 10 ** Math.floor(Math.log10(Math.min(...all) / 1000));
  const hi = 10 ** Math.ceil(Math.log10(Math.max(...all) / 1000));
  const X0 = 246,
    X1 = 520;
  const sx = logScale(lo, hi, X0, X1);
  const T = [];
  const miles = (t) =>
    need(
      TRIPS.find((x) => x.id === t),
      "miles",
    )[0];
  T.push(
    ...figTitle(
      16,
      24,
      "Every engine, every trip",
      `median of ${ROUNDS} fresh processes; the plan call alone, the area loaded first`,
    ).parts,
  );
  // key
  const ky = 66;
  const key = [
    ["short", `short (${miles("short").toFixed(1)} mi)`, { hollow: true }],
    ["medium", `medium (${miles("medium").toFixed(1)} mi)`, { r: 3.5 }],
    ["long", `long (${miles("long").toFixed(1)} mi)`, {}],
  ];
  let kx = 16;
  for (const [, t, o] of key) {
    T.push(
      dot(kx + 4, ky - 3.5, o.hollow ? SLATE : t.startsWith("long") ? REPO.mark : SLATE, {
        r: o.r ?? 4.5,
        hollow: o.hollow,
      }),
    );
    T.push(txt(kx + 13, ky, t, { size: FIG.note, fill: MUTED }));
    kx += 22 + approxW(t, FIG.note);
  }
  T.push(txt(W - 16, ky, "log scale", { size: FIG.note, fill: MUTED, anchor: "end" }));
  let y = 90;
  const axisTop = y;
  const native = ms("long", "rust-native");
  const rowsOut = [];
  for (const [g, list] of GROUPS) {
    y += 26;
    T.push(txt(16, y, g, { size: FIG.note, fill: MUTED, weight: "600" }));
    y += 2;
    for (const id of list) {
      y += 22;
      T.push(txt(16, y + 4, label(id), { size: FIG.body }));
      const xs = tripIds.map((t) => +sx(ms(t, id) / 1000).toFixed(1));
      T.push(dot(xs[0], y, SLATE, { r: 4.5, hollow: true }));
      T.push(dot(xs[1], y, SLATE, { r: 3.5 }));
      T.push(dot(xs[2], y, REPO.mark, { r: 4.5 }));
      const L = ms("long", id);
      T.push(txt(X1 + 14, y + 4, secs(L), { size: FIG.body, weight: "650" }));
      T.push(
        txt(W - 16, y + 4, id === "rust-native" ? "fastest" : `×${(L / native).toFixed(1)}`, {
          size: FIG.note,
          fill: MUTED,
          anchor: "end",
        }),
      );
      rowsOut.push([
        label(id),
        ...tripIds.map((t) => secs(ms(t, id))),
        id === "rust-native" ? "fastest" : `×${(L / native).toFixed(1)}`,
      ]);
    }
  }
  const axisBot = y + 14;
  for (let d = lo; d <= hi + 1e-9; d *= 10) {
    const gx = +sx(d).toFixed(1);
    T.push(`<line x1="${gx}" y1="${axisTop}" x2="${gx}" y2="${axisBot}" stroke="${GRID}"/>`);
    T.push(
      txt(gx, axisBot + 14, d < 1 ? `${d * 1000} ms` : `${d} s`, {
        size: FIG.note,
        fill: MUTED,
        anchor: "middle",
      }),
    );
  }
  T.push(txt(X1 + 14, axisTop - 4, "long trip", { size: FIG.note, fill: MUTED }));
  const fy = axisBot + 32;
  T.push(
    txt(
      16,
      fy,
      `×N: the long trip against Rust native. Every answer checked against Node's: routes identical, numbers within ${need(BENCH, "parityBound")} relative.`,
      { size: FIG.note, fill: MUTED },
    ),
  );
  const yy = fy + 34;
  T.push(...footer(yy, `bench/route-planner-bench.json · ${MACHINE}`));
  writeFigData("fig-route-engines", "The figure's numbers as a table", {
    align: ["l", "r", "r", "r", "r"],
    head: ["engine", "short", "medium", "long", "long vs Rust native"],
    rows: rowsOut,
    fields:
      "`bench/route-planner-bench.json`: `results.<trip>.<engine>.medianMs`, `engines[].label`, `rounds`, `parityBound`, `workload.trips[].miles`.",
  });
  return svgDoc(
    yy + 12,
    `Twelve engines plan the same three trips on a log time axis: Rust native plans the long trip in ${secs(native)}, the TypeScript engine in Node in ${secs(ms("long", "node"))}, Static Hermes on the tuned typed port with C calls in ${secs(ms("long", "shermes-typed-ffi"))}, and Hermes 0.14.1 in ${secs(ms("long", "hermes-classic"))}.`,
    T,
  );
}

// ============================================================================
// fig-route-parity — where each engine differs from V8 in the last bits
// ============================================================================
// The contract report's Math rows (engine-rs/test/parity.test.ts), by the short label the figure
// draws; a row the figure does not know fails it, so a changed domain is relabelled on purpose.
const MATH_LABELS = {
  "log: 1 - next(), as normal() and exponential() draw it": "log of 1 - next()",
  "log: [1e-3, 1e3], log-uniform": "log, 1e-3 to 1e3",
  "cos: 2π·next(), as normal() draws it": "cos of 2 pi next()",
  "cos: latitudes 0–60° in radians (geo.ts)": "cos of latitudes",
  "sin: half a coordinate difference, |Δ| < 0.5° (geo.ts)": "sin of half a coordinate step",
  "sin: [-π, π]": "sin, -pi to pi",
  "tan: latitudes 0–60° in radians (tileKey)": "tan of latitudes",
  "asin: √h of a distance under 50 km, [0, 0.004]": "asin, distances under 50 km",
  "asin: [0, 1]": "asin, 0 to 1",
  "atan2: y, x in [-1, 1] (bearing)": "atan2, bearings",
  "exp: [-20, 5] (gap acceptance)": "exp, -20 to 5",
  "expm1: [-20, 0] (gap acceptance)": "expm1, -20 to 0",
  "pow: x in (0, 3], y in [0, 4] (traffic.ts's ** terms)": "pow, traffic's x ** y",
  "pow: x ** 2 (geo.ts)": "pow, x ** 2",
  "sqrt: [0, 1e4]": "sqrt, 0 to 1e4",
};
function figRouteParity() {
  const math = need(FIXES, "parity.contracts.math");
  const keys = Object.keys(math);
  if (keys.length < 8) throw new Error("route-parity: the contract report has too few Math rows");
  // keys hold dots ("geo.ts"): read each row as an object, not by a dotted path
  const rows = keys.map((k) => ({
    k,
    n: count(math[k], "n"),
    differ: count(math[k], "differ"),
    maxUlps: count(math[k], "maxUlps"),
  }));
  for (const r of rows)
    if (r.maxUlps > 1) throw new Error(`route-parity: ${r.k} differs by more than one ulp`);
  const engines = need(BENCH, "engines")
    .map((e) => str(e, "id"))
    .filter((id) => id !== "node");
  const long = need(BENCH, "results.long");
  const eng = engines.map((id) => ({
    id,
    label: str(
      need(BENCH, "engines").find((e) => e.id === id),
      "label",
    ),
    numbers: count(long, `${id}.parity.numbers`),
    differ: count(long, `${id}.parity.differ`),
    maxRel: num(long, `${id}.parity.maxRel`),
  }));
  const T = [];
  T.push(
    ...figTitle(
      16,
      24,
      "Where the engines differ from V8: the last bit",
      "libm (Rust's, and Hermes' and Scriptc's C library) against V8's own Math",
    ).parts,
  );
  // left: share of 10^6 inputs per function and domain whose result differs by one ulp
  const lx = 16,
    bx0 = 176,
    bw = 100;
  const maxShare = Math.max(...rows.map((r) => r.differ / r.n));
  let y = 82;
  T.push(
    txt(lx, y - 20, `Math through libm against V8, ${int(rows[0].n)} inputs each:`, {
      size: FIG.note,
      fill: MUTED,
    }),
  );
  T.push(txt(lx, y - 8, "the share one ulp apart", { size: FIG.note, fill: MUTED }));
  for (const r of rows) {
    y += 17;
    const shown = MATH_LABELS[r.k];
    if (!shown) throw new Error(`route-parity: no label for the Math row "${r.k}"`);
    T.push(txt(lx, y + 3, shown, { size: FIG.note }));
    const share = r.differ / r.n;
    if (share > 0)
      T.push(
        `<rect x="${bx0}" y="${y - 6}" width="${Math.max(1, (share / maxShare) * bw).toFixed(1)}" height="9" rx="1.5" fill="${REPO.mark}"/>`,
      );
    T.push(
      txt(bx0 + bw + 8, y + 3, `${(share * 100).toFixed(share < 0.001 && share > 0 ? 3 : 2)}%`, {
        size: FIG.note,
        fill: MUTED,
      }),
    );
  }
  // right: every engine on the long trip
  const rx = 352;
  let ey = 82;
  T.push(txt(rx, ey - 20, "The long trip's answer: the numbers", { size: FIG.note, fill: MUTED }));
  T.push(
    txt(rx, ey - 8, "differing from Node's in the last bits", { size: FIG.note, fill: MUTED }),
  );
  for (const e of eng) {
    ey += 17;
    const n = `${int(e.differ)} of ${int(e.numbers)}`;
    if (approxW(e.label, FIG.note) + approxW(n, FIG.note) + 8 > W - 16 - rx)
      throw new Error(`route-parity: "${e.label}" and its count do not fit their row`);
    T.push(txt(rx, ey + 3, e.label, { size: FIG.note }));
    T.push(txt(W - 16, ey + 3, n, { size: FIG.note, fill: MUTED, anchor: "end" }));
  }
  const worst = Math.max(...eng.map((e) => e.maxRel));
  ey += 22;
  for (const ln of wrapPx(
    `Largest relative difference: ${worst.toExponential(1)}. Routes, strings and leave-by times identical in every engine.`,
    FIG.note,
    W - 16 - rx,
  ))
    (T.push(txt(rx, ey, ln, { size: FIG.note, fill: MUTED })), (ey += 13));
  const y2 = Math.max(y, ey) + 40;
  T.push(
    ...footer(y2, `bench/route-planner-fixes.json · bench/route-planner-bench.json · ${MACHINE}`),
  );
  writeFigData("fig-route-parity", "The figure's numbers as tables", {
    lead: mdTable(
      ["Math function and domain", "inputs", "one ulp apart", "max ulps"],
      rows.map((r) => [r.k, int(r.n), int(r.differ), String(r.maxUlps)]),
      ["l", "r", "r", "r"],
    ),
    align: ["l", "r", "r", "r"],
    head: ["engine (the long trip)", "numbers", "differ from Node's", "max relative"],
    rows: eng.map((e) => [
      e.label,
      int(e.numbers),
      int(e.differ),
      e.maxRel ? e.maxRel.toExponential(2) : "0",
    ]),
    fields:
      "`bench/route-planner-fixes.json`: `parity.contracts.math.<row>.{n,differ,maxUlps}`. `bench/route-planner-bench.json`: `results.long.<engine>.parity.{numbers,differ,maxRel}`.",
  });
  return svgDoc(
    y2 + 12,
    `Where the engines differ from V8: libm's exp, log, cos, pow and the rest differ from V8's in the last bit on up to ${(maxShare * 100).toFixed(1)}% of inputs, never by more than one ulp; on the long trip each engine's answer differs from Node's in some numbers' last bits, at most ${worst.toExponential(1)} relative, with the same routes and leave-by times.`,
    T,
  );
}

const FIGURES = {
  "fig-route-graph": figRouteGraph,
  "fig-route-plan": figRoutePlan,
  "fig-route-curve": figRouteCurve,
  "fig-route-workload": figRouteWorkload,
  "fig-route-astar": figRouteAstar,
  "fig-route-engines": figRouteEngines,
  "fig-route-parity": figRouteParity,
};
const only = process.argv.slice(2);
for (const name of only)
  if (!Object.hasOwn(FIGURES, name))
    throw new Error(`unknown figure "${name}" — one of: ${Object.keys(FIGURES).join(", ")}`);
for (const [name, draw] of Object.entries(FIGURES))
  if (only.length === 0 || only.includes(name)) emit(name, draw());
void MACHINE_SERIES;

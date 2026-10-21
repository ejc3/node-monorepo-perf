#!/usr/bin/env node
// What each fix the planner needed bought (ROUTE-PLANNER.md), on the bench's machine, written
// to bench/route-planner-fixes.json:
//
//   astar     The A* estimate, as it was before and after each change, in the TypeScript engine
//             on Node: straight-line distance at the fastest speed (straight); the free-flow
//             bound searched to exhaustion per destination, and per penalized attempt (bound);
//             grown lazily (lazy); departure curves no longer summing hotspots (skip); the
//             backward search capped for an origin that cannot reach the destination (now, the
//             code in route-planner/engine). Each variant plans the three trips and one from an
//             origin that cannot reach its destination: three fresh-process runs each (median),
//             one run with counters (searches, edges settled, movement buckets drawn, vertices
//             the bound settled, simulations, mornings, junction crossings), one CPU profile of
//             the long trip by where the time goes. Every variant must give the same answer
//             as `now` on every trip.
//   scriptc   Scriptc 0.4.0 on the engine before its rewrites (coverage: the statements it
//             cannot compile), and the plan with traffic terms in a WeakMap keyed by edges,
//             native and in Node, on the short trip (native capped at ROUTE_WEAKMAP_TIMEOUT_S).
//   rustPow   Rust native with the libm crate's pow (fdlibm) against pow.rs, on the long trip.
//   parity    engine-rs's contract measurements (PRNG, Math through libm against V8, pack
//             decoding) and the golden trips through every engine against TypeScript.
//
//   ROUTE_ROOT=<dir> node scripts/route-planner/fixes.mjs     (after build.mjs)
//
// ROUTE_FIXES_QUICK=1 is a smoke run (the short and unreachable trips, one run each, a 60 s
// cap on the WeakMap build) into bench/route-planner-fixes.partial.json (gitignored).
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PLANNER, REPO, SPEC, compare, machine, planRequest, preRunLoad, root } from "./lib.mjs";
import { ASTAR, COUNTERS, PRE_SCRIPTC, WEAKMAP, variant as makeVariant } from "./variants.mjs";

const ROOT = root();
const build = JSON.parse(readFileSync(join(ROOT, "build.json"), "utf8"));
const PACK = join(ROOT, "pack.json");
const CHILD = join(REPO, "scripts", "route-planner", "fixes-child.mjs");
const QUICK = process.env.ROUTE_FIXES_QUICK === "1";
const RUNS = QUICK ? 1 : 3;
const V = join(ROOT, "variants");
const short = SPEC.trips.find((t) => t.id === "short");

// An origin on a stub of road that cannot reach the destination (two vertices reachable from
// it), 0.9 km from Santa Clara station: the case the bound's cap is for.
const UNREACHABLE = {
  id: "unreachable",
  name: "a road stub that cannot reach Santa Clara station",
  from: { lat: 37.344784, lon: -121.934292 },
  to: { lat: 37.353, lon: -121.9366 },
  arriveByMinute: 540,
};
const TRIPS = [...SPEC.trips, UNREACHABLE].filter((t) => !QUICK || t.id === "short" || t.id === "unreachable");

const variant = (name, edits) => makeVariant(V, name, edits);

const REQ = join(ROOT, "fixes-requests");
mkdirSync(REQ, { recursive: true });
const reqFile = (trip) => {
  const f = join(REQ, `${trip.id}.json`);
  writeFileSync(f, planRequest(trip));
  return f;
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
function child(dir, trip, nodeArgs = [], answerFile) {
  const r = spawnSync(process.execPath, [...nodeArgs, CHILD, dir, PACK, reqFile(trip), ...(answerFile ? [answerFile] : [])], {
    encoding: "utf8",
    maxBuffer: 2 ** 28,
    timeout: 30 * 60_000,
  });
  if (r.status !== 0) throw new Error(`${dir} ${trip.id}: exited ${r.status}: ${(r.stderr || "").slice(-1500)}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

// Where a CPU profile's plan time goes: each sample under planTrip, by the nearest of these
// frames above it (the profiler keeps inlined frames). Garbage collection samples sit outside
// planTrip's stack and are not counted: the shares are of the plan's JavaScript samples.
const CATEGORY = {
  delay: "movement statistics",
  freeFlowTo: "A* estimate",
  backward: "A* estimate",
  maxSpeed: "A* estimate",
  shortestPath: "A* search",
  simulateRoute: "simulation",
  simulateMornings: "simulation",
};
function profileShares(file) {
  const prof = JSON.parse(readFileSync(file, "utf8"));
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const hits = {};
  let total = 0;
  for (const n of prof.nodes) {
    if (!n.hitCount) continue;
    let cat = null, inPlan = false;
    for (let id = n.id; id !== undefined; id = parent.get(id)) {
      const f = byId.get(id).callFrame.functionName;
      if (!cat && CATEGORY[f]) cat = CATEGORY[f];
      if (f === "planTrip") { inPlan = true; break; }
    }
    if (!inPlan) continue;
    cat ??= "other";
    hits[cat] = (hits[cat] ?? 0) + n.hitCount;
    total += n.hitCount;
  }
  if (!(total > 100)) throw new Error(`${file}: ${total} samples under planTrip`);
  return { samples: total, shares: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, +(v / total).toFixed(4)])) };
}

const preRunLoadAvg1 = preRunLoad();
const startMachine = machine();

// --- A* -----------------------------------------------------------------------------------
const astar = { variants: Object.keys(ASTAR), trips: TRIPS.map(({ id, name }) => ({ id, name })), results: {} };
// each variant twice: as timed, and with the counters (which change no arithmetic)
const plain = {};
for (const [k, [edits, boundCounter]] of Object.entries(ASTAR)) {
  plain[k] = variant(k, edits);
  variant(`${k}-counted`, [...edits, ...boundCounter, ...COUNTERS]);
}
for (const trip of TRIPS) {
  for (const k of Object.keys(ASTAR)) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(child(plain[k], trip));
    const counted = child(join(V, `${k}-counted`), trip);
    if (new Set([...runs, counted].map((r) => r.answerSha256)).size !== 1)
      throw new Error(`${k} ${trip.id}: the runs' answers differ`);
    (astar.results[trip.id] ??= {})[k] = {
      samplesMs: runs.map((r) => r.ms),
      medianMs: +median(runs.map((r) => r.ms)).toFixed(1),
      answerSha256: runs[0].answerSha256,
      routes: runs[0].routes,
      counters: counted.counters,
      movements: counted.movements,
      movementPairs: counted.movementPairs,
    };
    console.log(`astar ${trip.id} ${k}: ${(median(runs.map((r) => r.ms)) / 1000).toFixed(2)} s, ${counted.counters.searches} searches, ${counted.counters.boundSettled} bound vertices`);
  }
  const now = astar.results[trip.id].now.answerSha256;
  for (const k of Object.keys(ASTAR))
    if (astar.results[trip.id][k].answerSha256 !== now) throw new Error(`${k} ${trip.id}: a different answer from now's`);
}
astar.map = child(plain.now, TRIPS[0]).map;
const PROF = join(ROOT, "fixes-profiles");
astar.profiles = {};
for (const k of Object.keys(ASTAR)) {
  const dir = join(PROF, k);
  rmSync(dir, { recursive: true, force: true });
  child(plain[k], QUICK ? short : SPEC.trips[0], ["--cpu-prof", `--cpu-prof-dir=${dir}`]);
  const [file] = readdirSync(dir).filter((f) => f.endsWith(".cpuprofile"));
  astar.profiles[k] = profileShares(join(dir, file));
}

// --- Scriptc --------------------------------------------------------------------------------
const SCRIPTC = join(process.env.SCRIPTC_HOME || join(process.env.HOME, ".cache", "scriptc-0.4.0"), "bin", "scriptc");
const coverage = (dir) => {
  const r = spawnSync(SCRIPTC, ["coverage", "engine-lib.ts", "--tier", "static-only"], {
    cwd: join(dir, "native"),
    encoding: "utf8",
  });
  // paths relative to the variant, so the record names no directory of the machine's
  const text = ((r.stdout || "") + (r.stderr || "")).split(`${dir}/`).join("");
  const num = (re) => {
    const v = Number(re.exec(text)?.[1] ?? NaN);
    if (!Number.isInteger(v)) throw new Error(`scriptc coverage: no count in its output: ${text.slice(0, 300)}`);
    return v;
  };
  return {
    statements: num(/statements analyzed\s+(\d+)/),
    static: num(/compile statically\s+(\d+)/),
    exitStatus: r.status,
    output: text.trim().split("\n").map((l) => l.trimEnd()),
  };
};
const pre = variant("pre-scriptc", PRE_SCRIPTC);
const weak = variant("weakmap", WEAKMAP);
const nativeLib = (dir) => {
  execFileSync(join(dir, "native", "build.sh"), [join(dir, "out")], { stdio: "inherit" });
  return join(dir, "out", "probe");
};
// the WeakMap build first: native/build.sh fetches Scriptc when it is not there yet
const weakProbe = nativeLib(weak);
const scriptc = { before: coverage(pre), now: coverage(plain.now), weakmap: {} };
const probeRun = (bin, trip, timeoutS) => {
  const calls = join(REQ, `${trip.id}.tsv`);
  writeFileSync(calls, `plan\t${planRequest(trip)}\n`);
  const r = spawnSync(bin, [PACK, calls], { encoding: "utf8", maxBuffer: 2 ** 28, timeout: timeoutS * 1000 });
  // only the timeout's own kill counts as one: any other signal or error is a failure
  if (r.error?.code === "ETIMEDOUT") return { timedOut: true, ceilingMs: timeoutS * 1000 };
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${bin}: exited ${r.status}: ${(r.stderr || "").slice(-800)}`);
  return { timedOut: false, ms: Number(/plan (\d+) ms/.exec(r.stderr)[1]), answer: r.stdout.trim() };
};
const WEAK_TIMEOUT = Number(process.env.ROUTE_WEAKMAP_TIMEOUT_S ?? (QUICK ? 60 : 900));
scriptc.weakmap.native = probeRun(weakProbe, short, WEAK_TIMEOUT);
scriptc.weakmap.nativeNow = probeRun(join(ROOT, "scriptc", "probe"), short, WEAK_TIMEOUT);
const nodeWeak = [], nodeNow = [];
for (let i = 0; i < RUNS; i++) {
  nodeWeak.push(child(weak, short));
  nodeNow.push(child(plain.now, short));
}
if (new Set([...nodeWeak, ...nodeNow].map((r) => r.answerSha256)).size !== 1)
  throw new Error("weakmap: a different answer in Node");
scriptc.weakmap.node = { samplesMs: nodeWeak.map((r) => r.ms), medianMs: +median(nodeWeak.map((r) => r.ms)).toFixed(1) };
scriptc.weakmap.nodeNow = { samplesMs: nodeNow.map((r) => r.ms), medianMs: +median(nodeNow.map((r) => r.ms)).toFixed(1) };
// Node's answer for a trip, to check the native answers against (within the last bits).
const nodeAnswer = (trip) => {
  const f = join(REQ, `${trip.id}.answer.json`);
  child(plain.now, trip, [], f);
  return JSON.parse(readFileSync(f, "utf8"));
};
const withinLastBits = (ref, r, what) => {
  const acc = { numbers: 0, differ: 0, maxRel: 0 };
  compare(ref, JSON.parse(r.answer), what, "", acc);
  delete r.answer;
  return acc;
};
const shortRef = nodeAnswer(short);
for (const k of ["native", "nativeNow"])
  if (!scriptc.weakmap[k].timedOut) scriptc.weakmap[k].parity = withinLastBits(shortRef, scriptc.weakmap[k], `scriptc ${k}`);

// --- Rust pow -------------------------------------------------------------------------------
const rs = join(PLANNER, "engine-rs");
const fdTarget = join(ROOT, "cargo-fdlibm");
execFileSync("cargo", ["build", "--release", "--locked", "--features", "fdlibm-pow"], {
  cwd: rs,
  env: { ...process.env, CARGO_TARGET_DIR: fdTarget },
  stdio: "inherit",
});
mkdirSync(join(ROOT, "rust-fdlibm"), { recursive: true });
const fdProbe = join(ROOT, "rust-fdlibm", "probe");
execFileSync("cc", ["-O2", join(PLANNER, "native", "probe.c"), join(fdTarget, "release", "libroute_planner_engine.a"), "-lm", "-lpthread", "-ldl", "-o", fdProbe]);
const long = QUICK ? short : SPEC.trips[0];
const rustPow = { trip: long.id, powRs: [], fdlibm: [] };
const rustProbe = join(rs, "pkg", "native", "probe");
for (let i = 0; i < RUNS; i++) {
  for (const [k, bin] of [["powRs", rustProbe], ["fdlibm", fdProbe]]) {
    const r = probeRun(bin, long, 600);
    if (r.timedOut) throw new Error(`rust ${k} timed out`);
    rustPow[k].push(r);
  }
}
// fdlibm's pow and pow.rs differ in a last bit here and there: both answers are checked
// against Node's within the same bounds as the bench's.
const longRef = nodeAnswer(long);
for (const k of ["powRs", "fdlibm"]) {
  const parity = rustPow[k].map((r, i) => withinLastBits(longRef, r, `rust ${k} run ${i + 1}`))[0];
  rustPow[k] = { samplesMs: rustPow[k].map((r) => r.ms), medianMs: median(rustPow[k].map((r) => r.ms)), parity };
}

// --- parity ------------------------------------------------------------------------------------
const parity = {};
for (const [k, file, env] of [
  ["contracts", "parity.test.ts", {}],
  ["goldenTrips", "engine-parity.test.ts", { SCRIPTC_PROBE: join(ROOT, "scriptc", "probe") }],
]) {
  const out = join(ROOT, `parity-${k}.json`);
  execFileSync(process.execPath, ["--test", "--test-concurrency=1", join(rs, "test", file)], {
    env: { ...process.env, ...env, PARITY_REPORT: out },
    stdio: "inherit",
  });
  parity[k] = JSON.parse(readFileSync(out, "utf8"));
}

if (JSON.stringify(machine()) !== JSON.stringify(startMachine))
  throw new Error("the machine's fields changed during the run");
const record = {
  generator: "scripts/route-planner/fixes.mjs",
  machine: startMachine,
  preRunLoadAvg1,
  versions: build.versions,
  packSha256: build.packSha256,
  runs: RUNS,
  unreachable: UNREACHABLE,
  astar,
  scriptc,
  rustPow,
  parity,
};
const OUT = join(REPO, "bench", QUICK ? "route-planner-fixes.partial.json" : "route-planner-fixes.json");
writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
console.log(`wrote ${OUT}`);

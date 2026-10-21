#!/usr/bin/env node
// The route-planner bench (ROUTE-PLANNER.md): every engine plans every trip in trips.json,
// each run in a fresh process with a freshly loaded area, ROUTE_ROUNDS rounds (default 3) with
// the engine order rotated each round. Only the plan call is timed, by the engine itself:
// loading and building the area is not. Every answer is checked against Node's for the same
// trip: the same structure with keys in the same order, the same strings, booleans and nulls,
// every route coordinate the same double, every other number within 1e-12 relative. A run that
// fails, refuses or differs beyond that throws: no record is written.
//
//   ROUTE_ROOT=<dir> node scripts/route-planner/build.mjs
//   ROUTE_ROOT=<dir> node scripts/route-planner/bench.mjs [--out bench/route-planner-bench.json]
//
// ROUTE_ONLY=<engine,...> and ROUTE_TRIPS=<trip,...> run a subset and write
// bench/route-planner-bench.partial.json (gitignored) instead of the record.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAST_BITS, REPO, SPEC, compare, machine, pack, planRequest, preRunLoad, root } from "./lib.mjs";

const ROOT = root();
const build = JSON.parse(readFileSync(join(ROOT, "build.json"), "utf8"));
const ROUNDS = Number(process.env.ROUTE_ROUNDS ?? 3);
const only = process.env.ROUTE_ONLY?.split(",");
const onlyTrips = process.env.ROUTE_TRIPS?.split(",");
const canonical = !only && !onlyTrips && ROUNDS === 3;
const outArg = process.argv.indexOf("--out");
const OUT =
  outArg > 0
    ? process.argv[outArg + 1]
    : join(REPO, "bench", canonical ? "route-planner-bench.json" : "route-planner-bench.partial.json");
if (!(ROUNDS >= 2)) throw new Error("ROUTE_ROUNDS must be at least 2");

const PACK = join(ROOT, "pack.json");
const NODE_PLAN = join(REPO, "scripts", "route-planner", "node-plan.mjs");
const PROBE = join(REPO, "route-planner", "engine-rs", "pkg", "native", "probe");
const HC = join(ROOT, "hermes", "classic", "bin", "hermes");
const HV1 = join(ROOT, "hermes", "v1", "bin", "hermes");
const T = (trip, f) => join(ROOT, "trips", trip, f);
const node = (engine) => (trip) => [process.execPath, [NODE_PLAN, engine, PACK, T(trip, "request.json")]];
const probe = (bin) => (trip) => [bin, [PACK, T(trip, "calls.tsv")]];

// id, label, family (what the figures group by), the command for a trip
const ENGINES = [
  { id: "node", label: "TypeScript in Node", family: "v8", cmd: node("ts") },
  { id: "rust-native", label: "Rust, native", family: "native", cmd: probe(PROBE) },
  { id: "rust-wasm", label: "Rust, WebAssembly in Node", family: "v8", cmd: node("wasm") },
  { id: "scriptc", label: "Scriptc, native", family: "native", cmd: probe(join(ROOT, "scriptc", "probe")) },
  { id: "hermes-classic", label: "Hermes 0.14.1", family: "hermes", cmd: (t) => [HC, [T(t, "classic.hbc")]] },
  { id: "hermes-v1", label: "Hermes V1", family: "hermes", cmd: (t) => [HV1, [T(t, "v1.hbc")]] },
  {
    id: "hermes-v1-1g",
    label: "Hermes V1, 1 GB starting heap",
    family: "hermes",
    cmd: (t) => [HV1, ["-gc-init-heap=1G", T(t, "v1.hbc")]],
  },
  {
    id: "hermes-v1-babel",
    label: "Hermes V1, React Native's Babel preset",
    family: "hermes",
    cmd: (t) => [HV1, [T(t, "v1-babel.hbc")]],
  },
  { id: "shermes", label: "Static Hermes, untyped", family: "hermes", cmd: (t) => [T(t, "shermes"), []] },
  { id: "shermes-typed", label: "Static Hermes, typed port", family: "hermes", cmd: (t) => [T(t, "typed-port"), []] },
  {
    id: "shermes-typed-tuned",
    label: "Static Hermes, typed port, tuned",
    family: "hermes",
    cmd: (t) => [T(t, "typed-tuned"), []],
  },
  {
    id: "shermes-typed-ffi",
    label: "Static Hermes, typed port, tuned, C calls",
    family: "hermes",
    cmd: (t) => [T(t, "typed-ffi"), []],
  },
].filter((e) => !only || only.includes(e.id));
if (only && !ENGINES.some((e) => e.id === "node")) ENGINES.unshift({ id: "node", label: "TypeScript in Node", family: "v8", cmd: node("ts") });
const TRIPS = SPEC.trips.filter((t) => !onlyTrips || onlyTrips.includes(t.id));
// The build's inputs must be today's: the record states the request and pack it ran.
if (pack().sha256 !== build.packSha256)
  throw new Error("ROUTE_ROOT was built from another area pack: run build.mjs again");
for (const t of TRIPS)
  if (readFileSync(T(t.id, "request.json"), "utf8") !== planRequest(t))
    throw new Error(`${t.id}: ROUTE_ROOT was built from another trips.json: run build.mjs again`);

/** One run: the answer's text and the plan call's milliseconds as the engine timed it. */
function runOnce(engine, trip) {
  const [cmd, args] = engine.cmd(trip.id);
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 2 ** 30, timeout: 30 * 60_000 });
  if (r.error) throw new Error(`${engine.id} ${trip.id}: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(`${engine.id} ${trip.id}: exited ${r.status}: ${(r.stderr || "").slice(-1500)}`);
  const lines = r.stdout.split("\n");
  const answer = lines.find((l) => l.startsWith('{"ok"') || l.startsWith('{"error"'));
  if (!answer) throw new Error(`${engine.id} ${trip.id}: no answer in its output`);
  if (!answer.startsWith('{"ok"')) throw new Error(`${engine.id} ${trip.id}: refused: ${answer.slice(0, 300)}`);
  // "plan ms N" on stdout (Node, Hermes), "plan N ms" on stderr (the probes).
  const m = /^plan ms ([\d.]+)$/m.exec(r.stdout) ?? /^plan ([\d.]+) ms$/m.exec(r.stderr);
  if (!m) throw new Error(`${engine.id} ${trip.id}: no plan time in its output`);
  const ms = Number(m[1]);
  if (!(ms > 0)) throw new Error(`${engine.id} ${trip.id}: plan time ${m[1]} is not a positive number`);
  return { text: answer, ms };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

const preRunLoadAvg1 = preRunLoad();
const startMachine = machine();
const results = {};
const reference = {};
for (let round = 0; round < ROUNDS; round++) {
  // Node first (the reference), the others rotated by one each round
  const others = ENGINES.filter((e) => e.id !== "node");
  const order = others.map((_, i) => others[(i + round) % others.length]);
  for (const trip of TRIPS) {
    // Node first in every round's trip: the reference the others are checked against.
    for (const engine of [ENGINES.find((e) => e.id === "node"), ...order]) {
      const { text, ms } = runOnce(engine, trip);
      const cell = ((results[trip.id] ??= {})[engine.id] ??= {
        samplesMs: [],
        parity: { numbers: 0, differ: 0, maxRel: 0, identical: true },
      });
      cell.samplesMs.push(ms);
      if (engine.id === "node") {
        if (reference[trip.id] === undefined) reference[trip.id] = text;
        else if (text !== reference[trip.id])
          throw new Error(`node ${trip.id}: round ${round + 1}'s answer differs from round 1's`);
      }
      // One parity count per engine and trip (the first round's run), every run checked.
      const acc = { numbers: 0, differ: 0, maxRel: 0 };
      compare(JSON.parse(reference[trip.id]), JSON.parse(text), `${engine.id} ${trip.id}`, "", acc);
      if (round === 0) Object.assign(cell.parity, acc, { identical: text === reference[trip.id] });
      console.log(
        `round ${round + 1} ${trip.id} ${engine.id}: ${(ms / 1000).toFixed(2)} s, ${acc.differ} of ${acc.numbers} numbers differ in the last bits`,
      );
    }
  }
}
if (JSON.stringify(machine()) !== JSON.stringify(startMachine))
  throw new Error("the machine's fields changed during the run");

for (const trip of TRIPS)
  for (const e of ENGINES) {
    const c = results[trip.id][e.id];
    c.medianMs = +median(c.samplesMs).toFixed(1);
    c.minMs = Math.min(...c.samplesMs);
    c.maxMs = Math.max(...c.samplesMs);
  }

const record = {
  generator: "scripts/route-planner/bench.mjs",
  canonical,
  machine: startMachine,
  preRunLoadAvg1,
  versions: build.versions,
  programs: build.programs,
  rounds: ROUNDS,
  parityBound: LAST_BITS,
  workload: {
    area: SPEC.area,
    packSha256: build.packSha256,
    request: SPEC.request,
    trips: TRIPS.map((t) => {
      const ok = JSON.parse(reference[t.id]).ok;
      return {
        ...t,
        answerSha256: createHash("sha256").update(reference[t.id]).digest("hex"),
        routes: ok.routes.length,
        miles: ok.routes.map((r) => +r.miles.toFixed(2)),
        leaveBy: ok.routes.map((r) => r.leaveBy),
        // the first route's departure curve and leave-by departure, for the figures
        curve: ok.routes[0].curve,
        atLeaveBy: ok.routes[0].atLeaveBy,
        hotspots: ok.routes[0].hotspots.map(({ control, assumed, typicalSec, badSec }) => ({ control, assumed, typicalSec, badSec })),
      };
    }),
  },
  engines: ENGINES.map(({ id, label, family }) => ({ id, label, family })),
  results,
};
writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
console.log(`wrote ${OUT}`);

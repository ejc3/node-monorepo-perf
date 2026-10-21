// The Rust engine (and, given SCRIPTC_PROBE, the Scriptc library) against the TypeScript engine
// on the golden trips (golden.ts: the bench's three trips and 20 random ones): each trip planned
// (300 runs, a 60-minute window, 5-minute steps) on one loaded area, in order, then a call that
// must refuse and a plan after it.
//
// - Rust native and Rust WebAssembly: the same bytes, every call.
// - Every native engine against TypeScript, every answer parsed: the same structure, keys in the
//   same order, strings, booleans and nulls; routes identical (every coordinate of every line the
//   same double); every other number within 1e-12 relative (V8's Math and libm differ in a last
//   bit or two).
//
// Run: engine-rs/build-wasm.sh && engine-rs/build-native.sh, then
//   node --test engine-rs/test/engine-parity.test.ts
// PARITY_REPORT=<file> writes the measurements as JSON.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { packText, planRequest, SPEC } from "../../area.ts";
import { loadRustWasm, loadTs, runNative, type Answer, type Call } from "./engines.ts";
import { goldenTrips } from "./golden.ts";

/** Within this relative difference two doubles are the same number with a different last bit or two. */
const LAST_BITS = 1e-12;

interface EngineReport { calls: number; numbers: number; differ: number; maxRel: number; ms: number }
const report: { trips: number; engines: Record<string, EngineReport> } = { trips: 0, engines: {} };

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** The numbers that must be the same double: a route is the same route. */
const COORDINATES = new Set(["line"]);

function compare(ts: Json, rs: Json, place: string, key: string, r: EngineReport, problems: string[]): void {
  if (problems.length > 20) return;
  if (typeof ts === "number" && typeof rs === "number") {
    r.numbers++;
    if (Object.is(ts, rs)) return;
    r.differ++;
    const rel = Math.abs(ts - rs) / Math.max(Math.abs(ts), Math.abs(rs));
    r.maxRel = Math.max(r.maxRel, rel);
    if (COORDINATES.has(key)) problems.push(`${place}: the route differs (${ts} against ${rs})`);
    else if (rel > LAST_BITS) problems.push(`${place}: ${ts} against ${rs} (relative ${rel.toExponential(2)})`);
    return;
  }
  if (Array.isArray(ts) && Array.isArray(rs)) {
    if (ts.length !== rs.length) { problems.push(`${place}: ${ts.length} items against ${rs.length}`); return; }
    for (let i = 0; i < ts.length; i++) compare(ts[i]!, rs[i]!, `${place}[${i}]`, key, r, problems);
    return;
  }
  if (ts && rs && typeof ts === "object" && typeof rs === "object" && !Array.isArray(ts) && !Array.isArray(rs)) {
    const a = Object.keys(ts), b = Object.keys(rs);
    // The same keys in the same order: JSON.stringify's order is the objects' literal order.
    if (a.join(",") !== b.join(",")) { problems.push(`${place}: keys ${a.join(",")} against ${b.join(",")}`); return; }
    for (const k of a) compare(ts[k]!, rs[k]!, `${place}.${k}`, k, r, problems);
    return;
  }
  if (ts !== rs) problems.push(`${place}: ${JSON.stringify(ts)?.slice(0, 200)} against ${JSON.stringify(rs)?.slice(0, 200)}`);
}

const trips = goldenTrips();
const calls: Call[] = [
  ...trips.map((t) => ({ op: "plan", req: planRequest({ from: t.from, to: t.to, arriveByMinute: t.arriveBy }) })),
  // A refusal (an unknown call), then a plan still answers.
  { op: "nonsense", req: "{}" },
  { op: "plan", req: planRequest({ from: trips[2]!.from, to: trips[2]!.to, arriveByMinute: 540 }, { ...SPEC.request, runs: 30, windowMinutes: 10 }) },
];
const label = (i: number) => (i < trips.length ? trips[i]!.label : `refusal ${i - trips.length}`);

const scratch = mkdtempSync(join(tmpdir(), "rp-golden-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const text = packText();
const packFile = join(scratch, `${SPEC.area}.json`);
writeFileSync(packFile, text);

const ts = loadTs(SPEC.area, text);
const tsAnswers: Answer[] = calls.map((c) => ts.call(c));
report.trips = trips.length;

function check(name: string, answers: Answer[]) {
  const r: EngineReport = { calls: calls.length, numbers: 0, differ: 0, maxRel: 0, ms: answers.reduce((s, a) => s + a.ms, 0) };
  report.engines[name] = r;
  const problems: string[] = [];
  calls.forEach((_, i) => compare(JSON.parse(tsAnswers[i]!.text) as Json, JSON.parse(answers[i]!.text) as Json, label(i), "", r, problems));
  assert.deepEqual(problems, [], `${name}: ${problems.length} problems`);
}

test("every golden trip plans in TypeScript; the refusals refuse", () => {
  tsAnswers.forEach((a, i) => {
    const r = JSON.parse(a.text) as { ok?: unknown; error?: string };
    if (i < trips.length) assert.ok(r.ok, `${label(i)}: the TypeScript plan refused: ${r.error}`);
  });
  const errors = tsAnswers.slice(trips.length).map((a) => (JSON.parse(a.text) as { error?: string }).error);
  assert.equal(errors[0], "unknown call nonsense");
  assert.equal(errors[1], undefined, "and a plan after the refusal still answers");
});

test("Rust native = Rust WebAssembly byte for byte, and both = TypeScript within the bounds", () => {
  const wasm = loadRustWasm(SPEC.area, text);
  const wasmAnswers = calls.map((c) => wasm.call(c));
  wasm.free();
  const nativeAnswers = runNative(packFile, calls);
  calls.forEach((_, i) => {
    assert.equal(nativeAnswers[i]!.text, wasmAnswers[i]!.text, `${label(i)}: native and WebAssembly differ`);
  });
  check("rust-wasm", wasmAnswers);
  check("rust-native", nativeAnswers);
});

const scriptc = process.env["SCRIPTC_PROBE"];
test("the Scriptc library = TypeScript within the bounds", { skip: !scriptc && "set SCRIPTC_PROBE to native/build.sh's probe" }, () => {
  check("scriptc", runNative(packFile, calls, scriptc));
});

after(() => {
  const lines = ["", `Golden trips (${report.trips}), against TypeScript:`, "", "| engine | calls | numbers | differ in the last bits | max relative |", "|---|---|---|---|---|"];
  for (const [name, r] of Object.entries(report.engines)) lines.push(`| ${name} | ${r.calls} | ${r.numbers} | ${r.differ} | ${r.maxRel.toExponential(2)} |`);
  console.log(lines.join("\n"));
  const out = process.env["PARITY_REPORT"];
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
});

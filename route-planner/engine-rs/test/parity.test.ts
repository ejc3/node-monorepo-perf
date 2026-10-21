// The Rust engine's contracts against the TypeScript engine, through the WebAssembly build: the
// PRNG, the Math functions through libm (and pow.rs), the JavaScript-semantics helpers and pack
// decoding. Run: engine-rs/build-wasm.sh, then node --test engine-rs/test/parity.test.ts.
// PARITY_REPORT=<file> also writes the measurements as JSON.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { fromPack, type AreaPack } from "../../engine/src/pack.ts";
import { hash, rng } from "../../engine/src/random.ts";
import { packText, SPEC } from "../../area.ts";
import { calibrationJson, canonicalBytes, counts } from "./canonical.ts";
import { loadWasm } from "./wasm.ts";

const wasm = loadWasm();

// ── Comparing doubles ────────────────────────────────────────────────────────────────────────

const f64 = new Float64Array(1), i64 = new BigInt64Array(f64.buffer);
/** A double's place in the ordered line of doubles: neighbours differ by 1, -0 and +0 too. */
function ord(x: number): bigint {
  f64[0] = x;
  const b = i64[0]!;
  return b >= 0n ? b : -(b & 0x7fffffffffffffffn) - 1n;
}
/** Units in the last place between a and b: 0 for the same bits (any NaN equals any NaN). */
function ulps(a: number, b: number): number {
  if (Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b))) return 0;
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  const d = ord(a) - ord(b);
  return Number(d < 0n ? -d : d);
}

interface Diff { n: number; differ: number; maxUlps: number; byUlps: Record<string, number> }
function diff(ts: ArrayLike<number>, rs: ArrayLike<number>): Diff {
  assert.equal(rs.length, ts.length);
  const out: Diff = { n: ts.length, differ: 0, maxUlps: 0, byUlps: {} };
  for (let i = 0; i < ts.length; i++) {
    const u = ulps(ts[i]!, rs[i]!);
    if (u === 0) continue;
    out.differ++;
    out.maxUlps = Math.max(out.maxUlps, u);
    out.byUlps[u] = (out.byUlps[u] ?? 0) + 1;
  }
  return out;
}
const identical = (ts: Float64Array, rs: Float64Array) =>
  ts.length === rs.length && Buffer.from(ts.buffer, ts.byteOffset, ts.byteLength).equals(Buffer.from(rs.buffer, rs.byteOffset, rs.byteLength));

const report: { math: Record<string, Diff & { domain: string }>; draws: Record<string, Diff>; packs: Record<string, unknown> } = { math: {}, draws: {}, packs: {} };

/** n inputs from the TypeScript generator (so they are the same every run). */
function inputs(seed: number, n: number, f: (u: number, i: number) => number): Float64Array {
  const r = rng(seed), out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = f(r.next(), i);
  return out;
}
/** Random doubles over every exponent and sign: two 32-bit draws make one bit pattern. */
function bitPatterns(seed: number, n: number): Float64Array {
  const r = rng(seed), out = new Float64Array(n), u32 = new Uint32Array(out.buffer);
  for (let i = 0; i < 2 * n; i++) u32[i] = Math.floor(r.next() * 4294967296);
  return out;
}

const EDGES = [
  0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.49999999999999994, -0.49999999999999994, 1 - 2 ** -53, 2 ** 52 - 0.5, -(2 ** 52) + 0.5,
  2 ** 52 + 1, 2 ** 53, 2 ** 53 + 2, 2 ** 31, 2 ** 32, -(2 ** 31), 2 ** 32 + 1.5, 1e21, -1e21, 999999999999999900000, 1e-7, 1.5e-7, 9.999999999999998e-8,
  5e-324, -5e-324, 2.2250738585072014e-308, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, Number.EPSILON,
  0.1, 0.2, 0.30000000000000004, 1 / 3, 37.3377, -121.8853, 0.00390625, -0.00390625, 1.005, 1.0000000500000001, 123.45675,
  Infinity, -Infinity, NaN,
];

// ── The PRNG ─────────────────────────────────────────────────────────────────────────────────

const SEEDS = [
  0, 1, 2, 42, 0x9e3779b9, 0xffffffff, 2 ** 31, -1, -(2 ** 31), 2 ** 32, 2 ** 32 + 5, 1.5, -7.25, 1e10, 1e300, -0, NaN, Infinity, -Infinity,
  ...Array.from({ length: 200 }, (_, i) => hash(`${1000 + i}>${7 * i + 3}`)), // the router's per-movement seeds
  ...Array.from(inputs(20261021, 100, (u) => Math.floor(u * 4294967296))),
];

test("next() and uniform() are bit-identical for every seed", () => {
  for (const seed of SEEDS) {
    const r = rng(seed), w = new wasm.Rng(seed);
    const ts = new Float64Array(10_000).map(() => r.next());
    assert.ok(identical(ts, w.draws("next", 10_000, 0, 0)), `next() differs for seed ${seed}`);
    const tu = new Float64Array(1000).map(() => r.uniform(-3, 7.5));
    assert.ok(identical(tu, w.draws("uniform", 1000, -3, 7.5)), `uniform() differs for seed ${seed}`);
    // One draw at a time through the class, as the engine will call it.
    assert.equal(w.next(), r.next());
    w.free();
  }
});

test("a mixed stream stays in step: every next() and uniform() after normal, exponential and geometric draws is bit-identical", () => {
  const n = 200_000;
  for (const seed of [7, 20261021, hash("12>34")]) {
    const r = rng(seed);
    const ts = new Float64Array(n).map((_, i) => [r.next, r.normal, () => r.exponential(0.37), () => r.uniform(0.37, 9), () => r.geometric(0.5)][i % 5]!());
    const w = new wasm.Rng(seed), rs = w.draws("mixed", n, 0.37, 9);
    w.free();
    for (let i = 0; i < n; i += 5) {
      assert.ok(Object.is(rs[i], ts[i]) && Object.is(rs[i + 3], ts[i + 3]), `seed ${seed}: the stream left step by draw ${i}`);
    }
    report.draws[`mixed (seed ${seed})`] = diff(ts, rs);
  }
});

test("hash() is identical, on UTF-16 code units", () => {
  const strings = ["", "a", "12>34", "65660990>65497066", "Avenida Peña", "Straße", "日本橋", "🚗💨", " ", "x".repeat(1000),
    ...Array.from({ length: 2000 }, (_, i) => `${i * 7919}>${i * 104729 + 1}`)];
  for (const s of strings) assert.equal(wasm.hash(s), hash(s), JSON.stringify(s));
  for (const s of ["\ud83d", "a\udc00b", "\udc00\ud83d"]) {
    const units = Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
    assert.equal(wasm.hashUnits(units), hash(s), `lone surrogate ${JSON.stringify(s)}`);
  }
});

// normal() and exponential() go through log, cos and sqrt: bit-identical where V8's Math and
// libm agree. Measured on 1e6 draws (2026-10-21, Node 22.23): normal() 19959 differ, up to 3
// ulps; exponential() 17325, 1 ulp; geometric() none. Neither side is the more accurate: where
// they differ, each is the correctly rounded result about half the time (mpmath). The bounds sit
// just above the measurements, so a change in V8 or libm that widens them fails here. A floor()
// that a last bit tips over moves geometric() by a whole draw, so its ulps are not bounded.
const DRAW_BOUNDS = {
  normal: { share: 0.025, maxUlps: 3 },
  exponential: { share: 0.02, maxUlps: 1 },
  geometric: { share: 1e-4, maxUlps: Infinity },
};

test("normal(), exponential() and geometric(): 1e6 draws each, measured against TypeScript", () => {
  const n = 1_000_000, seed = 20261021;
  const kinds = [
    ["normal", (r: ReturnType<typeof rng>) => r.normal(), 0],
    ["exponential", (r: ReturnType<typeof rng>) => r.exponential(1), 1],
    ["geometric", (r: ReturnType<typeof rng>) => r.geometric(0.6), 0.6],
  ] as const;
  for (const [kind, draw, a] of kinds) {
    const r = rng(seed);
    const ts = new Float64Array(n).map(() => draw(r));
    const w = new wasm.Rng(seed), rs = w.draws(kind, n, a, 0);
    w.free();
    const d = diff(ts, rs);
    report.draws[kind] = d;
    const bound = DRAW_BOUNDS[kind];
    assert.ok(d.differ <= bound.share * n && d.maxUlps <= bound.maxUlps, `${kind}: ${d.differ} of ${n} differ, up to ${d.maxUlps} ulps`);
  }
});

// ── Math through libm ────────────────────────────────────────────────────────────────────────

const N = 1_000_000;
const rad = (deg: number) => (deg * Math.PI) / 180;
// Inputs are made when their row is measured: one domain's arrays alive at a time, not all of them.
const MATH: [name: string, op: string, domain: string, x: () => Float64Array, y: (() => Float64Array) | null, js: (x: number, y: number) => number][] = [
  ["log", "log", "1 - next(), as normal() and exponential() draw it", () => inputs(1, N, (u) => 1 - u), null, Math.log],
  ["log", "log", "[1e-3, 1e3], log-uniform", () => inputs(2, N, (u) => 10 ** (6 * u - 3)), null, Math.log],
  ["cos", "cos", "2π·next(), as normal() draws it", () => inputs(3, N, (u) => 2 * Math.PI * u), null, Math.cos],
  ["cos", "cos", "latitudes 0–60° in radians (geo.ts)", () => inputs(4, N, (u) => rad(60 * u)), null, Math.cos],
  ["sin", "sin", "half a coordinate difference, |Δ| < 0.5° (geo.ts)", () => inputs(5, N, (u) => rad(u - 0.5) / 2), null, Math.sin],
  ["sin", "sin", "[-π, π]", () => inputs(6, N, (u) => Math.PI * (2 * u - 1)), null, Math.sin],
  ["tan", "tan", "latitudes 0–60° in radians (tileKey)", () => inputs(7, N, (u) => rad(60 * u)), null, Math.tan],
  ["asin", "asin", "√h of a distance under 50 km, [0, 0.004]", () => inputs(8, N, (u) => 0.004 * u), null, Math.asin],
  ["asin", "asin", "[0, 1]", () => inputs(9, N, (u) => u), null, Math.asin],
  ["atan2", "atan2", "y, x in [-1, 1] (bearing)", () => inputs(10, N, (u) => 2 * u - 1), () => inputs(11, N, (u) => 2 * u - 1), Math.atan2],
  ["exp", "exp", "[-20, 5] (gap acceptance)", () => inputs(12, N, (u) => 25 * u - 20), null, Math.exp],
  ["expm1", "expm1", "[-20, 0] (gap acceptance)", () => inputs(13, N, (u) => -20 * u), null, Math.expm1],
  ["pow", "pow", "x in (0, 3], y in [0, 4] (traffic.ts's ** terms)", () => inputs(14, N, (u) => 3 * (1 - u)), () => inputs(15, N, (u) => 4 * u), (x, y) => x ** y],
  ["pow", "pow", "x ** 2 (geo.ts)", () => inputs(16, N, (u) => 2 * u - 1), () => new Float64Array(N).fill(2), (x, y) => x ** y],
  ["sqrt", "sqrt", "[0, 1e4]", () => inputs(17, N, (u) => 1e4 * u), null, Math.sqrt],
];

test("Math functions through libm (and pow.rs): 1e6 inputs each over the engine's domains, measured against V8", () => {
  for (const [name, op, domain, makeX, makeY, js] of MATH) {
    const x = makeX(), ys = makeY ? makeY() : new Float64Array(0);
    const ts = makeY ? x.map((v, i) => js(v, ys[i]!)) : x.map((v) => js(v, 0));
    const d = diff(ts, wasm.math(op, x, ys));
    report.math[`${name}: ${domain}`] = { ...d, domain };
    if (name === "sqrt") assert.equal(d.differ, 0, "sqrt is correctly rounded on both sides");
    // A last-bit difference is expected; more than one ulp would be a defect in a port.
    assert.ok(d.maxUlps <= 1, `${name} on ${domain}: up to ${d.maxUlps} ulps`);
  }
});

// ── The JavaScript-semantics helpers ─────────────────────────────────────────────────────────

const lattice = inputs(30, 200_000, (u) => Math.round((360 * u - 180) * 1e7) / 1e7); // pack coordinates
const halves = inputs(31, 100_000, (u, i) => Math.floor((u - 0.5) * 2e6) + (i % 2 ? 0.5 : 0));
const wide = inputs(32, 100_000, (u, i) => (u - 0.5) * 10 ** ((i % 40) - 20));
const bitsX = bitPatterns(33, 200_000);
const interpolated = inputs(34, 100_000, (u, i) => { const a = lattice[i]!, b = lattice[(i + 1) % lattice.length]!; return a + u * (b - a); });
const ties = Float64Array.from({ length: 20_000 }, (_, i) => (i - 10_000 + 0.5) / 256);
const all = (...xs: ArrayLike<number>[]) => Float64Array.from(xs.flatMap((x) => Array.from(x)));
const NUMBERS = all(EDGES, lattice, halves, wide, bitsX, interpolated, ties);

test("Math.round, floor, ceil, abs: identical, -0 and halves included", () => {
  for (const [op, js] of [["round", Math.round], ["floor", Math.floor], ["ceil", Math.ceil], ["abs", Math.abs]] as const) {
    const d = diff(NUMBERS.map(js), wasm.math(op, NUMBERS, new Float64Array(0)));
    assert.equal(d.differ, 0, `Math.${op}: ${d.differ} differ`);
  }
});

test("Math.max, Math.min, ** and % on edge cases: identical", () => {
  const xs: number[] = [], ys: number[] = [];
  for (const a of EDGES) for (const b of EDGES) { xs.push(a); ys.push(b); }
  const x = Float64Array.from(xs), y = Float64Array.from(ys);
  for (const [op, js] of [["max", Math.max], ["min", Math.min], ["rem", (a: number, b: number) => a % b]] as const) {
    assert.equal(diff(x.map((a, i) => js(a, y[i]!)), wasm.math(op, x, y)).differ, 0, op);
  }
  // ** on JavaScript's special cases, where C's pow answers otherwise: 1 ** NaN, (±1) ** ±Infinity.
  const special = [1, -1, 0, -0, NaN, Infinity, -Infinity, 2, 0.5, -2, -0.5];
  const sx: number[] = [], sy: number[] = [];
  for (const a of special) for (const b of [NaN, Infinity, -Infinity, 0, -0, 0.5, -0.5, 1, 2, -1, 3, -3]) { sx.push(a); sy.push(b); }
  const px = Float64Array.from(sx), py = Float64Array.from(sy);
  const want = px.map((a, i) => a ** py[i]!), got = wasm.math("pow", px, py);
  // Identical, except a finite base to the -0.5, which is no special case but plain arithmetic:
  // there ARM's pow (engine-rs/src/pow.rs) is the correctly rounded one and V8 an ulp off
  // (2 ** -0.5: 0.7071067811865476 against V8's 0.7071067811865475; 0.5 ** -0.5 likewise).
  const plain = (i: number) => py[i] === -0.5 && Number.isFinite(px[i]!) && px[i] !== 0;
  for (let i = 0; i < px.length; i++) {
    const u = ulps(want[i]!, got[i]!);
    assert.ok(plain(i) ? u <= 1 : u === 0, `${px[i]} ** ${py[i]}: ${got[i]} against V8's ${want[i]}`);
  }
});

test(">>> 0 is identical", () => {
  const x = all(NUMBERS, inputs(35, 10_000, (u) => (u - 0.5) * 2 ** 64));
  assert.deepEqual(Array.from(wasm.toUint32(x)), Array.from(x, (v) => v >>> 0));
});

test("String(x) and JSON.stringify of numbers: identical (ryu-js against V8)", () => {
  assert.equal(wasm.numbersToString(NUMBERS), Array.from(NUMBERS, String).join("\n"));
  assert.equal(wasm.jsonNumbers(NUMBERS), JSON.stringify(Array.from(NUMBERS)));
});

test("toFixed(7), the graph's coordinate keys: identical, exact ties included; other digits too", () => {
  const got = wasm.toFixed(NUMBERS, 7).split("\n"), want = Array.from(NUMBERS, (x) => x.toFixed(7));
  const wrong = want.flatMap((w, i) => (got[i] === w ? [] : [`${NUMBERS[i]}: ${w} not ${got[i]}`]));
  assert.deepEqual(wrong.slice(0, 10), []);
  const some = all(EDGES, wide.subarray(0, 5000), ties.subarray(0, 2000), bitsX.subarray(0, 5000));
  for (let d = 0; d <= 20; d++) assert.equal(wasm.toFixed(some, d), Array.from(some, (x) => x.toFixed(d)).join("\n"), `toFixed(${d})`);
});

test("JSON numbers parse to the same doubles (the pack decoder's parser)", () => {
  const text = JSON.stringify(Array.from(NUMBERS.filter(Number.isFinite)));
  const want = Float64Array.from(JSON.parse(text) as number[]), got = wasm.parseNumbers(text);
  assert.deepEqual(diff(want, got), { n: want.length, differ: 0, maxUlps: 0, byUlps: {} });
  // Spellings JSON.stringify never writes, which a hand-edited pack might.
  const odd = ["1E5", "-0.0", "1.00000000000000011102230246251565404236316680908203125", "4.9406564584124654e-324", "1e-400", "2.2250738585072011e-308", "0.1e1", "100000000000000000000000"];
  assert.ok(identical(Float64Array.from(odd, Number), wasm.parseNumbers(`[${odd.join(",")}]`)));
});

test("JSON.stringify of strings: identical", () => {
  for (const s of ["", "plain", "quote \" and \\ backslash", "\n\r\t\b\f", "\u0000\u0001\u001f\u007f", "  ", "é 日本 🚗", "</script>"]) {
    assert.equal(wasm.jsonString(s), JSON.stringify(s), JSON.stringify(s));
  }
});

// ── Pack decoding ────────────────────────────────────────────────────────────────────────────

test(`pack decoding, ${SPEC.area}: the same records as fromPack, byte for byte`, () => {
  const text = packText();
  const pack = JSON.parse(text) as AreaPack;
  const data = fromPack(pack);
  const area = wasm.Area.load(Buffer.from(text, "utf8"));
  try {
    const c = counts(pack, data);
    assert.deepEqual(JSON.parse(area.counts()), c);
    const ts = canonicalBytes(pack, data), rs = Buffer.from(area.canonicalBytes());
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    assert.equal(sha(rs), sha(ts), `decoded records differ (${rs.length} bytes against ${ts.length})`);
    assert.equal(area.calibrationJson(), calibrationJson(pack.calibration));
    report.packs[SPEC.area] = { packBytes: text.length, ...c, decodedBytes: ts.length, sha256: sha(ts) };
  } finally {
    area.free();
  }
});

test("a calibration's maps keep JavaScript's key order: array-index keys first, a repeated key in its first place", () => {
  const text = `{"v":1,"id":"t","name":"T","bbox":{"south":0,"west":0,"north":1,"east":1},"osmTimestamp":"",
    "calibration":{"speedScale":1.1,"wayVolume":{"x":1,"10":2,"9":3,"01":4,"4294967295":5,"4294967294":6,"x":7},"classVolume":{"motorway":0.9},
      "stretches":{"b":{"nodes":[1,2],"ways":[3],"volume":1.5,"spread":0.5},"7":{"nodes":[2,1],"ways":[3],"volume":1,"spread":1}}},
    "names":[],"ways":[],"nodes":[],"restrictions":[]}`;
  const area = wasm.Area.load(Buffer.from(text));
  assert.equal(area.calibrationJson(), calibrationJson((JSON.parse(text) as AreaPack).calibration));
  area.free();
});

after(() => {
  const lines = ["", "Parity measurements (TypeScript on V8 against Rust WebAssembly):", "", "| draws | n | differ | max ulps | by ulps |", "|---|---|---|---|---|"];
  for (const [k, d] of Object.entries(report.draws)) lines.push(`| ${k} | ${d.n} | ${d.differ} | ${d.maxUlps} | ${JSON.stringify(d.byUlps)} |`);
  lines.push("", "| Math | n | differ | max ulps |", "|---|---|---|---|");
  for (const [k, d] of Object.entries(report.math)) lines.push(`| ${k} | ${d.n} | ${d.differ} | ${d.maxUlps} |`);
  lines.push("", "| pack | pack bytes | ways | nodes | restrictions | control points | decoded sha256 |", "|---|---|---|---|---|---|---|");
  for (const [k, p] of Object.entries(report.packs) as [string, { packBytes: number; ways: number; nodes: number; restrictions: number; controlPoints: number | null; sha256: string }][]) {
    lines.push(`| ${k} | ${p.packBytes} | ${p.ways} | ${p.nodes} | ${p.restrictions} | ${p.controlPoints ?? "none"} | ${p.sha256.slice(0, 16)} |`);
  }
  console.log(lines.join("\n"));
  const out = process.env["PARITY_REPORT"];
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
});

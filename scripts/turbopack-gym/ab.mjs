#!/usr/bin/env node
// Paired A/B: run variant A and variant B at the same time on two equal CPU lanes of
// one NUMA node each, swap lanes every rep and launch order every two reps (so which
// build starts first does not follow the lane), and compare per-pair
// ratios B/A. Both sides see the same box noise (other builds, memory bandwidth); the
// two builds also share the node's memory bandwidth and caches, so a ratio measures B
// next to A, not B alone (scaling.mjs runs builds one at a time).
//
//   node scripts/turbopack-gym/ab.mjs --b mypatch                       # vs incumbent, 6 reps
//   node scripts/turbopack-gym/ab.mjs --a base --b base --b-env TURBO_ENGINE_EVICT_MIN_BYTES=8589934592
//   node scripts/turbopack-gym/ab.mjs --b mypatch --app quick --reps 2  # smoke on the small app
//   node scripts/turbopack-gym/ab.mjs --b mypatch --host bigbox         # on another machine (hosts.mjs)
//
// Verdict: B wins when the geometric-mean ratio of --metric (default graph) over the reps
// is below 1 - --threshold (0.06), every lane-swapped rep pair agrees in sign, the
// --guard-metric (run-turbopack) did not regress by more than --guard (0.02), and B's
// output fingerprint equals A's. Both bindings are resolved once, under the CPU locks,
// to immutable store directories (bindings.mjs), and both sides are prepared (hashed)
// before either build of a rep launches. Exit: 0 win, 1 no win, 2 error.

import { readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bench, memoryNodes, prepare } from "./bench.mjs";
import { resolveBinding, verifyResolved } from "./bindings.mjs";
import {
  APPS,
  RESULTS,
  RUNS,
  appendJsonl,
  expandCpus,
  median,
  parseArgs,
  withCpus,
} from "./lib.mjs";
import { LOCAL_LANES, host, runRemote, stripHost, sync } from "./hosts.mjs";

// lanes: "auto" takes the first pair of this host's pool (GYM_LANE_POOL) whose CPUs
// are all free, or an explicit "a:b" pair. CPUs are locked individually (lib.withCpus),
// so overlapping pairs from different pools still exclude each other.
// CPU ids the kernel has online (may be sparse)
function onlineCpus() {
  return new Set(expandCpus(readFileSync("/sys/devices/system/cpu/online", "utf8").trim()));
}

export function validateLanes(pair) {
  const lane = /^\d+(-\d+)?(,\d+(-\d+)?)*$/;
  const parts = String(pair).split(":");
  if (parts.length !== 2 || !parts.every((l) => lane.test(l)))
    throw new Error(`lanes must be two CPU lists "a:b" like 0-23:24-47 (got "${pair}")`);
  const [la, lb] = parts;
  const [ca, cb] = [expandCpus(la), expandCpus(lb)];
  if (ca.length !== cb.length)
    throw new Error(`lanes ${pair} differ in size (${ca.length} vs ${cb.length})`);
  if (ca.some((c) => cb.includes(c))) throw new Error(`lanes ${pair} overlap`);
  const online = onlineCpus();
  const missing = [...ca, ...cb].filter((c) => !online.has(c));
  if (missing.length)
    throw new Error(`lanes ${pair} name CPUs that are not online: ${missing.join(",")}`);
  for (const l of [la, lb])
    if (memoryNodes(l).includes(","))
      throw new Error(`lane ${l} spans NUMA nodes ${memoryNodes(l)}`);
  return [la, lb];
}

export async function ab(opts) {
  const pool = !opts.lanes || opts.lanes === "auto" ? LOCAL_LANES : [opts.lanes];
  pool.forEach(validateLanes);
  return withCpus(pool, (pair) => {
    const [laneA, laneB] = validateLanes(pair);
    // resolve both names once, under the locks, to immutable store directories
    const resolved = {};
    for (const name of new Set([opts.a, opts.b]))
      resolved[name] = name === "stock" ? null : resolveBinding(name);
    return abUnlocked({ ...opts, laneA, laneB, resolved });
  });
}

async function abUnlocked({
  a = "incumbent",
  b,
  aEnv = {},
  bEnv = {},
  reps = 6,
  laneA,
  laneB,
  app = "monolith",
  metric = "graph",
  guardMetric = "turbopack",
  threshold = 0.06,
  guard = 0.02,
  label,
  tag,
  resolved = {},
}) {
  const appDir = join(APPS, app);
  if (reps > 1 && reps % 2) reps++; // whole swap pairs only
  const pairs = [];
  for (let i = 0; i < reps; i++) {
    const [la, lb] = i % 2 ? [laneB, laneA] : [laneA, laneB];
    // hash the app and both bindings before launching either build
    const shared = prepare({ binding: "stock", app: appDir });
    const prep = (name) => ({
      ...shared,
      resolved: resolved[name] && verifyResolved(resolved[name]),
    });
    const [pa, pb] = [prep(a), prep(b)];
    // outputs are kept until compared: a rep whose fingerprints differ keeps both
    // (moved into the runs' directories) for inspection
    const runA = () =>
      bench({ binding: a, prepared: pa, env: aEnv, cpus: la, label: `A:${a}`, keep: true });
    const runB = () =>
      bench({ binding: b, prepared: pb, env: bEnv, cpus: lb, label: `B:${b}`, keep: true });
    // launch order flips every two reps, lanes every rep: first-launched is not tied to a
    // lane. Wait for both before failing, so the CPU locks outlive both builds.
    const bFirst = Math.floor(i / 2) % 2 === 1;
    const started = bFirst ? [runB(), runA()] : [runA(), runB()];
    const settled = await Promise.allSettled(bFirst ? [started[1], started[0]] : started);
    const failed = settled.find((x) => x.status === "rejected");
    if (failed) {
      for (const x of settled)
        if (x.status === "fulfilled") rmSync(x.value.distDir, { recursive: true, force: true });
      throw failed.reason;
    }
    const [ra, rb] = settled.map((x) => x.value);
    for (const r of [ra, rb]) {
      if (ra.output.sha === rb.output.sha) rmSync(r.distDir, { recursive: true, force: true });
      else {
        renameSync(r.distDir, join(RUNS, r.id, "output"));
        console.error(`[ab] rep ${i + 1}: outputs differ, kept in ${join(RUNS, r.id, "output")}`);
      }
    }
    pairs.push({
      a: ra,
      b: rb,
      ratio: rb[metric].s / ra[metric].s,
      guard: rb[guardMetric].s / ra[guardMetric].s,
    });
    console.error(
      `[ab] rep ${i + 1}/${reps} ${metric} ${ra[metric].s}s -> ${rb[metric].s}s (x${pairs.at(-1).ratio.toFixed(3)}), ${guardMetric} x${pairs.at(-1).guard.toFixed(3)}`,
    );
  }
  // Lanes are not identical (a box's CPUs can differ by >10%), so each rep's lanes are
  // swapped and the score is the geometric mean over swap pairs (rep 2k, 2k+1): a fixed
  // lane offset cancels exactly. `consistent` asks every swap pair to agree in sign.
  const gmean = (xs) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
  const swaps = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) swaps.push([pairs[i], pairs[i + 1]]);
  const ratio = gmean(pairs.map((p) => p.ratio));
  const guardRatio = gmean(pairs.map((p) => p.guard));
  const sameOutput = pairs.every((p) => p.a.output.sha === p.b.output.sha);
  const swapRatios = swaps.map(([x, y]) => Math.sqrt(x.ratio * y.ratio));
  const consistent = swapRatios.length
    ? swapRatios.every((r) => r < 1)
    : pairs.every((p) => p.ratio < 1);
  const win = ratio < 1 - threshold && consistent && guardRatio < 1 + guard && sameOutput;
  const rec = {
    when: new Date().toISOString(),
    label: label || b,
    tag: tag || null,
    a: { binding: a, env: aEnv },
    b: { binding: b, env: bEnv },
    reps,
    guardMetric,
    threshold,
    guard,
    app,
    host: process.env.GYM_HOST || "local",
    lanes: [laneA, laneB],
    metric,
    ratio: +ratio.toFixed(4),
    swapRatios: swapRatios.map((r) => +r.toFixed(4)),
    guardRatio: +guardRatio.toFixed(4),
    sameOutput,
    consistent,
    win,
    aMedian: median(pairs.map((p) => p.a[metric].s)),
    bMedian: median(pairs.map((p) => p.b[metric].s)),
    aCores: median(pairs.map((p) => p.a[metric].cores)),
    bCores: median(pairs.map((p) => p.b[metric].cores)),
    runs: pairs.map((p) => [p.a.id, p.b.id]),
    machine: pairs[0]?.a.machine,
  };
  appendJsonl(join(RESULTS, "ab.jsonl"), rec);
  console.error(
    `[ab] ${rec.label}: ${metric} ${rec.aMedian}s -> ${rec.bMedian}s (x${rec.ratio}), cores ${rec.aCores} -> ${rec.bCores}, ${guardMetric} x${rec.guardRatio}, output ${sameOutput ? "same" : "DIFFERENT"} => ${win ? "WIN" : "no"}`,
  );
  return rec;
}

// exit: 0 win, 1 no win, 2 error (a caller must not read an error as a measured loss)
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (e) {
    console.error(`[ab] error: ${e.stack || e.message}`);
    process.exit(2);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const o = parseArgs(argv, {
    a: 1,
    b: 1,
    "a-env": "list",
    "b-env": "list",
    reps: 1,
    lanes: 1,
    app: 1,
    metric: 1,
    threshold: 1,
    guard: 1,
    "guard-metric": 1,
    label: 1,
    tag: 1,
    host: 1,
  });
  if (o.host && o.host !== "local") {
    // run the same A/B on another host: ship the code and both bindings, then run there
    const h = host(o.host);
    sync(h, [o.a || "incumbent", o.b || o.a || "incumbent"]);
    const { code, out } = await runRemote(h, "scripts/turbopack-gym/ab.mjs", stripHost(argv));
    if (code !== 0 && code !== 1) process.exit(2);
    const rec = JSON.parse(out.trim().split("\n").at(-1));
    rec.host = o.host;
    appendJsonl(join(RESULTS, "ab.jsonl"), rec);
    console.log(JSON.stringify(rec));
    process.exit(code);
  }
  const kv = (l) => Object.fromEntries((l || []).map((s) => s.split(/=(.*)/s).slice(0, 2)));
  const rec = await ab({
    a: o.a || "incumbent",
    b: o.b || o.a || "incumbent",
    aEnv: kv(o["a-env"]),
    bEnv: kv(o["b-env"]),
    reps: Number(o.reps || 6),
    lanes: o.lanes || "auto",
    app: o.app || "monolith",
    metric: o.metric || "graph",
    threshold: Number(o.threshold || 0.06),
    guard: Number(o.guard || 0.02),
    guardMetric: o["guard-metric"] || "turbopack",
    label: o.label,
    tag: o.tag,
  });
  console.log(JSON.stringify(rec));
  process.exit(rec.win ? 0 : 1);
}

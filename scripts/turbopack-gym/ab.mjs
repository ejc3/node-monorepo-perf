#!/usr/bin/env node
// Paired A/B: run variant A and variant B at the same time on two equal CPU lanes,
// swap lanes every rep, and compare per-pair ratios B/A. Running the pair
// concurrently means both sides see the same box noise (other tenants, memory
// bandwidth, thermal), so the ratio is far tighter than comparing separate runs.
//
//   node scripts/turbopack-gym/ab.mjs --b mypatch                       # vs incumbent, 6 reps
//   node scripts/turbopack-gym/ab.mjs --a base --b base --b-env TURBO_ENGINE_EVICT_MIN_BYTES=8589934592
//   node scripts/turbopack-gym/ab.mjs --b mypatch --app quick --reps 2  # smoke on the small app
//   node scripts/turbopack-gym/ab.mjs --b mypatch --host bigbox         # on another machine (hosts.mjs)
//
// Verdict: B wins when the geometric-mean ratio of --metric over lane-swapped rep
// pairs is below 1 - --threshold, every swap pair agrees in sign, the guard metric (whole Turbopack phase) did not regress by
// more than --guard, and B's output fingerprint equals A's.

import { join } from "node:path";
import { bench } from "./bench.mjs";
import { APPS, RESULTS, appendJsonl, median, parseArgs, withCpus } from "./lib.mjs";
import { LOCAL_LANES, host, runRemote, sync } from "./hosts.mjs";

// lanes: "auto" takes the first pair of this host's pool (GYM_LANE_POOL) whose CPUs
// are all free, or an explicit "a:b" pair. CPUs are locked individually (lib.withCpus),
// so overlapping pairs from different pools still exclude each other.
export async function ab(opts) {
  const pool = !opts.lanes || opts.lanes === "auto" ? LOCAL_LANES : [opts.lanes];
  return withCpus(pool, (pair) => {
    const [laneA, laneB] = pair.split(":");
    return abUnlocked({ ...opts, laneA, laneB });
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
  threshold = 0.04,
  guard = 0.02,
  label,
}) {
  const appDir = join(APPS, app);
  if (reps > 1 && reps % 2) reps++; // whole swap pairs only
  const pairs = [];
  for (let i = 0; i < reps; i++) {
    const [la, lb] = i % 2 ? [laneB, laneA] : [laneA, laneB];
    const [ra, rb] = await Promise.all([
      bench({ binding: a, env: aEnv, cpus: la, app: appDir, label: `A:${a}` }),
      bench({ binding: b, env: bEnv, cpus: lb, app: appDir, label: `B:${b}` }),
    ]);
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
    a: { binding: a, env: aEnv },
    b: { binding: b, env: bEnv },
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
    label: 1,
    host: 1,
  });
  if (o.host && o.host !== "local") {
    // run the same A/B on another host: ship the code and both bindings, then run there
    const h = host(o.host);
    sync(h, [o.a || "incumbent", o.b || o.a || "incumbent"]);
    const fwd = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === "--host") i++;
      else if (!argv[i].startsWith("--host=")) fwd.push(argv[i]);
    }
    const { code, out } = await runRemote(h, "scripts/turbopack-gym/ab.mjs", fwd);
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
    threshold: Number(o.threshold || 0.04),
    label: o.label,
  });
  console.log(JSON.stringify(rec));
  process.exit(rec.win ? 0 : 1);
}

#!/usr/bin/env node
// Core-scaling sweep: cold builds at several lane sizes, run one at a time while
// holding every CPU lock of the box (nothing else of the gym runs meanwhile). With
// several bindings the builds interleave (rep r runs each size with the bindings
// rotated by r), so no binding always runs first or last. Lanes start at CPU 0: a size
// larger than a NUMA node spans nodes.
//
//   node scripts/turbopack-gym/scaling.mjs --binding base,incumbent --reps 3
//   node scripts/turbopack-gym/scaling.mjs --sizes 16,48,96 --binding base
//   node scripts/turbopack-gym/scaling.mjs --host bigbox --binding base,incumbent
//
// Each run is appended to runs.jsonl with label "scale" and this sweep's id, and a
// completed sweep to sweeps.jsonl; record.mjs scaling writes one completed sweep (the
// latest, or --sweep <id> / --tag <tag>).

import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { bench } from "./bench.mjs";
import { RESULTS, appendJsonl, parseArgs, withCpus } from "./lib.mjs";
import { host, runRemote, stripHost, sync } from "./hosts.mjs";

const argv = process.argv.slice(2);
const a = parseArgs(argv, { sizes: 1, reps: 1, binding: 1, app: 1, host: 1, tag: 1 });
const bindings = (a.binding || "base").split(",");

if (a.host) {
  const h = host(a.host);
  sync(h, bindings);
  const { code } = await runRemote(h, "scripts/turbopack-gym/scaling.mjs", stripHost(argv));
  process.exit(typeof code === "number" ? code : 1);
}

const n = availableParallelism();
const sizes = a.sizes
  ? a.sizes.split(",").map(Number)
  : [...new Set([8, 16, 24, 32, 48, 64, 96, n].filter((s) => s <= n))];
if (sizes.some((s) => !Number.isInteger(s) || s < 1 || s > n))
  throw new Error(`--sizes must be integers in [1, ${n}]`);
const reps = Number(a.reps || 1);
const sweep = `sweep-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;

await withCpus(`0-${n - 1}`, async () => {
  for (let r = 0; r < reps; r++) {
    for (const size of sizes) {
      const order = bindings.map((_, i) => bindings[(i + r) % bindings.length]);
      for (const binding of order) {
        const rec = await bench({ binding, cpus: `0-${size - 1}`, label: "scale", app: a.app });
        appendJsonl(join(RESULTS, "runs.jsonl"), { ...rec, sweep, rep: r });
      }
    }
  }
});
// a sweep counts only once it is complete (record.mjs requires this manifest)
appendJsonl(join(RESULTS, "sweeps.jsonl"), {
  sweep,
  tag: a.tag || null,
  sizes,
  bindings,
  reps,
  app: a.app || "monolith",
  completed: new Date().toISOString(),
});
console.log(JSON.stringify({ sweep, sizes, bindings, reps }));

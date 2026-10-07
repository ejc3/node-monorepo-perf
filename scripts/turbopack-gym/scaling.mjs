#!/usr/bin/env node
// Core-scaling sweep: one cold build per lane size, run one at a time while holding
// every CPU lock of the box (nothing else runs on the box's lanes meanwhile).
// Lanes start at CPU 0 and stay on one NUMA node until they cannot.
//
//   node scripts/turbopack-gym/scaling.mjs                       # 8,16,32,64,all cores
//   node scripts/turbopack-gym/scaling.mjs --sizes 16,48,96 --reps 2 --binding base
//   node scripts/turbopack-gym/scaling.mjs --host bigbox
//
// Runs are appended to runs.jsonl with label "scale" (record.mjs scaling reads them).

import { availableParallelism } from "node:os";
import { join } from "node:path";
import { bench } from "./bench.mjs";
import { RESULTS, appendJsonl, parseArgs, withCpus } from "./lib.mjs";
import { host, runRemote, sync } from "./hosts.mjs";

const argv = process.argv.slice(2);
const a = parseArgs(argv, { sizes: 1, reps: 1, binding: 1, app: 1, host: 1, label: 1 });

if (a.host) {
  const h = host(a.host);
  sync(h, [a.binding || "base"]);
  const fwd = argv.filter((x, i) => x !== "--host" && argv[i - 1] !== "--host");
  const { code } = await runRemote(h, "scripts/turbopack-gym/scaling.mjs", fwd);
  process.exit(code);
}

const n = availableParallelism();
const sizes = (
  a.sizes || [8, 16, 32, 64, n].filter((s, i, xs) => s <= n && xs.indexOf(s) === i).join(",")
)
  .split(",")
  .map(Number);
const reps = Number(a.reps || 1);
// hold every CPU of the box for the whole sweep
await withCpus(`0-${n - 1}`, async () => {
  for (let r = 0; r < reps; r++) {
    for (const size of sizes) {
      const rec = await bench({
        binding: a.binding || "base",
        cpus: `0-${size - 1}`,
        label: a.label || "scale",
        app: a.app,
      });
      appendJsonl(join(RESULTS, "runs.jsonl"), rec);
    }
  }
});

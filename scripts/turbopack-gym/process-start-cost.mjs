#!/usr/bin/env node
//   taskset -c 0-3 node scripts/turbopack-gym/process-start-cost.mjs [reps]
// Node's own spawn path (libuv uv_spawn: fork + exec on Linux) from a process holding a large,
// touched heap outside V8 (Buffers, malloc'd like a native addon's memory). JSON lines like
// process-start-cost.py's, method "node spawnSync".
import { spawnSync } from "node:child_process";
const reps = Number(process.argv[2] || 15);
// a launch that did not run /bin/true to exit 0 is not a sample
const run = () => {
  const r = spawnSync("/bin/true");
  if (r.error || r.status !== 0) throw new Error(`launch failed: ${r.error ?? `exit ${r.status}`}`);
};
const heap = [];
for (const gib of [0, 1, 4, 8, 16]) {
  while (heap.length < gib) {
    const b = Buffer.allocUnsafeSlow(1 << 30);
    for (let off = 0; off < b.length; off += 4096) b[off] = 1;
    heap.push(b);
  }
  run();
  const ts = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    run();
    ts.push(performance.now() - t);
  }
  ts.sort((a, b) => a - b);
  const r = (x) => Math.round(x * 100) / 100;
  console.log(
    JSON.stringify({
      gib,
      method: "node spawnSync",
      ms_median: r(ts[ts.length >> 1]),
      ms_min: r(ts[0]),
      ms_max: r(ts.at(-1)),
    }),
  );
}

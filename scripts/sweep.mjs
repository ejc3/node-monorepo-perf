#!/usr/bin/env node
// Scaling sweep: runs measure.mjs across a matrix of workspace sizes to
// characterize O(repo) for each operation. Appends to bench/results.json.
//
//   node scripts/sweep.mjs            # full matrix
//   node scripts/sweep.mjs --from 5kx300   # resume at a label
//
// Rationale for phase selection:
//   * gen / install / graph / focus / prune at EVERY scale (cheap or O(closure))
//   * full typecheck only where it's still tractable (it's O(packages/cores));
//     at 20k we skip it deliberately and note the extrapolation — that omission
//     IS the lesson (you must use --affected at that size).

import { execSync } from "node:child_process";

const MATRIX = [
  { label: "200x100",  apps: 200,   libs: 100, phases: "gen,install,graph,typecheck,focus,prune" },
  { label: "1kx200",   apps: 1000,  libs: 200, phases: "gen,install,graph,typecheck,focus,prune" },
  { label: "2kx300",   apps: 2000,  libs: 300, phases: "gen,install,graph,typecheck,focus,prune" },
  { label: "5kx300",   apps: 5000,  libs: 300, phases: "gen,install,graph,typecheck,focus,prune" },
  { label: "10kx300",  apps: 10000, libs: 300, phases: "gen,install,graph,typecheck,focus,prune" },
  { label: "20kx300",  apps: 20000, libs: 300, phases: "gen,install,graph,focus,prune" },
];

const argv = process.argv.slice(2);
const fromIdx = (() => {
  const i = argv.indexOf("--from");
  if (i === -1) return 0;
  const at = MATRIX.findIndex((m) => m.label === argv[i + 1]);
  if (at === -1) {
    console.error(
      `Unknown --from label: ${argv[i + 1]}. Valid labels: ${MATRIX.map((m) => m.label).join(", ")}`,
    );
    process.exit(1);
  }
  return at;
})();

const failures = [];
for (const m of MATRIX.slice(fromIdx)) {
  console.log(`\n████████ SWEEP ${m.label} (${m.apps} apps / ${m.libs} libs) ████████`);
  const cmd = `node scripts/measure.mjs --label ${m.label} --apps ${m.apps} --libs ${m.libs} --modules 16 --phases ${m.phases} --fs-stats`;
  console.log(`$ ${cmd}`);
  const t0 = Date.now();
  try {
    execSync(cmd, { stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", TURBO_TELEMETRY_DISABLED: "1" } });
  } catch (e) {
    console.error(`!! ${m.label} failed: ${e.message}`);
    failures.push(m.label);
  }
  console.log(`████████ ${m.label} done in ${Math.round((Date.now() - t0) / 1000)}s ████████`);
}
console.log("\nSWEEP COMPLETE → bench/results.json");
if (failures.length) { console.error(`scales failed: ${failures.join(", ")}`); process.exit(1); }

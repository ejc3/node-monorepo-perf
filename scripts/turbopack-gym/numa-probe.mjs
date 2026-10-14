#!/usr/bin/env node
//   node scripts/turbopack-gym/numa-probe.mjs <out.json> <binding,binding,...>   (dedicated box; sudo for sysctl)
// Probe: automatic NUMA balancing on vs off (kernel.numa_balancing) for builds on all 192 CPUs
// (both NUMA nodes): a warm build after one new import and a cold build of drift-monolith, per
// binding, alternating the setting, 3 reps. Writes JSON rows; restores the setting it found.
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bench } from "./bench.mjs";
import { APPS, ROOT, pageWorkersEnv, withCpus } from "./lib.mjs";
import { applyEdits, editTargets, restoreJournal } from "./drift.mjs";

const appName = "drift-monolith";
const app = join(APPS, appName);
const DIST = ".next-numa";
const dist = join(app, DIST);
const cpus = "0-191";
const out = [];
const bindings = process.argv[3].split(",");
const env = { TURBO_ENGINE_IGNORE_DIRTY: "1", ...pageWorkersEnv("match", cpus) };
const set = (v) => {
  if (spawnSync("sudo", ["-n", "sysctl", "-q", `kernel.numa_balancing=${v}`]).status)
    throw new Error("sysctl");
};
const cp = (a, b) => {
  rmSync(b, { recursive: true, force: true });
  if (spawnSync("cp", ["-a", "--reflink=always", a, b]).status) throw new Error("cp");
};
const snap = (b) => join(ROOT, "drift", `numa-snap-${b}`);
const WARM = ["turbopack-module-graph", "turbopack-write-entrypoints", "turbopack-emit"];
const orig = spawnSync("sysctl", ["-n", "kernel.numa_balancing"], {
  encoding: "utf8",
}).stdout.trim();
try {
  await withCpus(cpus, async () => {
    restoreJournal(appName);
    set(1);
    for (const b of bindings) {
      rmSync(dist, { recursive: true, force: true });
      await bench({
        binding: b,
        app,
        cpus,
        env,
        distDir: DIST,
        keep: true,
        quiet: true,
        label: "numa-seed",
      });
      cp(dist, snap(b));
    }
    for (let rep = 0; rep < 3; rep++)
      for (const b of bindings)
        for (const v of rep % 2 ? [0, 1] : [1, 0])
          for (const mode of ["warm", "cold"]) {
            set(v);
            rmSync(dist, { recursive: true, force: true });
            try {
              if (mode === "warm") {
                applyEdits(app, appName, editTargets(app, 1), "import");
                cp(snap(b), dist);
                for (const t of ["trace", "trace-build", "trace-turbopack"])
                  rmSync(join(dist, t), { force: true });
              }
              const r = await bench({
                binding: b,
                app,
                cpus,
                env,
                distDir: DIST,
                quiet: true,
                label: `numa-${v}-${mode}`,
                optional: mode === "warm" ? WARM : [],
              });
              out.push({
                rep,
                binding: b,
                numaBalancing: v,
                mode,
                wall: r.wall,
                turbopack: r.turbopack.s,
                emit: r.emit?.s ?? null,
                output: r.output.sha,
              });
              writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
              console.log(
                `rep ${rep} ${b} numa_balancing=${v} ${mode}: wall ${r.wall} tp ${r.turbopack.s} emit ${r.emit?.s} out ${r.output.sha}`,
              );
            } finally {
              restoreJournal(appName);
            }
          }
  });
} finally {
  set(orig);
  rmSync(dist, { recursive: true, force: true });
  for (const b of bindings) rmSync(snap(b), { recursive: true, force: true });
}

#!/usr/bin/env node
// Profile one build of a binding with perf: on-CPU samples (where the busy threads
// are) plus sched_switch events (who goes off-CPU, from where — the waits that keep
// the graph phase at a few cores). Writes perf.data and folded stacks per run dir.
//
//   node scripts/turbopack-gym/profile.mjs --binding base-fp --fp [--offcpu] [--app quick]
//
// Rust frames need frame pointers or DWARF: the default uses --call-graph dwarf at a
// low rate; build a binding with RUSTFLAGS=-Cforce-frame-pointers=yes and pass
// --fp for cheap full-rate stacks.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bench } from "./bench.mjs";
import { readdirSync } from "node:fs";
import { release } from "node:os";
import { APPS, RUNS, parseArgs, sh, withCpus } from "./lib.mjs";
import { LOCAL_LANES } from "./hosts.mjs";

// Ubuntu's /usr/bin/perf is a wrapper that refuses a kernel without its exact
// linux-tools package; fall back to the installed linux-tools build closest to the
// running kernel's version.
function findPerf() {
  if (process.env.PERF) return process.env.PERF;
  const base = "/usr/lib/linux-tools";
  const kv = release().split("-")[0];
  const builds = existsSync(base)
    ? readdirSync(base).filter((d) => existsSync(join(base, d, "perf")))
    : [];
  const pick =
    builds.find((d) => d.startsWith(kv)) ||
    builds.find((d) => d.startsWith(kv.split(".").slice(0, 2).join("."))) ||
    builds.at(-1);
  return pick ? join(base, pick, "perf") : "perf";
}
const PERF = findPerf();

const a = parseArgs(process.argv.slice(2), {
  binding: 1,
  cpus: 1,
  app: 1,
  fp: "bool",
  freq: 1,
  offcpu: "bool",
});
// profiles hold the first lane pair of the pool, like an A/B, and run on its first lane
const pair = LOCAL_LANES[0];
await withCpus(pair, async () => {
  const cpus = a.cpus || pair.split(":")[0];
  const freq = a.freq || (a.fp ? "499" : "97");
  const outDir = join(RUNS, `profile-${Date.now().toString(36)}`);
  sh("mkdir", ["-p", outDir]);
  const events = a.offcpu ? ["-e", "sched:sched_switch", "-e", "cpu-clock"] : ["-e", "cpu-clock"];
  // system-wide on the lane's CPUs: the build's pids are not known up front
  const perf = spawn(
    "sudo",
    [
      "-n",
      PERF,
      "record",
      "-k",
      "CLOCK_REALTIME",
      "-o",
      join(outDir, "perf.data"),
      "-C",
      cpus,
      "-F",
      freq,
      ...events,
      a.fp ? "--call-graph=fp" : "--call-graph=dwarf,16384",
      "-q",
    ],
    { stdio: "inherit" },
  );
  await new Promise((r) => setTimeout(r, 1500));
  const rec = await bench({
    binding: a.binding || "base",
    cpus,
    app: a.app ? join(APPS, a.app) : undefined,
    label: "profile",
    keep: false,
  });
  sh("sudo", ["-n", "kill", "-INT", String(perf.pid)]);
  await new Promise((r) => perf.on("close", r));
  sh("sudo", ["-n", "chown", "-R", `${process.getuid()}`, outDir]);
  // perf timestamps are CLOCK_MONOTONIC seconds (perf refuses CLOCK_REALTIME together with
  // tracepoints such as sched_switch): convert each phase's epoch window by the
  // realtime-minus-monotonic offset and print it as a --time window
  const { readFileSync } = await import("node:fs");
  const clockOffset = Date.now() / 1000 - Number(process.hrtime.bigint()) / 1e9;
  const run = JSON.parse(readFileSync(join(RUNS, rec.id, "run.json"), "utf8"));
  const windows = Object.fromEntries(
    run.phases
      .filter((e) => e.duration > 1e5)
      .map((e) => [
        e.name,
        `${(e.startTime / 1000 - clockOffset).toFixed(3)},${(e.startTime / 1000 - clockOffset + e.duration / 1e6).toFixed(3)}`,
      ]),
  );
  console.log(JSON.stringify({ outDir, run: rec.id, graph: rec.graph, windows }, null, 1));
  console.error(
    `sudo perf report -f -i ${outDir}/perf.data --comm tokio-rt-worker --children --sort sym --time ${windows["turbopack-module-graph"]} --stdio -g none`,
  );
});

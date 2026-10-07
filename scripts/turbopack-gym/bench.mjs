#!/usr/bin/env node
// One cold `next build --experimental-build-mode=compile` of a generated app, inside
// a transient systemd scope pinned to a CPU set. Reports the Turbopack phase
// durations from <distDir>/trace-build and the CPU actually used during each phase
// (cgroup cpu.stat sampled every SAMPLE_MS), then appends one JSON line.
//
//   node scripts/turbopack-gym/bench.mjs --binding base --cpus 0-31
//   node scripts/turbopack-gym/bench.mjs --binding stock --cpus 0-15 --env TURBO_TASKS_AVAILABLE_PARALLELISM=8
//
// A bare bench.mjs does not take a lane lock: run it only when no A/B is running.
//
// --binding: "stock" (the npm @next/swc package) or a directory name under
//            $GYM_ROOT/bindings holding next-swc.<triple>.node.
// --app:     generated app directory (default $GYM_ROOT/apps/monolith).
// --out:     JSONL file to append to (default results/runs.jsonl).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  APPS,
  BINDINGS,
  BINDING_FILE,
  RESULTS,
  RUNS,
  appendJsonl,
  cpuCount,
  ensureDir,
  machine,
  parseArgs,
} from "./lib.mjs";

const SAMPLE_MS = 100;
const BUILD_ID = "gym";

// Fingerprint of the emitted server/ + static/ output, so a candidate that skips
// work shows up as different output rather than a speedup. Turbopack output is not
// byte-reproducible across builds: the minifier assigns some local names in
// nondeterministic order, which also changes content-hashed chunk file names. Both
// keep sizes, so the fingerprint is the multiset of (directory, size) over emitted
// files. The per-run distDir name embedded in chunks is replaced first;
// preview-props.json holds per-build random keys and is skipped.
export function fingerprint(distDir) {
  const name = distDir.split("/").at(-1);
  const entries = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else if (!/\.(map|nft\.json)$|trace|^preview-props\.json$/.test(e.name)) {
        const buf = readFileSync(join(dir, e.name), "latin1");
        entries.push(`${rel}\t${buf.replaceAll(name, "<dist>").length}`);
      }
    }
  };
  for (const top of ["server", "static"])
    if (existsSync(join(distDir, top))) walk(join(distDir, top), top);
  entries.sort();
  return {
    files: entries.length,
    sha: createHash("sha256").update(entries.join("\n")).digest("hex").slice(0, 16),
  };
}

// NUMA nodes whose CPUs intersect a cpu list, so a lane's memory stays local to it
function memoryNodes(cpus) {
  const expand = (list) =>
    list
      .trim()
      .split(",")
      .flatMap((r) => {
        const [a, b = a] = r.split("-").map(Number);
        return Array.from({ length: b - a + 1 }, (_, i) => a + i);
      });
  const want = new Set(expand(cpus));
  const base = "/sys/devices/system/node";
  const nodes = readdirSync(base)
    .filter((d) => /^node\d+$/.test(d))
    .filter((d) => expand(readFileSync(join(base, d, "cpulist"), "utf8")).some((c) => want.has(c)))
    .map((d) => d.slice(4));
  return nodes.length ? nodes.join(",") : "0";
}

export async function bench({
  binding = "base",
  cpus,
  app: appArg,
  env = {},
  label = "",
  keep = false,
  quiet = false,
}) {
  const app = !appArg ? join(APPS, "monolith") : appArg.includes("/") ? appArg : join(APPS, appArg);
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const distDir = `.next-gym-${id}`;
  const unit = `gym-${id}`;
  const runDir = ensureDir(join(RUNS, id));
  const logPath = join(runDir, "build.log");

  const childEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    NEXT_TELEMETRY_DISABLED: "1",
    MONOLITH_DIST_DIR: distDir,
    MONOLITH_BUILD_ID: BUILD_ID,
    // fixed so server-reference-manifest.json is comparable across builds
    NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: "Z3ltLWZpeGVkLWtleS1mb3ItY29tcGFyaXNvbnMhISE=",
    ...env,
  };
  if (binding !== "stock") {
    const dir = join(BINDINGS, binding);
    if (!existsSync(join(dir, BINDING_FILE))) throw new Error(`no ${BINDING_FILE} in ${dir}`);
    childEnv.NEXT_TEST_NATIVE_DIR = dir;
  }
  const envArgs = Object.entries(childEnv).map(([k, v]) => `${k}=${v}`);
  const args = [
    "systemd-run",
    "--scope",
    "--quiet",
    `--unit=${unit}`,
    `--uid=${process.getuid()}`,
    `--gid=${process.getgid()}`,
    "-p",
    `AllowedCPUs=${cpus}`,
    "-p",
    `AllowedMemoryNodes=${memoryNodes(cpus)}`,
    "env",
    "-i",
    ...envArgs,
    "node",
    "node_modules/next/dist/bin/next",
    "build",
    "--experimental-build-mode=compile",
  ];

  const cg = `/sys/fs/cgroup/system.slice/${unit}.scope`;
  const samples = []; // [epochMs, usageUsec]
  const t0 = Date.now();
  const child = spawn("sudo", ["-n", ...args], { cwd: app, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  child.stdout.on("data", (d) => log.push(d));
  child.stderr.on("data", (d) => log.push(d));
  let memPeak = 0;
  const timer = setInterval(() => {
    try {
      const stat = readFileSync(`${cg}/cpu.stat`, "utf8");
      samples.push([Date.now(), Number(/usage_usec (\d+)/.exec(stat)[1])]);
      memPeak = Number(readFileSync(`${cg}/memory.peak`, "utf8"));
    } catch {} // scope not created yet, or already gone
  }, SAMPLE_MS);
  const code = await new Promise((r) => child.on("close", r));
  clearInterval(timer);
  const wall = (Date.now() - t0) / 1000;
  writeFileSync(logPath, Buffer.concat(log));
  if (code !== 0) throw new Error(`build failed (exit ${code}); log: ${logPath}`);

  const trace = JSON.parse(readFileSync(join(app, distDir, "trace-build"), "utf8"));
  const ev = Object.fromEntries(trace.map((e) => [e.name, e]));
  // CPU-seconds used inside [start, end] epoch ms, interpolated between samples
  const cpuIn = (start, end) => {
    const at = (t) => {
      if (!samples.length) return 0;
      if (t <= samples[0][0]) return samples[0][1];
      for (let i = 1; i < samples.length; i++) {
        const [ta, ua] = samples[i - 1];
        const [tb, ub] = samples[i];
        if (t <= tb) return ua + ((ub - ua) * (t - ta)) / (tb - ta || 1);
      }
      return samples.at(-1)[1];
    };
    return (at(end) - at(start)) / 1e6;
  };
  const phase = (name) => {
    const e = ev[name];
    if (!e) return null;
    const s = e.duration / 1e6;
    const cpu = cpuIn(e.startTime, e.startTime + e.duration / 1000);
    return { s: +s.toFixed(3), cores: +(cpu / s).toFixed(2) };
  };
  const totalCpu = samples.length ? samples.at(-1)[1] / 1e6 : 0;
  const rec = {
    id,
    label,
    binding,
    cpus,
    ncpu: cpuCount(cpus),
    env,
    app: app.split("/").at(-1),
    when: new Date(t0).toISOString(),
    wall: +wall.toFixed(3),
    cores: +(totalCpu / wall).toFixed(2),
    memPeakGB: +(memPeak / 2 ** 30).toFixed(2),
    graph: phase("turbopack-module-graph"),
    entrypoints: phase("turbopack-write-entrypoints"),
    emit: phase("turbopack-emit"),
    turbopack: phase("run-turbopack"),
    persistence: phase("turbopack-persistence"),
    output: fingerprint(join(app, distDir)),
    machine: machine(),
  };
  // timeline in 1s buckets of cores used, for plots
  const timeline = [];
  for (let t = t0; t < t0 + wall * 1000; t += 1000) timeline.push(+cpuIn(t, t + 1000).toFixed(2));
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({ ...rec, timeline, phases: trace }, null, 1),
  );
  if (!keep) rmSync(join(app, distDir), { recursive: true, force: true });
  if (!quiet)
    console.error(
      `[bench] ${label || binding} cpus=${cpus} wall=${rec.wall}s graph=${rec.graph?.s}s@${rec.graph?.cores}c turbopack=${rec.turbopack?.s}s cores=${rec.cores} mem=${rec.memPeakGB}G out=${rec.output.sha}`,
    );
  return rec;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2), {
    binding: 1,
    cpus: 1,
    app: 1,
    env: "list",
    label: 1,
    out: 1,
    keep: "bool",
    repeat: 1,
  });
  const env = Object.fromEntries((a.env || []).map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
  const out = a.out || join(RESULTS, "runs.jsonl");
  for (let i = 0; i < Number(a.repeat || 1); i++) {
    const rec = await bench({
      binding: a.binding,
      cpus: a.cpus || "0-95",
      app: a.app,
      env,
      label: a.label,
      keep: a.keep,
    });
    appendJsonl(out, rec);
    console.log(JSON.stringify(rec));
  }
}

#!/usr/bin/env node
// One cold `next build --experimental-build-mode=compile` of a generated app, inside
// a transient systemd scope pinned to a CPU set (memory on that set's NUMA nodes).
// Reports the Turbopack phase durations and start offsets from <distDir>/trace-build,
// the CPU used during each phase (the scope's cpu.stat, sampled every SAMPLE_MS), an
// output fingerprint, and what ran (app tree hash, binding provenance, machine).
//
//   node scripts/turbopack-gym/bench.mjs --binding base --cpus 0-31
//   node scripts/turbopack-gym/bench.mjs --binding stock --cpus 0-15 --env TURBO_TASKS_AVAILABLE_PARALLELISM=8
//
// A bare bench.mjs takes the CPU locks of its --cpus (lib.withCpus), so it waits for an
// A/B on overlapping CPUs.
//
// --binding: "stock" (the npm @next/swc package) or a directory name under
//            $GYM_ROOT/bindings holding next-swc.<triple>.node.
// --app:     app name under $GYM_ROOT/apps or a path (default monolith).
// --out:     JSONL file to append to (default runs.jsonl in the results dir).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  APPS,
  RESULTS,
  RUNS,
  appendJsonl,
  cpuCount,
  checkAborted,
  ensureDir,
  machine,
  onAbort,
  parseArgs,
  withCpus,
} from "./lib.mjs";
import { resolveBinding } from "./bindings.mjs";

const SAMPLE_MS = 100;
// Samples a scope's cgroup every interval: "<epoch ms> <usage_usec> <system_usec>
// <memory.peak>" per line, from the scope's appearance until it is gone and stdin closes.
const SAMPLER = `
import sys, time, select
cg, every = sys.argv[1], float(sys.argv[2])
seen = False
stdin_open = True
while True:
    try:
        stat = open(cg + "/cpu.stat").read().split()
        kv = dict(zip(stat[0::2], stat[1::2]))
        peak = open(cg + "/memory.peak").read().strip()
        print(int(time.time() * 1000), kv["usage_usec"], kv["system_usec"], peak, flush=True)
        seen = True
    except (FileNotFoundError, OSError, KeyError):
        if seen and not stdin_open:
            break
    if stdin_open and select.select([sys.stdin], [], [], 0)[0] and not sys.stdin.read(1):
        stdin_open = False
    if not seen and not stdin_open:
        break
    time.sleep(every)
`;
const BUILD_ID = "gym";
const sha16 = (data) => createHash("sha256").update(data).digest("hex").slice(0, 16);

// Fingerprint of a build's output, so a candidate that skips or changes work shows up
// as different output rather than a speedup. Every emitted file counts except the
// top-level persistent cache and trace files and server/preview-props.json (per-build
// random keys). `exactSha` hashes paths and bytes as written. Turbopack's output is not
// byte-identical across builds of one binding (the two sides of an A/A differ in
// exactSha), so `sha` hashes a normalized form of every path and content: the per-run
// distDir name, script and stylesheet file names (.js/.css and their .map: chunk names
// carry per-build hashes), and 32+ character hex strings (file hashes in .nft.json,
// preview keys) are replaced everywhere; one- and two-character identifiers (minified
// locals) are replaced outside string literals. Files then match as a multiset per
// directory, and every file's remaining content, strings included, is compared.
const SKIP_TOP = new Set(["cache", "trace", "trace-build", "trace-turbopack"]);
const SKIP_PATHS = new Set(["server/preview-props.json"]);
export function normalizer(dist) {
  const strOrIdent =
    /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(?<![\w$])[A-Za-z_$][\w$]?(?![\w$])/g;
  return (text) =>
    text
      .replaceAll(dist, "<dist>")
      .replace(/[\w.\-]+\.(?:js|css)(?:\.map)?\b/g, "#file")
      .replace(/\b[0-9a-f]{32,}\b/g, "#h")
      .replace(strOrIdent, (m, str) => str ?? "_");
}

// path -> [exact hash, normalized path, normalized hash] for every fingerprinted file
export function outputFiles(distDir) {
  const norm = normalizer(distDir.split("/").at(-1));
  const files = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if ((!rel && SKIP_TOP.has(e.name)) || SKIP_PATHS.has(r)) continue;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else {
        const buf = readFileSync(join(dir, e.name));
        files.push([r, sha16(buf), norm(r), sha16(norm(buf.toString("latin1")))]);
      }
    }
  };
  walk(distDir, "");
  return files;
}

export function fingerprint(distDir) {
  const files = outputFiles(distDir);
  if (!files.length) throw new Error(`empty output in ${distDir}`);
  return {
    files: files.length,
    sha: sha16(
      files
        .map(([, , p, h]) => `${p}\t${h}`)
        .sort()
        .join("\n"),
    ),
    exactSha: sha16(
      files
        .map(([p, h]) => `${p}\t${h}`)
        .sort()
        .join("\n"),
    ),
  };
}

// Content hash of what a build of the app compiles: its generated tree (sources,
// manifests, configs; not node_modules or build output) and the installed versions of
// next, react, react-dom and @next/swc. Computed for every run.
export function appTreeHash(app) {
  const entries = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".next")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else entries.push(`${r}\t${sha16(readFileSync(join(dir, e.name)))}`);
    }
  };
  walk(app, "");
  for (const pkg of ["next", "react", "react-dom"]) {
    const p = join(app, "node_modules", pkg, "package.json");
    entries.push(
      `installed:${pkg}\t${existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).version : "-"}`,
    );
  }
  const pnpmDir = join(app, "node_modules", ".pnpm");
  if (existsSync(pnpmDir))
    for (const d of readdirSync(pnpmDir).filter((d) => d.startsWith("@next+swc")))
      entries.push(`installed:${d}`);
  return sha16(entries.sort().join("\n"));
}

// NUMA nodes whose CPUs intersect a cpu list, so a lane's memory stays local to it
export function memoryNodes(cpus) {
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

// A build runs in its own systemd scope, which outlives this process if it is killed:
// on SIGINT/SIGTERM (lib.onAbort) stop the scopes of builds in flight, which ends their
// `next build`, so bench throws and every caller's finally runs.
const liveUnits = new Set();
onAbort(() => {
  for (const u of liveUnits) {
    try {
      execFileSync("sudo", ["-n", "systemctl", "stop", `${u}.scope`], { stdio: "ignore" });
    } catch {}
  }
});

// Everything a run needs before it starts (hashing a binding and the app takes time
// that must not fall between the launches of an A/B's two builds).
export function prepare({ binding = "base", app: appArg }) {
  const app = !appArg ? join(APPS, "monolith") : appArg.includes("/") ? appArg : join(APPS, appArg);
  const resolved = binding === "stock" ? null : resolveBinding(binding);
  const buildNode = execFileSync("node", ["--version"], { encoding: "utf8" }).trim();
  return { app, resolved, appHash: appTreeHash(app), buildNode };
}

// prepared: prepare()'s result for this binding and app (an A/B prepares both sides
// before launching either); computed here when absent.
export async function bench({
  binding = "base",
  prepared,
  cpus,
  app: appArg,
  env = {},
  label = "",
  keep = false,
  quiet = false,
}) {
  checkAborted();
  const { app, resolved, appHash, buildNode } = prepared || prepare({ binding, app: appArg });
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
  const source = resolved ? resolved.source : { npm: "@next/swc (the installed next version)" };
  if (resolved) childEnv.NEXT_TEST_NATIVE_DIR = resolved.dir;
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
  const t0 = Date.now();
  liveUnits.add(unit);
  const child = spawn("sudo", ["-n", ...args], { cwd: app, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  child.stdout.on("data", (d) => log.push(d));
  child.stderr.on("data", (d) => log.push(d));
  // the scope's cpu.stat is sampled by its own process, so this process's event loop
  // (other builds' fingerprints, hashing) cannot delay or thin the samples
  const sampler = spawn("python3", ["-c", SAMPLER, cg, String(SAMPLE_MS / 1000)], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let sampled = "";
  sampler.stdout.on("data", (d) => (sampled += d));
  const samplerDone = new Promise((r) => sampler.on("close", r));
  const code = await new Promise((r) => child.on("close", r));
  sampler.stdin.end(); // ends the sampler once the scope is gone
  await samplerDone;
  liveUnits.delete(unit);
  const samples = []; // [epochMs, usageUsec, systemUsec]
  let memPeak = 0;
  for (const line of sampled.trim().split("\n").filter(Boolean)) {
    const [ms, usage, system, peak] = line.split(" ").map(Number);
    samples.push([ms, usage, system]);
    memPeak = Math.max(memPeak, peak);
  }
  const wall = (Date.now() - t0) / 1000;
  writeFileSync(logPath, Buffer.concat(log));
  const fail = (msg) => {
    rmSync(join(app, distDir), { recursive: true, force: true });
    throw new Error(`${msg}; log: ${logPath}`);
  };
  if (code !== 0) fail(`build failed (exit ${code})`);
  // CPU accounting must cover the build: missing or gapped sampling is an error, not 0
  const maxGap = Math.max(0, ...samples.slice(1).map((x, i) => x[0] - samples[i][0]));
  if (samples.length < 3 || maxGap > 3000)
    fail(`cgroup sampling: ${samples.length} samples over ${wall}s, largest gap ${maxGap} ms`);

  const trace = JSON.parse(readFileSync(join(app, distDir, "trace-build"), "utf8"));
  const ev = Object.fromEntries(trace.map((e) => [e.name, e]));
  // CPU-seconds used inside [start, end] epoch ms, interpolated between samples;
  // col 1 is total (usage_usec), col 2 kernel time (system_usec)
  const cpuIn = (start, end, col = 1) => {
    const at = (t) => {
      if (t <= samples[0][0]) return samples[0][col];
      for (let i = 1; i < samples.length; i++) {
        const [ta, ua] = [samples[i - 1][0], samples[i - 1][col]];
        const [tb, ub] = [samples[i][0], samples[i][col]];
        if (t <= tb) return ua + ((ub - ua) * (t - ta)) / (tb - ta || 1);
      }
      return samples.at(-1)[col];
    };
    return (at(end) - at(start)) / 1e6;
  };
  const phase = (name, required) => {
    const e = ev[name];
    if (!e) {
      if (required) fail(`trace-build has no ${name} event`);
      return null;
    }
    const s = e.duration / 1e6;
    const [a, b] = [e.startTime, e.startTime + e.duration / 1000];
    const cpu = cpuIn(a, b);
    return {
      s: +s.toFixed(3),
      at: +((a - t0) / 1000).toFixed(3),
      cores: +(cpu / s).toFixed(2),
      sysShare: cpu ? +(cpuIn(a, b, 2) / cpu).toFixed(3) : 0,
    };
  };
  const totalCpu = samples.at(-1)[1] / 1e6;
  const rec = {
    id,
    label,
    binding,
    cpus,
    ncpu: cpuCount(cpus),
    env,
    app: app.split("/").at(-1),
    appHash,
    when: new Date(t0).toISOString(),
    wall: +wall.toFixed(3),
    cores: +(totalCpu / wall).toFixed(2),
    memPeakGiB: +(memPeak / 2 ** 30).toFixed(2),
    graph: phase("turbopack-module-graph", true),
    entrypoints: phase("turbopack-write-entrypoints", true),
    emit: phase("turbopack-emit", true),
    turbopack: phase("run-turbopack", true),
    persistence: phase("turbopack-persistence", false),
    output: fingerprint(join(app, distDir)),
    machine: { ...machine(), buildNode },
    bindingSource: source,
  };
  // timeline in 1s buckets of cores used, for plots
  const timeline = [];
  for (let t = t0; t < t0 + wall * 1000; t += 1000) timeline.push(+cpuIn(t, t + 1000).toFixed(2));
  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({ ...rec, timeline, phases: trace }, null, 1),
  );
  if (!keep) rmSync(join(app, distDir), { recursive: true, force: true });
  rec.distDir = keep ? join(app, distDir) : null;
  if (!quiet)
    console.error(
      `[bench] ${label || binding} cpus=${cpus} wall=${rec.wall}s graph=${rec.graph.s}s@${rec.graph.cores}c turbopack=${rec.turbopack.s}s cores=${rec.cores} mem=${rec.memPeakGiB}G out=${rec.output.sha}`,
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
  if (!a.cpus) throw new Error("--cpus is required (e.g. 0-31)");
  const env = Object.fromEntries((a.env || []).map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
  const out = a.out || join(RESULTS, "runs.jsonl");
  await withCpus(a.cpus, async () => {
    for (let i = 0; i < Number(a.repeat || 1); i++) {
      const rec = await bench({
        binding: a.binding,
        cpus: a.cpus,
        app: a.app,
        env,
        label: a.label,
        keep: a.keep,
      });
      appendJsonl(out, rec);
      console.log(JSON.stringify(rec));
    }
  });
}

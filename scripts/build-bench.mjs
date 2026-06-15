#!/usr/bin/env node
// Build benchmark: full `turbo run build` of all apps, Next vs Vite, same scale.
//
//   node scripts/build-bench.mjs 40 24 12      # apps libs concurrency
//
// Node, robust: child output -> log FILE, resource stats -> stats FILE via
// `/usr/bin/time -v -o` (no in-memory buffering / ENOBUFS). Failures throw with
// the build log; a zero-byte output is treated as an error, not "0.0MB".
// Next apps are App Router SSR; Vite apps are SPA, so this is a build-tool
// comparison, not feature parity.

import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const APPS = +(process.argv[2] || 40);
const LIBS = +(process.argv[3] || 24);
const CONC = process.argv[4] || "12";
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", TURBO_TELEMETRY_DISABLED: "1" };
const TIMEFILE = "/tmp/build-bench.time";
const LOGFILE = "/tmp/build-bench.log";

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 27, env });
  if (r.status !== 0) throw new Error(`${label} failed:\n${(r.stderr || r.stdout || "").slice(-1500)}`);
  return r;
}
function timedBuild() {
  const logFd = openSync(LOGFILE, "w");
  const t0 = process.hrtime.bigint();
  const r = spawnSync("/usr/bin/time", ["-v", "-o", TIMEFILE, "pnpm", "exec", "turbo", "run", "build", `--concurrency=${CONC}`, "--output-logs=errors-only"], { cwd: REPO, env, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.status !== 0) throw new Error(`build failed (status ${r.status}):\n${(existsSync(LOGFILE) ? readFileSync(LOGFILE, "utf8") : "").slice(-2500)}`);
  const stats = existsSync(TIMEFILE) ? readFileSync(TIMEFILE, "utf8") : "";
  const cpu = (stats.match(/Percent of CPU[^:]*:\s*(\d+)/) || [])[1];
  const rss = (stats.match(/Maximum resident set size[^:]*:\s*(\d+)/) || [])[1];
  return { ms, cpuPct: cpu ? +cpu : null, rssMB: rss ? Math.round(+rss / 1024) : null };
}
function outputBytes(glob) {
  const r = spawnSync("bash", ["-c", `find apps -mindepth 2 -maxdepth 2 -type d -name '${glob}' -exec du -sb {} + 2>/dev/null | awk '{s+=$1} END {print s+0}'`], { cwd: REPO, encoding: "utf8" });
  const n = parseInt((r.stdout || "0").trim(), 10) || 0;
  if (n === 0) throw new Error(`no build output found for apps/*/${glob} (build produced nothing?)`);
  return n;
}
function benchOne(framework, glob) {
  run("node", ["scripts/generate.mjs", "--apps", String(APPS), "--libs", String(LIBS), "--modules", "12", "--framework", framework, "--clean"], "generate");
  run("pnpm", ["install", "--config.confirm-modules-purge=false"], "install");
  rmSync(join(REPO, ".turbo"), { recursive: true, force: true });
  const t = timedBuild();
  return { framework, ...t, outputBytes: outputBytes(glob) };
}

const next = benchOne("next", ".next");
console.log(`next: ${next.ms}ms, ${next.cpuPct}%cpu, output ${(next.outputBytes / 1e6).toFixed(1)}MB`);
const vite = benchOne("vite", "dist");
console.log(`vite: ${vite.ms}ms, ${vite.cpuPct}%cpu, output ${(vite.outputBytes / 1e6).toFixed(1)}MB`);

const out = { apps: APPS, libs: LIBS, concurrency: CONC, next, vite };
writeFileSync(join(REPO, "bench/build-bench.json"), JSON.stringify(out, null, 2));
console.log("--- bench/build-bench.json written ---");

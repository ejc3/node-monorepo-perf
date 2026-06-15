#!/usr/bin/env node
// Install benchmark: pnpm (isolated + hoisted) vs bun, across workspace sizes.
//
//   node scripts/install-bench.mjs "300:100 1500:300"
//
// Robustness (so the benchmark can't quietly cheat):
//   - failures THROW with the install log tail (never swallowed)
//   - child output goes to a log FILE and resource stats to a stats FILE via
//     `/usr/bin/time -v -o`, so nothing is buffered in memory (no ENOBUFS abort
//     misreported as an install failure at large scale)
//   - every install is verified COMPLETE: a sample app must resolve all its
//     declared deps in node_modules
//   - layout controlled: pnpm-isolated (default), pnpm-hoisted (bun's flat
//     layout), bun (hoisted)
//   - cold = no lockfile (resolve); warm = lockfile present, node_modules removed
//   - one truly-cold pass (fresh pnpm store + cleared bun cache, checked)
//   - host stats: CPU% (cores) and peak RSS per install
//   - results persisted after each scale
//
// bun ignores pnpm-workspace.yaml and catalog:, so we run in an isolated dir with
// a decataloged workspace and a package.json "workspaces" field both tools read.

import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, cpus } from "node:os";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DIR = "/tmp/pm-bench";
const BUN = join(homedir(), ".bun/bin/bun");
const CORES = cpus().length;
const TIMEFILE = "/tmp/pm-bench.time";
const LOGFILE = "/tmp/pm-bench.log";
const SCALES = (process.argv[2] || "300:100 1500:300").trim().split(/\s+/).map((s) => {
  const [a, l] = s.split(":");
  return { apps: +a, libs: +l };
});

function node(args) {
  const r = spawnSync("node", args, { cwd: DIR, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`node ${args.join(" ")} failed:\n${(r.stderr || "").slice(-1000)}`);
}
// timed install via `/usr/bin/time -v -o STATS`; child output -> LOG file (no
// in-memory buffering). Throws on failure with the log tail. Returns {ms,cpuPct,rssMB}.
function timedInstall(cmd, args) {
  const logFd = openSync(LOGFILE, "w");
  const t0 = process.hrtime.bigint();
  const r = spawnSync("/usr/bin/time", ["-v", "-o", TIMEFILE, cmd, ...args], { cwd: DIR, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.status !== 0) throw new Error(`INSTALL FAILED (status ${r.status}): ${cmd} ${args.join(" ")}\n${(existsSync(LOGFILE) ? readFileSync(LOGFILE, "utf8") : "").slice(-1500)}`);
  const stats = existsSync(TIMEFILE) ? readFileSync(TIMEFILE, "utf8") : "";
  const cpu = (stats.match(/Percent of CPU[^:]*:\s*(\d+)/) || [])[1];
  const rss = (stats.match(/Maximum resident set size[^:]*:\s*(\d+)/) || [])[1];
  return { ms, cpuPct: cpu ? +cpu : null, rssMB: rss ? Math.round(+rss / 1024) : null };
}
function entries() {
  const r = spawnSync("find", ["node_modules", "-printf", "."], { cwd: DIR, encoding: "utf8", maxBuffer: 1 << 28 });
  return (r.stdout || "").length;
}
function verifyComplete() {
  const appsDir = join(DIR, "apps");
  const app = join(appsDir, readdirSync(appsDir).filter((d) => d.startsWith("app-")).sort()[0]);
  const deps = Object.keys(JSON.parse(readFileSync(join(app, "package.json"), "utf8")).dependencies || {});
  const found = (dep) => { let d = app; for (;;) { if (existsSync(join(d, "node_modules", dep, "package.json"))) return true; const u = dirname(d); if (u === d) return false; d = u; } };
  const miss = deps.filter((d) => !found(d));
  if (miss.length) throw new Error(`INCOMPLETE install, sample app missing: ${miss.join(", ")}`);
  return deps.length;
}
function setup(apps, libs) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  node([join(REPO, "scripts/generate.mjs"), "--apps", String(apps), "--libs", String(libs), "--modules", "12", "--clean"]);
  node([join(REPO, "scripts/rewrite-protocols.mjs"), "--dir", "apps", "--catalog", join(REPO, "pnpm-workspace.yaml")]);
  node([join(REPO, "scripts/rewrite-protocols.mjs"), "--dir", "packages", "--catalog", join(REPO, "pnpm-workspace.yaml")]);
  writeFileSync(join(DIR, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  writeFileSync(join(DIR, "package.json"), JSON.stringify({ name: "pm-bench", private: true, workspaces: ["apps/*", "packages/*"] }) + "\n");
}
const rmNM = () => rmSync(join(DIR, "node_modules"), { recursive: true, force: true });
const rmLocks = () => { for (const f of ["pnpm-lock.yaml", "bun.lock", "bun.lockb"]) rmSync(join(DIR, f), { force: true }); };
const PI = ["install", "--config.confirm-modules-purge=false"];

const out = { hostCores: CORES, scales: [], trulyCold: null };
const persist = () => writeFileSync(join(REPO, "bench/install-bench.json"), JSON.stringify(out, null, 2));

console.log(`host: ${CORES} cores`);
for (const { apps, libs } of SCALES) {
  setup(apps, libs);

  rmNM(); rmLocks();
  const piC = timedInstall("pnpm", [...PI, "--config.node-linker=isolated"]);
  const deps = verifyComplete(); const piNm = entries();
  rmNM(); const piW = timedInstall("pnpm", [...PI, "--config.node-linker=isolated"]); verifyComplete();

  rmNM(); rmLocks();
  const phC = timedInstall("pnpm", [...PI, "--config.node-linker=hoisted"]); verifyComplete(); const phNm = entries();
  rmNM(); const phW = timedInstall("pnpm", [...PI, "--config.node-linker=hoisted"]); verifyComplete();

  rmNM(); rmLocks();
  const bC = timedInstall(BUN, ["install"]); verifyComplete(); const bNm = entries();
  rmNM(); const bW = timedInstall(BUN, ["install"]); verifyComplete();

  out.scales.push({
    apps, libs, sampleAppDeps: deps,
    pnpmIsolated: { coldMs: piC.ms, coldCpuPct: piC.cpuPct, coldRssMB: piC.rssMB, warmMs: piW.ms, nmEntries: piNm },
    pnpmHoisted: { coldMs: phC.ms, coldCpuPct: phC.cpuPct, coldRssMB: phC.rssMB, warmMs: phW.ms, nmEntries: phNm },
    bun: { coldMs: bC.ms, coldCpuPct: bC.cpuPct, coldRssMB: bC.rssMB, warmMs: bW.ms, nmEntries: bNm },
  });
  persist();
  console.log(`${apps}/${libs} (sample app deps verified: ${deps})`);
  console.log(`  pnpm-isolated cold ${piC.ms}ms ${piC.cpuPct}%cpu warm ${piW.ms}ms  nm ${piNm}  rss ${piC.rssMB}MB`);
  console.log(`  pnpm-hoisted  cold ${phC.ms}ms ${phC.cpuPct}%cpu warm ${phW.ms}ms  nm ${phNm}  rss ${phC.rssMB}MB`);
  console.log(`  bun           cold ${bC.ms}ms ${bC.cpuPct}%cpu warm ${bW.ms}ms  nm ${bNm}  rss ${bC.rssMB}MB`);
}

const { apps: fa, libs: fl } = SCALES[0];
setup(fa, fl);
const coldStore = "/tmp/pm-bench-coldstore";
rmSync(coldStore, { recursive: true, force: true });
rmNM(); rmLocks();
const tcPnpm = timedInstall("pnpm", [...PI, "--config.node-linker=hoisted", "--store-dir", coldStore]); verifyComplete();
const cc = spawnSync(BUN, ["pm", "cache", "rm"], { cwd: DIR, encoding: "utf8" });
if (cc.status !== 0) console.warn("WARNING: `bun pm cache rm` failed; truly-cold bun number may use a warm cache");
rmNM(); rmLocks();
const tcBun = timedInstall(BUN, ["install"]); verifyComplete();
rmSync(coldStore, { recursive: true, force: true });
out.trulyCold = { apps: fa, libs: fl, pnpmHoistedMs: tcPnpm.ms, bunMs: tcBun.ms };
persist();
console.log(`truly-cold (cleared caches, network) @ ${fa}/${fl}: pnpm-hoisted ${tcPnpm.ms}ms, bun ${tcBun.ms}ms`);
console.log("--- bench/install-bench.json written ---");

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
//   - every install is verified COMPLETE: every app and lib must resolve all
//     its declared deps in node_modules
//   - layout controlled: pnpm-isolated (default), pnpm-hoisted (bun's flat
//     layout), bun (hoisted)
//   - cold = no lockfile present, full resolve + link against the warm global
//     content store (no network download); warm = lockfile present,
//     node_modules removed, relink only
//   - one truly-cold pass uses a fresh pnpm store AND a fresh metadata cache-dir
//     (so pnpm re-fetches registry metadata, matching bun's `bun pm cache rm`),
//     real network; the fresh cache-dir is asserted populated so a silently-ignored
//     flag can't let a metadata-warm number read as cold
//   - host stats: CPU% (cores) and peak RSS per install
//   - results persisted after each scale
//
// bun ignores pnpm-workspace.yaml and catalog:, so we run in an isolated dir with
// a decataloged workspace and a package.json "workspaces" field both tools read.

import { spawnSync } from "node:child_process";
import {
  rmSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  openSync,
  closeSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, cpus, tmpdir } from "node:os";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DIR = "/tmp/pm-bench";
const BUN = join(homedir(), ".bun/bin/bun");
const CORES = cpus().length;
const TIMEFILE = "/tmp/pm-bench.time";
const LOGFILE = "/tmp/pm-bench.log";
const SCALES = (process.argv[2] || "300:100 1500:300")
  .trim()
  .split(/\s+/)
  .map((s) => {
    const [a, l] = s.split(":");
    return { apps: +a, libs: +l };
  });

function node(args) {
  const r = spawnSync("node", args, { cwd: DIR, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0)
    throw new Error(`node ${args.join(" ")} failed:\n${(r.stderr || "").slice(-1000)}`);
}
// timed install via `/usr/bin/time -v -o STATS`; child output -> LOG file (no
// in-memory buffering). Throws on failure with the log tail. Returns {ms,cpuPct,rssMB}.
function timedInstall(cmd, args) {
  const logFd = openSync(LOGFILE, "w");
  const t0 = process.hrtime.bigint();
  const r = spawnSync("/usr/bin/time", ["-v", "-o", TIMEFILE, cmd, ...args], {
    cwd: DIR,
    stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.error) {
    throw new Error(
      `cannot spawn /usr/bin/time (${r.error.code}): ${r.error.message}\n` +
        "the benchmark requires GNU time at /usr/bin/time; install it (e.g. `apt-get install time`).",
    );
  }
  if (r.status !== 0)
    throw new Error(
      `INSTALL FAILED (status ${r.status}): ${cmd} ${args.join(" ")}\n${(existsSync(LOGFILE) ? readFileSync(LOGFILE, "utf8") : "").slice(-1500)}`,
    );
  const stats = existsSync(TIMEFILE) ? readFileSync(TIMEFILE, "utf8") : "";
  const cpu = (stats.match(/Percent of CPU[^:]*:\s*(\d+)/) || [])[1];
  const rss = (stats.match(/Maximum resident set size[^:]*:\s*(\d+)/) || [])[1];
  return { ms, cpuPct: cpu ? +cpu : null, rssMB: rss ? Math.round(+rss / 1024) : null };
}
function entries() {
  // full-tree node_modules footprint: the root virtual store (.pnpm) AND every
  // per-package node_modules. The isolated linker's per-app symlink trees live
  // under apps/*/node_modules, so counting only the root dir undercounts it.
  // pipefail + strict parse so a failed find surfaces instead of becoming 0.
  const r = spawnSync(
    "bash",
    ["-c", "set -o pipefail; find . -path '*/node_modules/*' -printf '.' | wc -c"],
    { cwd: DIR, encoding: "utf8", maxBuffer: 1 << 28 },
  );
  if (r.error || r.status !== 0) {
    throw new Error(
      `node_modules entry count failed: ${r.error?.message || r.stderr || `status ${r.status}`}`,
    );
  }
  const n = parseInt((r.stdout || "").trim(), 10);
  if (!Number.isFinite(n)) throw new Error(`node_modules entry count was non-numeric: ${r.stdout}`);
  return n;
}
// Resolve `dep` from `dir` by walking node_modules upward, STOPPING at the
// benchmark workspace root (DIR) — an ambient /tmp/node_modules or parent
// node_modules must not satisfy verification for an incomplete install.
function resolvesFrom(dir, dep) {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, "node_modules", dep, "package.json"))) return true;
    if (d === DIR) return false;
    const u = dirname(d);
    if (u === d) return false;
    d = u;
  }
}
function verifyComplete() {
  // Every package under apps/* and packages/* must resolve all its declared
  // dependencies, not just a single sample app.
  const pkgDirs = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(DIR, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, name);
      if (existsSync(join(pkgDir, "package.json"))) pkgDirs.push(pkgDir);
    }
  }
  const missing = [];
  let edges = 0;
  for (const pkgDir of pkgDirs) {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    // verify dependencies AND devDependencies — a partial/prod-mode install that
    // dropped typescript/types would otherwise pass as "complete".
    const deps = [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
    ];
    for (const dep of deps) {
      edges++;
      if (!resolvesFrom(pkgDir, dep)) {
        if (missing.length < 20) missing.push(`${pkgDir} -> ${dep}`);
      }
    }
  }
  if (missing.length) {
    throw new Error(`INCOMPLETE install, unresolved deps:\n${missing.slice(0, 10).join("\n")}`);
  }
  return edges;
}
function setup(apps, libs) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  node([
    join(REPO, "scripts/generate.mjs"),
    "--apps",
    String(apps),
    "--libs",
    String(libs),
    "--modules",
    "12",
    "--clean",
  ]);
  node([
    join(REPO, "scripts/rewrite-protocols.mjs"),
    "--dir",
    "apps",
    "--catalog",
    join(REPO, "pnpm-workspace.yaml"),
  ]);
  node([
    join(REPO, "scripts/rewrite-protocols.mjs"),
    "--dir",
    "packages",
    "--catalog",
    join(REPO, "pnpm-workspace.yaml"),
  ]);
  writeFileSync(join(DIR, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  writeFileSync(
    join(DIR, "package.json"),
    JSON.stringify({ name: "pm-bench", private: true, workspaces: ["apps/*", "packages/*"] }) +
      "\n",
  );
}
// Remove the root virtual store AND every per-package node_modules. The isolated
// linker symlinks apps/*/node_modules and packages/*/node_modules; leaving them
// lets a later linker/manager reuse stale links and time a partial no-op (a warm
// relink or cross-linker install would be measured too fast).
const rmNM = () => {
  const r = spawnSync(
    "bash",
    ["-c", "find . -name node_modules -type d -prune -exec rm -rf {} +"],
    {
      cwd: DIR,
      encoding: "utf8",
    },
  );
  if (r.error || r.status !== 0) {
    throw new Error(
      `node_modules cleanup failed (a stale tree would let the next install time a no-op): ${r.error?.message || r.stderr || `status ${r.status}`}`,
    );
  }
};
const rmLocks = () => {
  for (const f of ["pnpm-lock.yaml", "bun.lock", "bun.lockb"])
    rmSync(join(DIR, f), { force: true });
};
const PI = ["install", "--config.confirm-modules-purge=false"];

const out = { hostCores: CORES, scales: [], trulyCold: null };
const persist = () =>
  writeFileSync(join(REPO, "bench/install-bench.json"), JSON.stringify(out, null, 2));

console.log(`host: ${CORES} cores`);
// pre-warm the global content store so every per-scale "cold" (no lockfile) is a
// genuine warm-store install (no network), as documented — not a cache-order
// artifact of whichever scale ran first. The truly-cold pass below uses its own
// fresh --store-dir to measure the network-cold case.
setup(SCALES[0].apps, SCALES[0].libs);
timedInstall("pnpm", [...PI, "--config.node-linker=isolated"]); // warm pnpm store (discard)
rmNM();
rmLocks();
timedInstall(BUN, ["install"]); // warm bun cache (discard)

for (const { apps, libs } of SCALES) {
  setup(apps, libs);

  rmNM();
  rmLocks();
  const piC = timedInstall("pnpm", [...PI, "--config.node-linker=isolated"]);
  const depEdgesVerified = verifyComplete();
  const piNm = entries();
  rmNM();
  const piW = timedInstall("pnpm", [...PI, "--config.node-linker=isolated"]);
  verifyComplete();

  rmNM();
  rmLocks();
  const phC = timedInstall("pnpm", [...PI, "--config.node-linker=hoisted"]);
  verifyComplete();
  const phNm = entries();
  rmNM();
  const phW = timedInstall("pnpm", [...PI, "--config.node-linker=hoisted"]);
  verifyComplete();

  rmNM();
  rmLocks();
  const bC = timedInstall(BUN, ["install"]);
  verifyComplete();
  const bNm = entries();
  rmNM();
  const bW = timedInstall(BUN, ["install"]);
  verifyComplete();

  out.scales.push({
    apps,
    libs,
    depEdgesVerified,
    pnpmIsolated: {
      coldMs: piC.ms,
      coldCpuPct: piC.cpuPct,
      coldRssMB: piC.rssMB,
      warmMs: piW.ms,
      nmEntries: piNm,
    },
    pnpmHoisted: {
      coldMs: phC.ms,
      coldCpuPct: phC.cpuPct,
      coldRssMB: phC.rssMB,
      warmMs: phW.ms,
      nmEntries: phNm,
    },
    bun: {
      coldMs: bC.ms,
      coldCpuPct: bC.cpuPct,
      coldRssMB: bC.rssMB,
      warmMs: bW.ms,
      nmEntries: bNm,
    },
  });
  persist();
  console.log(`${apps}/${libs} (dep edges verified: ${depEdgesVerified} (all packages))`);
  console.log(
    `  pnpm-isolated cold ${piC.ms}ms ${piC.cpuPct}%cpu warm ${piW.ms}ms  nm ${piNm}  rss ${piC.rssMB}MB`,
  );
  console.log(
    `  pnpm-hoisted  cold ${phC.ms}ms ${phC.cpuPct}%cpu warm ${phW.ms}ms  nm ${phNm}  rss ${phC.rssMB}MB`,
  );
  console.log(
    `  bun           cold ${bC.ms}ms ${bC.cpuPct}%cpu warm ${bW.ms}ms  nm ${bNm}  rss ${bC.rssMB}MB`,
  );
}

const { apps: fa, libs: fl } = SCALES[0];
setup(fa, fl);
// Per-run temp dirs (not fixed /tmp paths) so a second install-bench in another git
// worktree — the project's encouraged parallel pattern — can't collide on the store/cache.
const coldStore = mkdtempSync(join(tmpdir(), "pm-bench-store-"));
// Symmetrically with bun's `bun pm cache rm` below, pnpm must also start metadata-cold: a
// fresh --store-dir clears only the CONTENT store, leaving the registry METADATA cache
// (cache-dir, default ~/.cache/pnpm) warm, which would put the two sides in different cold
// regimes. Pin a fresh cache-dir so pnpm re-fetches metadata too, matching bun.
const coldCache = mkdtempSync(join(tmpdir(), "pm-bench-cache-"));
rmNM();
rmLocks();
const tcPnpm = timedInstall("pnpm", [
  ...PI,
  "--config.node-linker=hoisted",
  "--store-dir",
  coldStore,
  `--config.cache-dir=${coldCache}`,
]);
verifyComplete();
// The metadata-cold claim hinges on --config.cache-dir taking effect. If a future pnpm stops
// honoring it, pnpm silently falls back to the warm ~/.cache/pnpm metadata and the truly-cold
// number drops to its metadata-WARM value — a regression that would read as a fast clean pass.
// Assert pnpm actually populated the fresh cache, or the truly-cold pnpm number is meaningless.
if (!existsSync(coldCache) || readdirSync(coldCache).length === 0)
  throw new Error(
    `pnpm wrote nothing to the fresh cache-dir ${coldCache} — --config.cache-dir not honored; ` +
      `the truly-cold pnpm number would be metadata-warm, not cold.`,
  );
const cc = spawnSync(BUN, ["pm", "cache", "rm"], { cwd: DIR, encoding: "utf8" });
if (cc.status !== 0) {
  const tail = ((cc.stderr || "") + (cc.stdout || "")).slice(-1000);
  throw new Error(
    `\`bun pm cache rm\` failed (status ${cc.status}); a warm cache invalidates the truly-cold claim.\n${tail}`,
  );
}
rmNM();
rmLocks();
const tcBun = timedInstall(BUN, ["install"]);
verifyComplete();
rmSync(coldStore, { recursive: true, force: true });
rmSync(coldCache, { recursive: true, force: true });
out.trulyCold = { apps: fa, libs: fl, pnpmHoistedMs: tcPnpm.ms, bunMs: tcBun.ms };
persist();
console.log(
  `truly-cold (cleared caches, network) @ ${fa}/${fl}: pnpm-hoisted ${tcPnpm.ms}ms, bun ${tcBun.ms}ms`,
);
console.log("--- bench/install-bench.json written ---");

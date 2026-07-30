#!/usr/bin/env node
// The sliced-closure gate: the middle point between the fleet gate's two
// measured extremes for a universal-lib rev. One tsgo program checks the whole
// workspace in ~60s but leaves most of the box idle (this bench's own K=1
// reference: 755% CPU on 64 cores, 1,629% on 192 — and the 192-core box is
// SLOWER); the per-package pipeline uses every core
// but re-parses the shared libs ~30,000× (613s). A slice = one tsgo program
// over ALL lib source + 1/K of the apps: lib redundancy drops to K×, and K
// programs run concurrently — K × tsgo's internal parallelism.
//
//   node scripts/sliced-gate-bench.mjs fleet            # canonical 30000:460
//   SLICE_KS="2 4 8 16 32" node scripts/...             # the K sweep (default)
//
// Rows: a whole-program reference (clean timed + the breaking-rev error-location
// set), then per K: clean sliced run (wall = span from first spawn to last exit;
// per-slice CPU + RSS from GNU time, summed/maxed) and, at the best K, the
// breaking rev with the UNION CHECK — the distinct error locations across all
// slices must equal the whole-program set exactly (lib-side errors appear in
// every slice and must dedupe; app-side errors must neither vanish nor invent).
// Slices are filled round-robin by app index: fleet apps are uniform (31 files
// each), so equal counts give equal program sizes.
//
// Canonical (bench/sliced-gate-bench.json) at 30,000 apps with the default K
// set; else the gitignored partial. machine{cores,arch} recorded — the pbox
// companion (.pbox.json) is the same run fetched from the 192-core box.
//
// Destructive (regenerates the tree, overwrites the root package.json for a
// bun-installable workspace) — linked git worktree only; restores on exit.
// Core-bound: refuses on a loaded box unless SLICE_ALLOW_BUSY=1.

import { execSync, spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, availableParallelism, arch, loadavg } from "node:os";
import { benchOutput } from "./_pm-bench-lib.mjs";

const spec = (process.argv[2] || "fleet").trim();
const fleetM = spec.match(/^fleet(?::(\d+))?$/);
if (!fleetM) {
  console.error(`usage: sliced-gate-bench.mjs fleet[:<apps>]  (got "${spec}")`);
  process.exit(1);
}
const APPS = +(fleetM[1] || 30000);
const LIBS = 460;
const KS = (() => {
  const raw = (process.env.SLICE_KS || "2 4 8 16 32").trim().split(/\s+/);
  const ks = raw.map(Number);
  if (
    !ks.length ||
    ks.some((k) => !Number.isInteger(k) || k < 2) ||
    new Set(ks).size !== ks.length
  ) {
    console.error(
      `SLICE_KS must be unique integers >= 2, space-separated (got "${process.env.SLICE_KS}")`,
    );
    process.exit(1);
  }
  return ks;
})();
const ROOT = process.cwd();
const PKG = join(ROOT, "package.json");
// exact default order required: execution order affects thermal/contention history,
// so a reordered sweep is not the canonical measurement
const CANONICAL = APPS === 30000 && KS.join(" ") === "2 4 8 16 32";

const gitDir = execSync("git rev-parse --git-dir", { cwd: ROOT, encoding: "utf8" }).trim();
if (!gitDir.includes("worktrees")) {
  console.error("refusing to run outside a dedicated git worktree — destructive bench.");
  process.exit(1);
}
const CORES = availableParallelism();
const LOAD1 = loadavg()[0];
if (LOAD1 > CORES / 2 && process.env.SLICE_ALLOW_BUSY !== "1") {
  console.error(
    `load ${LOAD1.toFixed(1)} on ${CORES} cores — busy box; set SLICE_ALLOW_BUSY=1 to override.`,
  );
  process.exit(1);
}

const BUN = existsSync(join(homedir(), ".bun/bin/bun")) ? join(homedir(), ".bun/bin/bun") : "bun";
const env = { ...process.env };
// ambient Go runtime knobs would silently reshape the sweep on another box
for (const k of Object.keys(env)) if (/^GO(MAXPROCS|GC|MEMLIMIT|DEBUG)$/.test(k)) delete env[k];
env.NEXT_TELEMETRY_DISABLED = "1";
env.LC_ALL = "C"; // GNU time field names must parse
if (BUN.includes("/")) env.PATH = `${dirname(BUN)}:${process.env.PATH ?? ""}`;
const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...opts });
const fail = (msg) => {
  throw new Error(msg);
};

// ---- generate + install (the fleet-gate setup, no turbo needed) -------------
console.log(
  `# sliced-gate: ${APPS} apps / ${LIBS} libs, K sweep [${KS.join(" ")}], ${CORES} cores`,
);
const genOut = sh(
  `node scripts/generate.mjs --preset fleet${APPS !== 30000 ? ` --apps ${APPS}` : ""} --clean`,
  { encoding: "utf8" },
);
let gen;
try {
  gen = JSON.parse(genOut.trim().split("\n").pop());
} catch {
  fail(`could not parse generator summary:\n${genOut.slice(-300)}`);
}
const expected = {
  apps: APPS,
  libs: LIBS,
  preset: "fleet",
  shape: "skewed",
  modulesPerLib: 13,
  appModules: 28,
  universal: 5,
  popular: 10,
  tailPicks: 2,
  framework: "next",
  testTask: false,
  versioned: false,
  skew: 0,
};
for (const [k, v] of Object.entries(expected))
  if (gen[k] !== v) fail(`generated shape drifted (env override?): ${k}=${gen[k]}, expected ${v}`);
sh(`node scripts/rewrite-protocols.mjs --dir apps --catalog ${join(ROOT, "pnpm-workspace.yaml")}`);
sh(
  `node scripts/rewrite-protocols.mjs --dir packages --catalog ${join(ROOT, "pnpm-workspace.yaml")}`,
);

const origPkg = readFileSync(PKG, "utf8");
const toolchain = JSON.parse(origPkg).devDependencies;
const foundationFile = join(ROOT, "packages", "lib-001", "src", "index.ts");
let origFoundation = readFileSync(foundationFile, "utf8");
const liveChildren = new Set();
function killLiveChildren() {
  for (const pid of liveChildren) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
let sliceConfigs = [];
let restored = false;
function restoreAll() {
  if (restored) return;
  restored = true;
  killLiveChildren(); // every exit path, not only signals: a spawn failure mid-sweep must not orphan detached slices
  writeFileSync(PKG, origPkg);
  writeFileSync(foundationFile, origFoundation);
  for (const f of sliceConfigs) rmSync(f, { force: true });
  rmSync(join(ROOT, "tsconfig.whole.json"), { force: true });
  for (const f of ["pnpm-lock.yaml", "bun.lock", "bun.lockb"])
    rmSync(join(ROOT, f), { force: true });
}
process.on("exit", restoreAll);
process.on("SIGINT", () => {
  killLiveChildren();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killLiveChildren();
  process.exit(143);
});
process.on("SIGHUP", () => {
  killLiveChildren();
  process.exit(129);
});

const bunVer = execSync(`${BUN} --version`, { encoding: "utf8" }).trim();
writeFileSync(
  PKG,
  JSON.stringify(
    {
      name: "sliced-gate-bench",
      private: true,
      packageManager: `bun@${bunVer}`,
      workspaces: ["apps/*", "packages/*"],
      devDependencies: {
        typescript: toolchain.typescript,
        "@typescript/native-preview": toolchain["@typescript/native-preview"],
      },
    },
    null,
    2,
  ) + "\n",
);
console.log("## bun install (warm store)");
sh(`${BUN} install`, { encoding: "utf8" });
const TSGO = join(ROOT, "node_modules", ".bin", "tsgo");
if (!existsSync(TSGO)) fail("tsgo not installed");

// ---- tsconfig builders ------------------------------------------------------
const baseCompilerOptions = {
  module: "esnext",
  moduleResolution: "bundler",
  jsx: "preserve",
  noEmit: true,
  declaration: false,
  allowJs: true,
  paths: { "@demo/*": ["./packages/*/src/index.ts"] },
};
// exact per-app FILE lists: include-glob matching is O(patterns x files) in the
// checker, so 30k per-app globs would measure glob expansion, not type-checking
const writeCfg = (file, appDirsOrNull) => {
  const cfg = {
    extends: "./tsconfig.base.json",
    compilerOptions: baseCompilerOptions,
    include: ["packages/*/src/**/*.ts"],
    exclude: ["node_modules", "**/.next"],
  };
  if (appDirsOrNull === null) cfg.include.push("apps/*/**/*.ts", "apps/*/**/*.tsx");
  else cfg.files = appDirsOrNull.flatMap((d) => appFiles.get(d));
  writeFileSync(join(ROOT, file), JSON.stringify(cfg) + "\n");
};
const appDirs = execSync("ls apps", { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
if (appDirs.length !== APPS) fail(`expected ${APPS} app dirs, found ${appDirs.length}`);
console.log("## indexing app files (exact files lists for the slice configs)");
const appFiles = new Map();
{
  // one find over the whole apps tree, grouped by app dir — 30k execs would be slow.
  // Prune node_modules/.next: explicit `files` lists bypass tsconfig `exclude`, so the
  // prune is what keeps the slice programs' file universe equal to the reference's
  // include+exclude semantics.
  const all = execSync(
    `find apps \\( -name node_modules -o -name .next \\) -prune -o \\( -name '*.ts' -o -name '*.tsx' \\) -print`,
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    },
  )
    .trim()
    .split("\n");
  for (const f of all) {
    const d = f.split("/")[1];
    if (!appFiles.has(d)) appFiles.set(d, []);
    appFiles.get(d).push(f);
  }
  if (appFiles.size !== APPS) fail(`file index covers ${appFiles.size} apps, expected ${APPS}`);
}

// ---- runners ---------------------------------------------------------------
// one tsgo under GNU time; parses wall from OUR clock, CPU/RSS from time -v
function runProgram(cfg) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync("/usr/bin/time", ["-v", TSGO, "--noEmit", "-p", cfg], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.error) fail(`${cfg}: ${r.error.message}`);
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.signal || out.match(/Command terminated by signal/))
    fail(
      `${cfg}: checker killed by ${r.signal || "signal"} — OOM or external kill, not a measurement (check dmesg)`,
    );
  const rssKb = +(out.match(/Maximum resident set size \(kbytes\): (\d+)/) || [])[1] || null;
  const cpuPct = +(out.match(/Percent of CPU this job got:\s+(\d+)/) || [])[1] || null;
  return { ms, ok: r.status === 0, rssMB: rssKb ? Math.round(rssKb / 1024) : null, cpuPct, out };
}
// error LOCATIONS (file(line,col)) for the union check
const locations = (out) => new Set(out.match(/[^\s(]+\(\d+,\d+\): error TS\d+/g) || []);

// K slices concurrently (async spawn; wall = span; per-slice stats collected).
// Children are process-group leaders tracked in liveChildren so an interrupt
// kills every tsgo, not just node; stdout/stderr buffer separately (cross-
// stream interleaving could split a diagnostic line under a merged buffer).
function runSlices(cfgs) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const results = [];
    let doneCount = 0;
    cfgs.forEach((cfg, i) => {
      const child = spawn("/usr/bin/time", ["-v", TSGO, "--noEmit", "-p", cfg], {
        cwd: ROOT,
        env,
        detached: true,
      });
      liveChildren.add(child.pid);
      let so = "";
      let se = "";
      child.stdout.on("data", (d) => (so += d));
      child.stderr.on("data", (d) => (se += d));
      child.on("error", (e) => {
        liveChildren.delete(child.pid);
        reject(new Error(`slice ${cfg}: spawn failed: ${e.message}`));
      });
      child.on("close", (code, signal) => {
        liveChildren.delete(child.pid);
        const out = so + "\n" + se;
        const timeMarker = se.match(/Command terminated by signal\s+(\d+)/);
        const killed = signal != null || (code != null && code >= 128) || !!timeMarker;
        const rssKb = +(se.match(/Maximum resident set size \(kbytes\): (\d+)/) || [])[1] || null;
        const u = +(se.match(/User time \(seconds\): ([\d.]+)/) || [])[1];
        const sy = +(se.match(/System time \(seconds\): ([\d.]+)/) || [])[1];
        results[i] = {
          ok: code === 0,
          code,
          killed,
          rssMB: rssKb ? Math.round(rssKb / 1024) : null,
          cpuSec: Number.isFinite(u) && Number.isFinite(sy) ? u + sy : null,
          out,
        };
        if (++doneCount === cfgs.length)
          resolve({
            wallMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
            slices: results,
          });
      });
    });
  });
}

const OUT = benchOutput(
  ROOT,
  "bench/sliced-gate-bench.partial.json",
  "bench/sliced-gate-bench.json",
);
const result = {
  apps: APPS,
  libs: LIBS,
  shape: "fleet",
  machine: { cores: CORES, arch: arch() },
  preRunLoadAvg1: +LOAD1.toFixed(2),
  versions: {
    tsgo: toolchain["@typescript/native-preview"],
    bun: bunVer,
    node: process.version,
  },
  ks: {},
};

// ---- whole-program reference ------------------------------------------------
console.log("## reference: one program (clean, then breaking for the location set)");
writeCfg("tsconfig.whole.json", null);
writeFileSync(foundationFile, origFoundation + "\nexport const _rev = 1;\n");
runProgram("tsconfig.whole.json"); // warmup, untimed
const wholeClean = runProgram("tsconfig.whole.json");
if (!wholeClean.ok) fail(`whole-program clean must be green:\n${wholeClean.out.slice(-400)}`);
result.whole = { cleanMs: wholeClean.ms, rssMB: wholeClean.rssMB, cpuPct: wholeClean.cpuPct };
console.log(`  clean ${wholeClean.ms}ms · ${wholeClean.rssMB}MB · ${wholeClean.cpuPct}% CPU`);
const sig = "lib001Main(seed: number)";
writeFileSync(
  foundationFile,
  origFoundation.replace(sig, "lib001Main(seed: number, scale: number)"),
);
const brokenSrc = origFoundation.replace(sig, "lib001Main(seed: number, scale: number)");
if (brokenSrc === origFoundation) fail(`foundation signature "${sig}" not found`);
const wholeBreak = runProgram("tsconfig.whole.json");
if (wholeBreak.ok) fail("whole-program breaking run stayed green");
const refLocs = locations(wholeBreak.out);
const refApps = new Set([...refLocs].map((l) => /apps\/(app-\d+)\//.exec(l)?.[1]).filter(Boolean));
if (refApps.size !== APPS)
  fail(`breaking reference red in ${refApps.size}/${APPS} apps — blast radius not universal`);
if (!/error TS2554/.test(wholeBreak.out)) fail("breaking reference carries no TS2554");
result.whole.breakingMs = wholeBreak.ms;
result.whole.breakingLocations = refLocs.size;
console.log(`  breaking ${wholeBreak.ms}ms · ${refLocs.size} distinct error locations`);
OUT.persist(result);
writeFileSync(foundationFile, origFoundation + "\nexport const _rev = 1;\n"); // back to clean

// ---- the K sweep (clean) ----------------------------------------------------
for (const K of KS) {
  const cfgs = [];
  for (let k = 0; k < K; k++) {
    const mine = appDirs.filter((_, i) => i % K === k);
    const f = `tsconfig.slice-${K}-${k}.json`;
    writeCfg(f, mine);
    cfgs.push(f);
    sliceConfigs.push(join(ROOT, f));
  }
  const r = await runSlices(cfgs);
  const killed = r.slices.filter((s) => s.killed);
  if (killed.length)
    fail(
      `K=${K}: ${killed.length} slices killed — OOM or external kill, not a measurement (check dmesg)`,
    );
  const bad = r.slices.filter((s) => !s.ok);
  if (bad.length)
    fail(`K=${K}: ${bad.length} slices not green on the clean tree:\n${bad[0].out.slice(-300)}`);
  const unparsed = r.slices.filter((s) => s.cpuSec == null || s.rssMB == null);
  if (unparsed.length)
    fail(`K=${K}: GNU-time CPU/RSS parse incomplete on ${unparsed.length} slices`);
  result.ks[K] = {
    wallMs: r.wallMs,
    totalCpuSec: Math.round(r.slices.reduce((a, s) => a + s.cpuSec, 0)),
    maxSliceRssMB: Math.max(...r.slices.map((s) => s.rssMB ?? 0)) || null,
    sumRssMB: r.slices.reduce((a, s) => a + (s.rssMB ?? 0), 0) || null,
  };
  console.log(
    `## K=${K}: wall ${r.wallMs}ms · ΣCPU ${result.ks[K].totalCpuSec}s · max slice RSS ${result.ks[K].maxSliceRssMB}MB · ΣRSS ${result.ks[K].sumRssMB}MB`,
  );
  OUT.persist(result);
}

// ---- union check at the best K ---------------------------------------------
const bestK = KS.reduce((a, b) => (result.ks[b].wallMs < result.ks[a].wallMs ? b : a));
console.log(`## union check at best K=${bestK} (breaking rev)`);
writeFileSync(
  foundationFile,
  origFoundation.replace(sig, "lib001Main(seed: number, scale: number)"),
);
const cfgs = Array.from({ length: bestK }, (_, k) => `tsconfig.slice-${bestK}-${k}.json`);
const rb = await runSlices(cfgs);
if (rb.slices.some((s) => s.killed))
  fail("a slice was killed on the breaking rev — OOM or external kill, not a measurement");
if (rb.slices.some((s) => s.ok)) fail("a slice stayed green on the breaking rev");
const union = new Set();
for (const s of rb.slices) for (const l of locations(s.out)) union.add(l);
const unionApps = new Set([...union].map((l) => /apps\/(app-\d+)\//.exec(l)?.[1]).filter(Boolean));
if (unionApps.size !== APPS) fail(`union covers ${unionApps.size}/${APPS} apps`);
writeFileSync(foundationFile, origFoundation);
const missing = [...refLocs].filter((l) => !union.has(l)).length;
const invented = [...union].filter((l) => !refLocs.has(l)).length;
if (missing || invented)
  fail(
    `union mismatch vs whole-program: ${missing} missing, ${invented} invented (of ${refLocs.size})`,
  );
result.unionCheck = {
  k: bestK,
  wallMs: rb.wallMs,
  locations: union.size,
  matchesWholeProgram: true,
};
console.log(
  `  union ${union.size} locations === whole-program set ✓ · breaking wall ${rb.wallMs}ms`,
);

result.summary = {
  wholeCleanMs: result.whole.cleanMs,
  bestK,
  bestKWallMs: result.ks[bestK].wallMs,
  speedupVsWhole: +(result.whole.cleanMs / result.ks[bestK].wallMs).toFixed(2),
  breakingSlicedMs: result.unionCheck.wallMs,
};
mkdirSync(join(ROOT, "bench"), { recursive: true });
if (CANONICAL) OUT.promote(result);
else OUT.persist(result);
console.log(
  `\n--- ${CANONICAL ? "bench/sliced-gate-bench.json" : "bench/sliced-gate-bench.partial.json"} written ---`,
);

#!/usr/bin/env node
// test-axis-bench: the missing TEST-execution axis. The repo measures install / graph-load /
// typecheck / build / lint / prune / focus, but never the `test` task. This adds it, measuring the
// same O(repo)-vs-O(closure) shape the repo's thesis is built on: whole-repo `turbo run test` (every
// package's test task) vs a focused `--filter=<app>...` (one app + its dependency closure), cold then
// warm, per scale; the edit-location blast radius (how many test tasks a universal-foundation edit
// selects vs a leaf edit); and the structural sharding benefit.
//
// What it measures, precisely: the `test` task has NO task dependencies (turbo.json), so `turbo run
// test` isolates test-task SELECTION + per-task orchestration/runner cost from the build axis. The
// per-package body is a trivial node:test smoke test (generate.mjs --test-task), so the wall-clock is
// Turbo orchestration + `node --test` startup per selected package, NOT real test logic. The finding
// is therefore the AXIS SHAPE — how the selected-test-task COUNT and that overhead scale with package
// count (O(repo)) and shrink under `--filter` (O(closure)) — not an absolute test-suite runtime. The
// structural task COUNTS (from --dry=json) are the primary evidence; the timings are the secondary,
// overhead-bound, signal and are labeled as such.
//
//   node scripts/test-axis-bench.mjs                 # default scales (300:100 1000:200)
//   TEST_AXIS_SCALES="300:100 1000:200 2000:300" ... # override the scale matrix
//   BLAST_SCALE=1000:200 ...                         # scale for the edit-blast-radius rung
//   GATE_SAMPLES=3   TEST_AXIS_ALLOW_BUSY=1          # samples per timing / bypass the load guard
//
// Discipline (the repo's measurement rules): cold is actually cold (clear .turbo + the pinned
// TURBO_CACHE_DIR + node_modules/.cache/turbo, and stop any ambient turbo daemon, before each cold
// sample); source is made visible to Turbo's hashing (enterSourceVisible, restored in finally); cold
// asserts 0 cached and warm asserts all cached; the O(closure) contrasts are STRUCTURALLY asserted
// (focus < whole; the universal foundation selects every package; a leaf selects fewer) so a degenerate
// run cannot read as a clean measurement; true median over GATE_SAMPLES; any failed step throws. The
// timings are core-bound (--concurrency=100%), so the bench records cores/load and refuses on a loaded
// box unless TEST_AXIS_ALLOW_BUSY=1.
//
// Self-contained to this worktree: regenerates the tree per scale (generate --clean), pins
// TURBO_CACHE_DIR to this worktree, writes bench/test-axis-bench.json. Run in a linked git worktree
// (it regenerates the gitignored apps/packages tree). NOT destructive to tracked files.

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { enterSourceVisible } from "./_source-visible.mjs";

const ROOT = process.cwd();

function fail(m) {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
}
// strict positive-integer env (NaN/junk/negative would silently run 0 samples -> NaN median)
function intEnv(name, def, min) {
  const raw = process.env[name] ?? String(def);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) fail(`${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
}
function parseScale(s) {
  const m = /^(\d+):(\d+)$/.exec(s.trim());
  if (!m) fail(`bad scale "${s}" (want apps:libs, e.g. 1000:200)`);
  const apps = Number(m[1]);
  const libs = Number(m[2]);
  if (apps < 1 || libs < 2) fail(`bad scale "${s}" (need apps>=1, libs>=2)`);
  return { label: `${apps}:${libs}`, apps, libs };
}

const SAMPLES = intEnv("GATE_SAMPLES", 3, 1);
const CONC = process.env.TEST_AXIS_CONC || "100%";
const SCALES = (process.env.TEST_AXIS_SCALES || "300:100 1000:200")
  .trim()
  .split(/\s+/)
  .map(parseScale);
const BLAST = parseScale(process.env.BLAST_SCALE || "1000:200");

// core-bound: timings are only meaningful on an unloaded box (the repo convention for wall-clock benches)
const CORES = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const LOAD1 = +os.loadavg()[0].toFixed(2);
if (LOAD1 > CORES / 2 && process.env.TEST_AXIS_ALLOW_BUSY !== "1")
  fail(
    `1-min load ${LOAD1} > ${CORES / 2} (half of ${CORES} cores); timings would be unreliable. Set TEST_AXIS_ALLOW_BUSY=1 to override.`,
  );

// Pin Turbo's cache to THIS worktree. Turbo otherwise writes to the PRIMARY worktree's .turbo, so a
// worktree-local clear would not clear it and "cold" runs would be stale hits (the central lesson).
const CACHE_DIR = join(ROOT, ".turbo", "cache");
const ENV = { ...process.env, TURBO_CACHE_DIR: CACHE_DIR };

function sh(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeout || 1800000,
    maxBuffer: 256 * 1024 * 1024,
    env: ENV,
  });
}
function timed(cmd, opts = {}) {
  const t0 = process.hrtime.bigint();
  const out = sh(cmd, opts);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, out };
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Parse `turbo run ... --dry=json` into structural counts. Throws with the offending output on bad JSON.
function dryCounts(filterArgs) {
  const out = sh(`pnpm exec turbo run test ${filterArgs} --dry=json`);
  let j;
  try {
    j = JSON.parse(out);
  } catch (e) {
    fail(`could not parse --dry=json for \`test ${filterArgs}\`: ${e.message}\n${out.slice(-500)}`);
  }
  const tasks = j.tasks || [];
  const testTasks = tasks.filter((t) => t.task === "test").length;
  if (testTasks === 0)
    fail(`\`test ${filterArgs}\` selected 0 test tasks — filter matched nothing`);
  return { testTasks, totalTasks: tasks.length };
}
// Parse the "Cached: X cached, Y total" summary line from a real turbo run.
function cacheLine(out) {
  const m = out.match(/Cached:\s+(\d+)\s+cached,\s+(\d+)\s+total/);
  if (!m) fail(`could not parse turbo cache summary from:\n${out.slice(-500)}`);
  return { cached: Number(m[1]), total: Number(m[2]) };
}

function stopDaemon() {
  // remove any AMBIENT turbo daemon so a stale in-memory hash cache cannot make a "cold" sample warm
  try {
    sh("pnpm exec turbo daemon stop");
  } catch {
    /* none running */
  }
}
function clearCache() {
  rmSync(CACHE_DIR, { recursive: true, force: true });
  rmSync(join(ROOT, ".turbo"), { recursive: true, force: true });
  rmSync(join(ROOT, "node_modules", ".cache", "turbo"), { recursive: true, force: true });
}
// A --dry=json pass before the timed cold run: it validates the task graph builds (catches a bad
// filter/config before we time anything) and warms the OS page cache for the source files, so the
// timed cold run is not skewed by first-touch fs latency. (It does NOT start the turbo daemon — turbo
// 2.x neither auto-spawns one for `run` nor for `--dry`, verified — so the cold run is per-process.)
function graphPrime(filterArgs) {
  try {
    sh(`pnpm exec turbo run test ${filterArgs} --dry=json`);
    return true;
  } catch (e) {
    return `graph build failed: ${String(e.message).split("\n")[0]}`;
  }
}

// One cold+warm pair for a filter: per cold sample, stop the daemon + clear every cache + prime the
// graph, run cold (assert 0 cached); then run warm samples on the populated cache (assert all cached).
function coldWarm(label, filterArgs) {
  const run = `pnpm exec turbo run test ${filterArgs} --cache=local:rw --concurrency=${CONC} --output-logs=errors-only`;
  const counts = dryCounts(filterArgs);
  const coldMs = [];
  let coldCache = null;
  for (let s = 0; s < SAMPLES; s++) {
    stopDaemon();
    clearCache();
    const primed = graphPrime(filterArgs);
    if (primed !== true) fail(`${label}: ${primed}`);
    const r = timed(run);
    const c = cacheLine(r.out);
    if (c.cached !== 0)
      fail(`${label} cold sample ${s}: expected 0 cached, got ${c.cached}/${c.total}`);
    coldMs.push(r.ms);
    coldCache = c;
  }
  const warmMs = [];
  let warmCache = null;
  for (let s = 0; s < SAMPLES; s++) {
    const r = timed(run);
    const c = cacheLine(r.out);
    if (c.cached !== c.total)
      fail(`${label} warm sample ${s}: expected all cached, got ${c.cached}/${c.total}`);
    warmMs.push(r.ms);
    warmCache = c;
  }
  return {
    testTasks: counts.testTasks,
    totalTasks: counts.totalTasks,
    coldMs: Math.round(median(coldMs)),
    warmMs: Math.round(median(warmMs)),
    coldSamples: coldMs.map((x) => Math.round(x)),
    warmSamples: warmMs.map((x) => Math.round(x)),
    coldCached: coldCache,
    warmCached: warmCache,
  };
}

function regen(apps, libs, universal = 0) {
  const uni = universal > 0 ? ` --universal ${universal}` : "";
  sh(
    `node scripts/generate.mjs --apps ${apps} --libs ${libs} --modules 8 --test-task --clean${uni}`,
  );
  const ins = sh(`pnpm install --no-frozen-lockfile`, { timeout: 1800000 }); // execSync throws on non-zero
  return ins;
}

const pad = (n, w) => String(n).padStart(w, "0");
const appName = (i, apps) => `@demo/app-${pad(i, String(apps).length)}`;
const libName = (i, libs) => `@demo/lib-${pad(i, String(libs).length)}`;

console.log(
  `test-axis-bench: scales [${SCALES.map((s) => s.label).join(", ")}], blast ${BLAST.label}, ${SAMPLES} samples, ${CORES} cores, load ${LOAD1}\n`,
);

const restore = enterSourceVisible(ROOT); // make generated source visible to Turbo's input hashing

const result = {
  about:
    "the TEST-execution axis: whole-repo `turbo run test` (O(repo)) vs a focused `--filter=<app>...` (O(closure)), cold then warm, per scale, plus the edit-location blast radius and the structural sharding benefit. The `test` task has no task deps, so this isolates test-task selection + per-task runner cost from the build axis; the per-package body is a trivial node:test smoke test, so the wall-clock is Turbo orchestration + `node --test` startup per selected package, not real test logic. The structural test-task COUNTS are the primary evidence (the axis shape); cold/warm ms are the secondary, overhead-bound signal. Cold asserts 0 cached, warm asserts all cached, and the O(closure) contrasts are structurally asserted (focus < whole; universal foundation selects every package; leaf < foundation).",
  env: { cores: CORES, preRunLoadAvg1: LOAD1, coreBound: true },
  versions: {
    node: process.version,
    turbo: (() => {
      try {
        return sh("pnpm exec turbo --version").trim();
      } catch {
        return "unknown";
      }
    })(),
  },
  samples: SAMPLES,
  concurrency: CONC,
  scales: [],
  blastRadius: null,
  sharding: null,
  notes: [
    "cold/warm ms are Turbo-orchestration + `node --test` startup bound (trivial smoke body), not real test runtime; the test-task COUNT and its scaling is the finding.",
    "flaky-retry is out of scope: retry is a test-runner feature (node --test has none by default), not a property of Turbo's test-task axis.",
    "a real `test` that imported built deps would add a `^build` edge and the build cost (the build axis, measured separately); this bench deliberately decouples them to isolate the test axis.",
  ],
};

try {
  // ---- contrast 1: O(repo) whole-repo test vs O(closure) focus, cold+warm, per scale -------------
  for (const { label, apps, libs } of SCALES) {
    console.log(`== scale ${label} ==`);
    regen(apps, libs);
    const whole = coldWarm(`${label} whole`, "");
    const mid = appName(Math.ceil(apps / 2), apps);
    const focus = coldWarm(`${label} focus`, `--filter='${mid}...'`);
    // structural closure sizes for first/mid/last app, so the O(closure) side is not one arbitrary app
    const focusClosures = [1, Math.ceil(apps / 2), apps].map((i) => {
      const name = appName(i, apps);
      return { app: name, testTasks: dryCounts(`--filter='${name}...'`).testTasks };
    });
    // ASSERT the O(closure) win is real (mirrors optimal-gate-bench's "O(closure) contrast invalid" guard)
    if (!(focus.testTasks < whole.testTasks))
      fail(
        `${label}: focus selected ${focus.testTasks} test tasks but whole selected ${whole.testTasks} — O(closure) contrast invalid`,
      );
    console.log(
      `  whole: ${whole.testTasks} test tasks cold ${whole.coldMs}ms / warm ${whole.warmMs}ms`,
    );
    console.log(
      `  focus(${mid}...): ${focus.testTasks} test tasks cold ${focus.coldMs}ms / warm ${focus.warmMs}ms; closures ${focusClosures.map((c) => c.testTasks).join("/")}`,
    );
    result.scales.push({ label, apps, libs, whole, focus, focusClosures });
  }

  // ---- contrast 2: edit-location blast radius — universal foundation vs leaf (with a mid-layer point)
  // turbo --affected diffs git, but the generated tree is gitignored; `--filter=...<lib>` selects exactly
  // the packages an edit to <lib> would affect (the dependents), which is the same set, git-free. Under
  // --universal 1 the foundation lib is a pure sink every package imports, so editing it selects EVERY
  // package's test (O(repo)); a leaf (highest layer) selects only its few dependents (O(closure)).
  {
    const { apps, libs, label } = BLAST;
    console.log(`== blast radius @ ${label} (--universal 1) ==`);
    regen(apps, libs, 1);
    const foundation = libName(1, libs); // the universal sink — every package depends on it
    const mid = libName(Math.ceil(libs / 2), libs);
    const leaf = libName(libs, libs); // highest index/layer — fewest dependents
    const midCount = dryCounts(`--filter='...${mid}'`).testTasks; // structural only
    const found = coldWarm(`blast foundation`, `--filter='...${foundation}'`);
    const leafCW = coldWarm(`blast leaf`, `--filter='...${leaf}'`);
    // ASSERT the foundation is truly universal (every package) and the leaf is strictly smaller
    if (found.testTasks !== apps + libs)
      fail(
        `blast: universal foundation selected ${found.testTasks} test tasks, expected every package (${apps + libs}) — --universal did not take effect`,
      );
    if (!(leafCW.testTasks < found.testTasks))
      fail(
        `blast: leaf selected ${leafCW.testTasks} test tasks, not fewer than foundation ${found.testTasks} — blast contrast invalid`,
      );
    console.log(
      `  foundation ${foundation}: ${found.testTasks} test tasks (O(repo)) cold ${found.coldMs}ms | mid ${mid}: ${midCount} | leaf ${leaf}: ${leafCW.testTasks} (O(closure)) cold ${leafCW.coldMs}ms`,
    );
    result.blastRadius = {
      scale: label,
      apps,
      libs,
      foundation: { lib: foundation, testTasks: found.testTasks, coldMs: found.coldMs },
      mid: { lib: mid, testTasks: midCount },
      leaf: { lib: leaf, testTasks: leafCW.testTasks, coldMs: leafCW.coldMs },
      note: "editing the universal foundation selects every package's test (O(repo)); a mid-layer lib fewer; a leaf only its dependents (O(closure)). `--filter=...<lib>` is the git-free equivalent of `--affected` after editing <lib>.",
    };
  }

  // ---- contrast 3: structural sharding benefit ---------------------------------------------------
  // The `test` task has no task deps, so whole-repo test tasks are independent and embarrassingly
  // parallel ACROSS machines: splitting them into N shards puts ceil(total/N) test tasks on each, so
  // wall time falls ~linearly with N. This is the O(repo) mitigation (more machines), distinct from
  // --filter (which shrinks the task SET). Reported as the arithmetic per-shard COUNT (not a measured
  // wall-time) from the LARGEST measured whole-repo test-task count.
  {
    const biggest = result.scales.reduce((a, b) => (b.whole.testTasks > a.whole.testTasks ? b : a));
    const totalTestTasks = biggest.whole.testTasks;
    result.sharding = {
      scale: biggest.label,
      totalTestTasks,
      shards: [2, 4, 8].map((n) => ({
        shards: n,
        perShardTestTasks: Math.ceil(totalTestTasks / n),
      })),
      note: "ARITHMETIC, not a measured wall-time: per-shard test-task count = ceil(total / N). The test task has no deps, so whole-repo test tasks are independent and shard with ~linear speedup across machines — the O(repo) mitigation, distinct from --filter which shrinks the task set itself.",
    };
  }
} finally {
  restore();
}

mkdirSync(join(ROOT, "bench"), { recursive: true });
writeFileSync(join(ROOT, "bench", "test-axis-bench.json"), JSON.stringify(result, null, 2) + "\n");
console.log(`\n--- bench/test-axis-bench.json written ---`);

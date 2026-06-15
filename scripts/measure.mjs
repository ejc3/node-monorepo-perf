#!/usr/bin/env node
// Benchmark harness. Runs selected phases against the CURRENT workspace and
// appends a timed record to bench/results.json.
//
//   node scripts/measure.mjs --label 10k --apps 10000 --libs 300 \
//       --phases gen,install,graph,typecheck,focus,prune --fs-stats
//
// Phases:
//   gen        regenerate the workspace (clean) at --apps/--libs/--modules
//   install    pnpm install (cold or warm depending on store/lockfile state)
//   graph      turbo task-graph size + focused-closure size for a sample app
//   typecheck  turbo run typecheck: warm up the daemon/graph (no tasks run),
//              then cold (cache cleared) then warm (cache hit)
//   focus      turbo run build --filter=<one app>...  (task-time focus)
//   prune      turbo prune <one app> --docker  (artifact-time focus)
//
// FS stats (node_modules entry count, symlink count, sizes, lockfile size) are
// gathered after install when --fs-stats is passed (can be slow at 10k).

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  return d;
};

const LABEL = opt("label", "run");
const APPS = parseInt(opt("apps", "50"), 10);
const LIBS = parseInt(opt("libs", "50"), 10);
const MODULES = opt("modules", "16");
const PHASES = opt("phases", "gen,install,graph,typecheck,focus,prune").split(",");
const CONC = opt("concurrency", "100%"); // use all cores by default (turbo defaults to 10)
const FRAMEWORK = opt("framework", "next"); // forwarded to generate.mjs
const VERSIONED = flag("versioned"); // forwarded to generate.mjs
const FS_STATS = flag("fs-stats");
const ROOT = process.cwd();

const appW = String(APPS).length;
const sampleApp = `@demo/app-${String(Math.max(1, Math.floor(APPS / 2))).padStart(appW, "0")}`;

const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  FORCE_COLOR: "0",
};

function timed(label, fn) {
  const t0 = process.hrtime.bigint();
  let ok = true;
  let out;
  try {
    out = fn();
  } catch (e) {
    ok = false;
    out = e;
  }
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  console.log(`[${LABEL}] ${label}: ${ms} ms${ok ? "" : " (FAILED)"}`);
  return { ms, ok, out };
}

function sh(cmd, capture = false) {
  return execSync(cmd, {
    cwd: ROOT,
    env,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 1 << 30,
  });
}
function shOut(cmd) {
  return execSync(cmd, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 30,
  }).toString();
}
function tryShOut(cmd) {
  try {
    return shOut(cmd);
  } catch (e) {
    return (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
  }
}

const rec = {
  label: LABEL,
  apps: APPS,
  libs: LIBS,
  modules: Number(MODULES),
  framework: FRAMEWORK,
  versioned: VERSIONED,
  phases: {},
};

// ---- gen ----
if (PHASES.includes("gen")) {
  const r = timed("gen", () =>
    shOut(
      `node scripts/generate.mjs --apps ${APPS} --libs ${LIBS} --modules ${MODULES} --framework ${FRAMEWORK} ${VERSIONED ? "--versioned" : ""} --clean`,
    ),
  );
  rec.phases.gen = { ms: r.ms };
  try {
    const j = JSON.parse(String(r.out).trim().split("\n").pop());
    rec.phases.gen.approxFiles = j.approxFiles;
    rec.phases.gen.generateMs = j.generateMs;
  } catch (e) {
    console.warn(
      `[${LABEL}] gen: failed to parse generator JSON output (approxFiles/generateMs dropped): ${e.message}`,
    );
  }
}

// ---- install ----
if (PHASES.includes("install")) {
  // clean install so each scale is measured independently (no carry-over from a
  // prior scale). Remove the WHOLE node_modules tree (root + per-package) — a
  // stale apps/*/node_modules lets pnpm time a partial no-op. Global store stays warm.
  // cleanup must succeed — a stale tree would let pnpm time a no-op (don't swallow)
  execSync(`find . -name node_modules -type d -prune -exec rm -rf {} +`, { cwd: ROOT });
  rmSync(join(ROOT, "pnpm-lock.yaml"), { force: true });
  const r = timed("install", () => sh("pnpm install"));
  rec.phases.install = { ms: r.ms, ok: r.ok };
  // lockfile size — only from a SUCCESSFUL install (a failed/partial install must
  // not become a clean lockfile-size datapoint).
  if (r.ok && existsSync(join(ROOT, "pnpm-lock.yaml"))) {
    const buf = readFileSync(join(ROOT, "pnpm-lock.yaml"));
    rec.phases.install.lockfileBytes = buf.length;
    rec.phases.install.lockfileLines = buf.toString().split("\n").length;
  }
  if (r.ok && FS_STATS) {
    timed("fs-stats", () => {
      rec.phases.install.nmEntries = parseInt(
        tryShOut(`find . -path '*/node_modules/*' -printf '.' 2>/dev/null | wc -c`).trim() || "0",
        10,
      );
      rec.phases.install.nmSymlinks = parseInt(
        tryShOut(
          `find . -path '*/node_modules/*' -type l -printf '.' 2>/dev/null | wc -c`,
        ).trim() || "0",
        10,
      );
      rec.phases.install.nmApparentBytes = parseInt(
        tryShOut(`du -sb --apparent-size node_modules 2>/dev/null | cut -f1`).trim() || "0",
        10,
      );
      rec.phases.install.nmDiskBytes = parseInt(
        tryShOut(`du -sb node_modules 2>/dev/null | cut -f1`).trim() || "0",
        10,
      );
    });
  }
}

// ---- graph ----
if (PHASES.includes("graph")) {
  // Run the dry-run graph queries with shOut so a non-zero turbo exit THROWS
  // (instead of tryShOut returning combined stdout+stderr text that JSON.parse
  // would choke on). The throw is captured by timed() as ok=false, letting us
  // record the failure rather than silently leaving rec.phases.graph undefined.
  const r = timed("graph", () => {
    const all = JSON.parse(shOut(`pnpm exec turbo run build --dry=json`));
    const focus = JSON.parse(
      shOut(`pnpm exec turbo run build --filter=${sampleApp}... --dry=json`),
    );
    return { all, focus };
  });
  if (r.ok) {
    const { all, focus } = r.out;
    rec.phases.graph = {
      totalBuildTasks: all.tasks ? all.tasks.length : (all.packages?.length ?? 0),
    };
    rec.phases.graph.focusTasks = focus.tasks?.length;
    rec.phases.graph.focusPackages = focus.packages?.length;
    rec.phases.graph.sampleApp = sampleApp;
  } else {
    const error = r.out?.message ? String(r.out.message).split("\n")[0] : String(r.out);
    rec.phases.graph = { ok: false, error };
    console.warn(`[${LABEL}] graph: failed to build task graph: ${error}`);
  }
}

// ---- typecheck (cold then warm) ----
if (PHASES.includes("typecheck")) {
  rmSync(join(ROOT, "node_modules", ".cache", "turbo"), { recursive: true, force: true });
  tryShOut(`pnpm exec turbo daemon clean 2>/dev/null`);
  rmSync(join(ROOT, ".turbo"), { recursive: true, force: true });
  // Daemon + graph warmup that EXECUTES NOTHING: --dry=json builds the task
  // graph and spins up the daemon but runs no tasks, so the cache stays empty.
  // Without this, the cold run would pay daemon spin-up while the warm run does
  // not, inflating the cold/warm delta beyond the actual cache effect. After
  // this, both runs hit an already-warm daemon and the delta is the cache effect.
  // Surface a warmup failure instead of swallowing it — if this fails, the cold
  // run silently pays daemon spin-up (the confound this step claims to remove),
  // so record warmupOk so a confounded cold number is never presented as clean.
  let warmupOk = true;
  try {
    shOut(`pnpm exec turbo run typecheck --dry=json`);
  } catch (e) {
    warmupOk = false;
    console.warn(
      `[${LABEL}] typecheck: daemon/graph warmup failed; cold number may include daemon spin-up: ${String(e.message).split("\n")[0]}`,
    );
  }
  const cold = timed("typecheck:cold", () =>
    sh(
      `pnpm exec turbo run typecheck --cache=local:rw --concurrency=${CONC} --output-logs=errors-only`,
    ),
  );
  const warm = timed("typecheck:warm", () =>
    sh(`pnpm exec turbo run typecheck --concurrency=${CONC} --output-logs=errors-only`),
  );
  rec.phases.typecheck = {
    coldMs: cold.ms,
    warmMs: warm.ms,
    coldOk: cold.ok,
    warmOk: warm.ok,
    warmupOk,
  };
}

// ---- focus build (one app + its lib closure) ----
if (PHASES.includes("focus")) {
  rmSync(join(ROOT, ".turbo"), { recursive: true, force: true });
  const r = timed(`focus build ${sampleApp}...`, () =>
    sh(
      `pnpm exec turbo run build --filter=${sampleApp}... --concurrency=${CONC} --output-logs=errors-only`,
    ),
  );
  rec.phases.focus = { ms: r.ms, ok: r.ok, app: sampleApp };
}

// ---- prune (artifact-time focus) ----
if (PHASES.includes("prune")) {
  rmSync(join(ROOT, "out"), { recursive: true, force: true });
  const r = timed(`prune ${sampleApp}`, () =>
    sh(`pnpm exec turbo prune ${sampleApp} --docker --use-gitignore=false`),
  );
  rec.phases.prune = { ms: r.ms, ok: r.ok, app: sampleApp };
  if (existsSync(join(ROOT, "out"))) {
    rec.phases.prune.outApparentBytes = parseInt(
      tryShOut(`du -sb --apparent-size out 2>/dev/null | cut -f1`).trim() || "0",
      10,
    );
    rec.phases.prune.outPackages = parseInt(
      tryShOut(`find out/json -name package.json 2>/dev/null | wc -l`).trim() || "0",
      10,
    );
    rec.phases.prune.outFiles = parseInt(
      tryShOut(`find out/full -type f 2>/dev/null | wc -l`).trim() || "0",
      10,
    );
  }
}

// ---- persist ----
const benchDir = join(ROOT, "bench");
mkdirSync(benchDir, { recursive: true });
const resultsPath = join(benchDir, "results.json");
let results = [];
if (existsSync(resultsPath)) {
  try {
    results = JSON.parse(readFileSync(resultsPath, "utf8"));
  } catch {}
}
results.push(rec);
writeFileSync(resultsPath, JSON.stringify(results, null, 2));
console.log(`[${LABEL}] recorded → bench/results.json`);
console.log(JSON.stringify(rec));

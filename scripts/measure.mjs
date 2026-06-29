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
import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { enterSourceVisible } from "./_source-visible.mjs";

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
  // Pin Turbo's cache inside THIS working tree. In a git worktree Turbo otherwise
  // resolves the cache to the primary worktree, so `rm -rf .turbo` here wouldn't
  // clear it and "cold" runs would be stale cache hits.
  TURBO_CACHE_DIR: join(ROOT, ".turbo", "cache"),
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

// strict shell stat: pipefail so a failed find/du surfaces; reject non-numeric.
function statInt(script) {
  const s = spawnSync("bash", ["-c", `set -o pipefail; ${script}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (s.error || s.status !== 0) {
    throw new Error(`stat failed: ${s.error?.message || s.stderr || `status ${s.status}`}`);
  }
  const v = parseInt((s.stdout || "").trim(), 10);
  if (!Number.isFinite(v)) throw new Error(`stat non-numeric from: ${script}`);
  return v;
}

// Resolve `dep` from `dir` by walking node_modules upward, STOPPING at ROOT — an
// ambient parent node_modules must not satisfy verification for a partial install.
function resolvesFrom(dir, dep) {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, "node_modules", dep, "package.json"))) return true;
    if (d === ROOT) return false;
    const u = dirname(d);
    if (u === d) return false;
    d = u;
  }
}
// Post-install completeness check (mirrors install-bench's verifyComplete): every
// package under apps/* and packages/* must resolve all its declared dependencies
// AND devDependencies. Returns an error string on a miss, or null when complete.
// A pnpm install can exit 0 yet be partial, so this keeps a silently-incomplete
// install from recording a clean ms/lockfile-size datapoint.
function verifyInstallComplete() {
  const missing = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, name);
      if (!existsSync(join(pkgDir, "package.json"))) continue;
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      const deps = [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ];
      for (const dep of deps) {
        if (!resolvesFrom(pkgDir, dep) && missing.length < 20) missing.push(`${pkgDir} -> ${dep}`);
      }
    }
  }
  if (missing.length) {
    return `INCOMPLETE install, unresolved deps:\n${missing.slice(0, 10).join("\n")}`;
  }
  return null;
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
// Prerequisite gate: a failed gen or install means later phases would measure a
// stale/broken workspace, so they are skipped (rendered "—") rather than timed.
let abort = false;

// Turbo respects .gitignore for input hashing, and this repo gitignores the
// GENERATED apps/+packages/. A real monorepo tracks its source, so make it
// visible to Turbo (build outputs stay ignored) — otherwise warm-cache and
// graph-load numbers understate the real per-file hashing cost. Restored on exit.
enterSourceVisible(ROOT);

// ---- gen ----
if (PHASES.includes("gen")) {
  const r = timed("gen", () =>
    shOut(
      `node scripts/generate.mjs --apps ${APPS} --libs ${LIBS} --modules ${MODULES} --framework ${FRAMEWORK} ${VERSIONED ? "--versioned" : ""} --clean`,
    ),
  );
  rec.phases.gen = { ms: r.ms, ok: r.ok };
  if (r.ok) {
    try {
      const j = JSON.parse(String(r.out).trim().split("\n").pop());
      rec.phases.gen.approxFiles = j.approxFiles;
      rec.phases.gen.generateMs = j.generateMs;
    } catch (e) {
      console.warn(
        `[${LABEL}] gen: failed to parse generator JSON output (approxFiles/generateMs dropped): ${e.message}`,
      );
    }
  } else {
    rec.phases.gen.error = String(r.out?.message || r.out).split("\n")[0];
    console.warn(`[${LABEL}] gen FAILED; skipping dependent phases: ${rec.phases.gen.error}`);
    abort = true;
  }
}

// ---- install ----
if (!abort && PHASES.includes("install")) {
  // clean install so each scale is measured independently (no carry-over from a
  // prior scale). Remove the WHOLE node_modules tree (root + per-package) — a
  // stale apps/*/node_modules lets pnpm time a partial no-op. Global store stays warm.
  // cleanup must succeed — a stale tree would let pnpm time a no-op (don't swallow)
  execSync(`find . -name node_modules -type d -prune -exec rm -rf {} +`, { cwd: ROOT });
  rmSync(join(ROOT, "pnpm-lock.yaml"), { force: true });
  const r = timed("install", () => sh("pnpm install"));
  rec.phases.install = { ms: r.ms, ok: r.ok };
  if (!r.ok) abort = true;
  // Completeness check AFTER the timed install (so it isn't counted): a `pnpm
  // install` that exits 0 can still be partial. Verify every app/lib resolves all
  // its declared deps + devDeps; on any miss mark the phase failed and abort —
  // don't record a clean ms/lockfile-size datapoint for a silently-partial install.
  if (r.ok) {
    const incomplete = verifyInstallComplete();
    if (incomplete) {
      rec.phases.install.ok = false;
      rec.phases.install.error = incomplete.split("\n")[0];
      abort = true;
      console.warn(`[${LABEL}] install FAILED completeness check; skipping dependent phases:`);
      console.warn(incomplete);
    }
  }
  // lockfile size — only from a SUCCESSFUL, COMPLETE install (a failed/partial
  // install must not become a clean lockfile-size datapoint).
  if (rec.phases.install.ok && existsSync(join(ROOT, "pnpm-lock.yaml"))) {
    const buf = readFileSync(join(ROOT, "pnpm-lock.yaml"));
    rec.phases.install.lockfileBytes = buf.length;
    rec.phases.install.lockfileLines = (buf.toString().match(/\n/g) || []).length;
  }
  if (rec.phases.install.ok && FS_STATS) {
    // full-tree footprint via strict statInt. du -sb is apparent size (sum of
    // file sizes), so name it apparentBytes rather than claiming on-disk blocks.
    timed("fs-stats", () => {
      const nmEntries = statInt(`find . -path '*/node_modules/*' -printf '.' | wc -c`);
      const nmSymlinks = statInt(`find . -path '*/node_modules/*' -type l -printf '.' | wc -c`);
      const nmApparentBytes = statInt(
        `find . -name node_modules -type d -prune -exec du -sb {} + | awk '{s+=$1} END {print s+0}'`,
      );
      Object.assign(rec.phases.install, { nmEntries, nmSymlinks, nmApparentBytes });
    });
  }
}

// ---- graph ----
if (!abort && PHASES.includes("graph")) {
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
if (!abort && PHASES.includes("typecheck")) {
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
  // warm cache is populated BY the cold run, so only a successful cold makes the
  // warm measurement meaningful; otherwise don't run/record it.
  const warm = cold.ok
    ? timed("typecheck:warm", () =>
        sh(
          `pnpm exec turbo run typecheck --cache=local:rw --concurrency=${CONC} --output-logs=errors-only`,
        ),
      )
    : null;
  rec.phases.typecheck = {
    coldMs: cold.ms,
    coldOk: cold.ok,
    warmupOk,
    ...(warm ? { warmMs: warm.ms, warmOk: warm.ok } : {}),
  };
}

// ---- focus build (one app + its lib closure) ----
if (!abort && PHASES.includes("focus")) {
  rmSync(join(ROOT, ".turbo"), { recursive: true, force: true });
  // Build outputs survive a .turbo clear (turbo.json even excludes .next/cache
  // from its outputs), so a standalone focus run on an already-built tree would
  // let `next build` read apps/<app>/.next/cache as warm. Remove the app/lib build
  // outputs too, so focus.ms is genuinely from-scratch regardless of phase
  // selection. In a full sweep these don't exist before focus (no app build ran;
  // lib builds are non-incremental), so this leaves a full-sweep number unchanged.
  for (const [group, name] of [
    ["apps", ".next"],
    ["apps", "dist"],
    ["packages", "dist"],
  ]) {
    const groupDir = join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const pkg of readdirSync(groupDir))
      rmSync(join(groupDir, pkg, name), { recursive: true, force: true });
  }
  const r = timed(`focus build ${sampleApp}...`, () =>
    sh(
      `pnpm exec turbo run build --filter=${sampleApp}... --cache=local:rw --concurrency=${CONC} --output-logs=errors-only`,
    ),
  );
  rec.phases.focus = { ms: r.ms, ok: r.ok, app: sampleApp };
}

// ---- prune (artifact-time focus) ----
if (!abort && PHASES.includes("prune")) {
  // Source is visible to git (enterSourceVisible) while build outputs stay
  // ignored, so plain prune (respecting .gitignore) copies the source subtree and
  // skips .next/dist/node_modules — no --use-gitignore=false, no manual strip.
  rmSync(join(ROOT, "out"), { recursive: true, force: true });
  const r = timed(`prune ${sampleApp}`, () => sh(`pnpm exec turbo prune ${sampleApp} --docker`));
  rec.phases.prune = { ms: r.ms, ok: r.ok, app: sampleApp };
  // a "successful" prune must produce out/json and out/full; missing artifacts
  // mean it didn't really work, so don't record clean zeroes.
  if (r.ok) {
    if (!existsSync(join(ROOT, "out", "json")) || !existsSync(join(ROOT, "out", "full"))) {
      rec.phases.prune.ok = false;
      rec.phases.prune.error = "prune produced no out/json or out/full";
      console.warn(`[${LABEL}] prune: missing out/json or out/full after a 0-exit prune`);
    } else {
      rec.phases.prune.outApparentBytes = statInt(`du -sb --apparent-size out | cut -f1`);
      rec.phases.prune.outPackages = statInt(`find out/json -name package.json | wc -l`);
      rec.phases.prune.outFiles = statInt(`find out/full -type f | wc -l`);
    }
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

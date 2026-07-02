#!/usr/bin/env node
// Vite Task (Vite+'s Rust monorepo task runner, `vp run`) vs Turborepo on the generated
// workspace — the task-orchestration axis no other bench covers. Same dependency DAG, same
// tsgo binary, same installer (the repo's pinned pnpm), concurrency pinned to the core
// count on both; cold asserted 0 cached / warm asserted all cached on both, from each
// runner's own summary line. Wall times are the comparison; the MECHANISM contrast is the
// second finding: turbo hashes declared inputs and respects .gitignore (this repo's
// central correctness lesson — its rungs run under enterSourceVisible), while Vite Task
// fingerprints the files a task actually READS (fs tracing), so its rungs run on the
// plain gitignored tree and the warm all-hit is asserted THERE — cache correctness on
// gitignored source with zero config.
//
//   node scripts/vite-task-bench.mjs                # scales: 300:100 1000:200
//   VITE_TASK_SCALES="300:100" VP_SAMPLES=3 node scripts/vite-task-bench.mjs
//
// The compared task is DEP-FREE (the test-axis isolation pattern): typecheck:tsgo with
// `@demo/*` resolved to lib SOURCE (per-package derived-tsconfig paths) and the
// turbo.json `dependsOn: ["^build"]` edge removed for it (bak'd + restored). Both
// runners then execute the identical N-task set with no build tasks in the window —
// pure orchestration + caching. vp cannot express dependsOn from package.json scripts,
// so the dep-free shape is also the only one both runners support natively.
//
// Rungs per scale (task: typecheck:tsgo — side-effect-clean + dep-free, see scaffoldPatches):
//   whole-repo cold + warm (median of VP_SAMPLES), both runners
//   focused (--filter '<mid app>...' — one app + its closure), cold + warm, both runners
//   task-count parity asserted per rung pair (same DAG → same task set)
// Once, at the last scale:
//   edit-invalidation — edit one mid lib's src module, run both warm: turbo's
//     package-scoped input hashing (with the ^build edge removed) keeps dependents
//     cached — a structural false hit of the dep-free shape, disclosed as such (with
//     dependsOn ^build turbo propagates invalidation through the build chain, at the
//     price of running builds); vp's tracer re-runs exactly the tasks that READ the
//     edited file — correct cross-package invalidation with zero task config
//   cacheability boundary — `next build` for one app: turbo caches it via declared
//     outputs (warm = all cached); vp REFUSES to cache it (its tracer sees next read and
//     write the same .next/ files — recorded verbatim from `vp run --last-details`).
//     ms diagnostic-only on this rung: the vp pass runs after turbo left dist/.next on
//     disk, so its cold is not comparable
//   test axis (Design D) — `turbo run test` vs `vp run -r test` (node --test smoke tests,
//     write nothing), cold + warm
//
// Discipline: cold turbo = daemon stopped + .turbo + pinned TURBO_CACHE_DIR +
// node_modules/.cache/turbo cleared; cold vp = `vp cache clean` + node_modules/.vite/
// task-cache removed. vp is non-interactive only with CI unset-or-true and stdin closed —
// every vp call runs with stdin ignored and CI="true" would flip yarn-style defaults in
// OTHER tools, so vp gets VP_FORCE_NONINTERACTIVE via closed stdin alone, plus CI="true"
// scoped to vp calls only (vp check's prompt hang, found in recon, does not afflict
// `vp run`, but closed stdin costs nothing and guards regressions). A signal-killed
// runner is a harness fault, never a timing. Destructive (regenerates apps/packages,
// edits the root package.json) — refuses to run outside a linked git worktree and
// restores every tracked file it touches on exit.

import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus } from "node:os";
import { VITE_PLUS_VERSION } from "./_pins.mjs";
import { median, loadGuard, load1Now, scrubEnv, benchOutput } from "./_pm-bench-lib.mjs";
import { enterSourceVisible } from "./_source-visible.mjs";
import { ensureCleanState } from "./clean-state.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCALES = (process.env.VITE_TASK_SCALES || "300:100 1000:200").trim().split(/\s+/);
const CANONICAL = "300:100 1000:200";
const SAMPLES = Number(process.env.VP_SAMPLES || 3);
const CORES = cpus().length;

const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};

// Destructive: regenerates apps/packages and overwrites the tracked root package.json —
// linked-worktree only (git-dir !== git-common-dir; the primary checkout has them equal).
const rev = (args) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout?.trim() ?? "";
if (rev(["rev-parse", "--git-dir"]) === rev(["rev-parse", "--git-common-dir"]))
  fail(
    "refusing to run outside a dedicated git worktree — this bench regenerates the tree and edits package.json. Create one (`git worktree add ~/src/vite-task HEAD`) and run there.",
  );
ensureCleanState(REPO);
const envInfo = loadGuard("VITE_TASK_ALLOW_BUSY");

// ---- restore-on-exit ---------------------------------------------------------------------------
const TRACKED = ["package.json", "turbo.json"].map((f) => ({
  path: join(REPO, f),
  bak: join(REPO, f + ".bench.bak"),
}));
for (const t of TRACKED) copyFileSync(t.path, t.bak);
let restored = false;
process.on("exit", () => {
  if (restored) return;
  restored = true;
  for (const t of TRACKED)
    if (existsSync(t.bak)) {
      copyFileSync(t.bak, t.path);
      rmSync(t.bak, { force: true });
    }
  spawnSync("pnpm", ["exec", "turbo", "daemon", "stop"], { cwd: REPO, stdio: "ignore" });
});
const PKG = TRACKED[0].path;
const PKG_BAK = TRACKED[0].bak;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

// ---- runners -----------------------------------------------------------------------------------
const TURBO_CACHE_DIR = join(REPO, ".turbo", "cache");
// ambient TURBO_*/VITE_*/npm_config_* and CI-detection vars would silently reconfigure
// either runner (turbo keys UI and update checks off CI; a stray TURBO_DAEMON or
// TURBO_CACHE_DIR would change what "cold" means) — scrub, then pin deliberately
const baseEnv = scrubEnv(["TURBO_", "VITE_", "VP_", "npm_config_"], {
  TURBO_TELEMETRY_DISABLED: "1",
  TURBO_CACHE_DIR,
});
for (const k of ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI"])
  delete baseEnv[k];

// run a command; signal death or spawn error is a harness fault, not a measurement
function run(cmd, args, { env = baseEnv, timeout = 3_600_000, cwd = REPO } = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) fail(`${cmd} ${args.join(" ")}: ${r.error.code || r.error.message}`);
  if (r.signal || r.status === null)
    fail(`${cmd} ${args.join(" ")} killed by ${r.signal || "unknown signal"} — not a measurement`);
  return {
    code: r.status,
    ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
    out: (r.stdout || "") + (r.stderr || ""),
  };
}

// turbo: parse its own "Cached: X cached, Y total" summary
const turboCounts = (out) => {
  const m = out.match(/Cached:\s+(\d+)\s+cached,\s+(\d+)\s+total/);
  if (!m) fail(`no turbo summary line in output:\n${out.slice(-400)}`);
  return { cached: +m[1], total: +m[2] };
};
function turboRun(task, filter) {
  const args = [
    "exec",
    "turbo",
    "run",
    task,
    ...(filter ? [`--filter=${filter}`] : []),
    "--cache=local:rw",
    `--concurrency=${CORES}`,
  ];
  const r = run("pnpm", args);
  if (r.code !== 0) fail(`turbo run ${task} exited ${r.code}:\n${r.out.slice(-600)}`);
  return { ms: r.ms, ...turboCounts(r.out) };
}
function turboColdPrep() {
  spawnSync("pnpm", ["exec", "turbo", "daemon", "stop"], { cwd: REPO, stdio: "ignore" });
  for (const d of [join(REPO, ".turbo"), join(REPO, "node_modules", ".cache", "turbo")])
    rmSync(d, { recursive: true, force: true });
  // measure.mjs's convention: an untimed --dry=json pass absorbs graph parse + any
  // startup cost, so the timed cold measures task execution + caching, not spin-up
  const w = run("pnpm", ["exec", "turbo", "run", "typecheck:tsgo", "--dry=json"], {
    timeout: 600_000,
  });
  if (w.code !== 0) fail(`turbo --dry=json warmup exited ${w.code}`);
}

// vp: parse its own "vp run: X/Y cache hit" summary. All flags BEFORE the task name —
// vp forwards everything after the task specifier to the task process.
const VP_CACHE = join(REPO, "node_modules", ".vite", "task-cache");
// vp gets CI=true (it prompts — and hangs a pipe — when it thinks it's interactive;
// measured during recon); turbo gets CI-absent (its documented non-CI operating state).
// Each runner runs in its own correct non-interactive configuration — disclosed in method.
const vpEnv = { ...baseEnv, CI: "true" };
const vpCounts = (out) => {
  const m = out.match(/vp run:\s+(\d+)\/(\d+)\s+cache hit/);
  if (!m) fail(`no vp summary line in output:\n${out.slice(-400)}`);
  return { cached: +m[1], total: +m[2] };
};
function vpRun(task, filter) {
  // --parallel: the compared task is dep-free by design, and turbo executes it flat
  // (dependsOn []); vp's default orders package scripts by workspace topology, which
  // would impose layer barriers the task does not need — flat on both, disclosed
  const args = [
    "exec",
    "vp",
    "run",
    ...(filter ? ["--filter", filter] : ["-r"]),
    "--parallel",
    "--cache",
    "--concurrency-limit",
    String(CORES),
    "--log",
    "grouped",
    task,
  ];
  const r = run("pnpm", args, { env: vpEnv });
  if (r.code !== 0) fail(`vp run ${task} exited ${r.code}:\n${r.out.slice(-600)}`);
  return { ms: r.ms, ...vpCounts(r.out) };
}
function vpColdPrep() {
  const r = run("pnpm", ["exec", "vp", "cache", "clean"], { env: vpEnv, timeout: 120_000 });
  if (r.code !== 0) fail(`vp cache clean exited ${r.code}`);
  rmSync(VP_CACHE, { recursive: true, force: true });
}

// one cold + SAMPLES warm, with the runner's own counts asserted per sample
function coldWarm(label, coldPrep, runner, task, filter) {
  coldPrep();
  const cold = runner(task, filter);
  if (cold.total === 0) fail(`${label} cold: matched 0 tasks — the selector hit nothing`);
  if (cold.cached !== 0) fail(`${label} cold: expected 0 cached, got ${cold.cached}/${cold.total}`);
  const warmMs = [];
  for (let s = 0; s < SAMPLES; s++) {
    const w = runner(task, filter);
    // all cached AND the same task set — a warm run that silently shrank the set would
    // otherwise read as a full-cache hit
    if (w.cached !== w.total || w.total !== cold.total)
      fail(
        `${label} warm sample ${s}: expected ${cold.total}/${cold.total} cached, got ${w.cached}/${w.total}`,
      );
    warmMs.push(w.ms);
  }
  const res = {
    coldMs: cold.ms,
    warmMs: median(warmMs),
    warmSamplesMs: warmMs,
    tasks: cold.total,
    loadAvg1: load1Now(),
  };
  console.log(
    `  ${label}: cold ${cold.ms}ms, warm ${res.warmMs}ms (${cold.total} tasks, ${SAMPLES} warm samples)`,
  );
  return res;
}

// ---- root patches (once; bak'd + restored on exit) ----------------------------------------------
// (a) dep-free typecheck:tsgo: drop its ^build edge so neither runner schedules builds
const turboJson = JSON.parse(readFileSync(join(REPO, "turbo.json"), "utf8"));
turboJson.tasks["typecheck:tsgo"].dependsOn = [];
writeFileSync(join(REPO, "turbo.json"), JSON.stringify(turboJson, null, 2) + "\n");
// @demo/* -> source paths live in each package's DERIVED tsconfig (written per scale in
// generate()), NOT in tsconfig.base — base is extended by the build tsconfigs too, and a
// paths-to-source mapping there breaks the emit-oriented `build` task (TS6059 against
// its rootDir). Explicit index.ts because the libs resolve with moduleResolution
// nodenext, under which a directory-mapped path does not imply /index.

// ---- scaffold ----------------------------------------------------------------------------------
function generate(apps, libs) {
  const r = run(
    "node",
    [
      join(REPO, "scripts", "generate.mjs"),
      "--apps",
      String(apps),
      "--libs",
      String(libs),
      "--modules",
      "12",
      "--tsgo-task",
      "--test-task",
      "--clean",
    ],
    { timeout: 1_800_000 },
  );
  if (r.code !== 0) fail(`generate failed:\n${r.out.slice(-400)}`);
  // scaffoldPatches: every package gets a derived tsconfig.tsgo.json and its
  // typecheck:tsgo script is pointed at it — (a) `incremental: false`: tsc/tsgo rewrite
  // tsconfig.tsbuildinfo even under --noEmit, and Vite Task refuses to cache a task that
  // writes a file it also read (side-effect-clean is required on BOTH runners for the
  // comparison to be about orchestration; the self-mutating boundary is its own rung);
  // (b) `rootDir: "../.."`: the libs' emit-oriented rootDir "src" rejects the other
  // libs' SOURCE the paths mapping pulls in (TS6059). The package's own tsconfig stays
  // pristine — the `build` task (tsc emit, dist layout) is untouched.
  for (const group of ["apps", "packages"]) {
    for (const name of readdirSync(join(REPO, group))) {
      const dir = join(REPO, group, name);
      writeFileSync(
        join(dir, "tsconfig.tsgo.json"),
        JSON.stringify(
          {
            extends: "./tsconfig.json",
            compilerOptions: {
              rootDir: "../..",
              incremental: false,
              paths: { "@demo/*": ["../../packages/*/src/index.ts"] },
            },
          },
          null,
          2,
        ) + "\n",
      );
      const pj = join(dir, "package.json");
      const pkg = JSON.parse(readFileSync(pj, "utf8"));
      pkg.scripts["typecheck:tsgo"] = "tsgo --noEmit -p tsconfig.tsgo.json";
      writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n");
    }
  }
  // (2) root devDeps: vite-plus (pinned) beside the repo's pinned turbo + tsgo, one
  // pnpm install for both runners — the installer and node_modules are held constant
  const pkg = JSON.parse(readFileSync(PKG_BAK, "utf8"));
  pkg.devDependencies["vite-plus"] = VITE_PLUS_VERSION;
  pkg.devDependencies["@voidzero-dev/vite-plus-core"] = VITE_PLUS_VERSION;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
  const i = run("pnpm", ["install"], { timeout: 1_800_000 });
  if (i.code !== 0) fail(`pnpm install failed:\n${i.out.slice(-400)}`);
}

const midApp = () => {
  const apps = readdirSync(join(REPO, "apps")).sort();
  const name = apps[Math.floor(apps.length / 2)];
  return JSON.parse(readFileSync(join(REPO, "apps", name, "package.json"), "utf8")).name;
};
// package name (@demo/app-0123) -> generated dir name (app-0123)
const focusDirName = (pkgName) => pkgName.replace(/^@demo\//, "");

// ---- bench -------------------------------------------------------------------------------------
const OUT_FILES = benchOutput(
  REPO,
  "bench/vite-task-bench.partial.json",
  "bench/vite-task-bench.json",
);
const out = {
  versions: {
    vitePlus: VITE_PLUS_VERSION,
    turbo: JSON.parse(readFileSync(PKG_BAK, "utf8")).devDependencies.turbo,
    tsgo: JSON.parse(readFileSync(PKG_BAK, "utf8")).devDependencies["@typescript/native-preview"],
    node: process.version,
  },
  ...envInfo,
  concurrency: CORES,
  warmSamples: SAMPLES,
  method:
    "same generated DAG, same tsgo binary, same pnpm-installed node_modules; concurrency pinned to the core count on both runners; vp runs --parallel (flat execution matching the dep-free task semantics turbo gets from dependsOn []; vp's default would impose workspace-topology ordering on package scripts); cold/warm asserted from each runner's own summary (turbo 'Cached: X cached, Y total'; vp 'X/Y cache hit'); cold is a single sample (repo convention for expensive colds), warm the median of warmSamples, per-rung 1-min load recorded; runner order alternates per scale (recorded) so neither side's cold systematically inherits the other's page cache; turbo cold follows an untimed --dry=json warmup (graph parse excluded, the measure.mjs convention); env scrubbed (TURBO_*/VITE_*/VP_*/npm_config_*/CI vars) then pinned per runner — turbo runs CI-absent, vp runs CI=true (it prompts and hangs a pipe otherwise; each runner in its own documented non-interactive state); turbo rungs run under enterSourceVisible (turbo hashes declared inputs and respects .gitignore), vp rungs run on the plain gitignored tree (Vite Task fingerprints the files a task reads) — the mechanism contrast is a finding, not a confound",
  scaffoldPatches:
    "(1) per-package tsconfig.tsgo.json (extends the package tsconfig; incremental:false so no tsbuildinfo write — Vite Task refuses to cache a task that writes a file it read; rootDir ../.. so the source the paths mapping pulls in is admissible), with the typecheck:tsgo script pointed at it; (2) paths @demo/* -> ../../packages/*/src/index.ts in that derived config only (tsconfig.base is extended by the build tsconfigs, where a source mapping breaks emit) so typecheck resolves lib SOURCE and needs no dist; (3) turbo.json typecheck:tsgo dependsOn [] — with (2)+(3) the compared task is dep-free and identical on both runners (the test-axis isolation pattern); the ^build edge is also how turbo propagates cross-package invalidation, so the edit-invalidation rung's turbo false-hit is a structural consequence of this shape, disclosed there",
  scales: {},
};

let verified = false;
for (const scale of SCALES) {
  const [apps, libs] = scale.split(":").map(Number);
  console.log(`\n== ${apps} apps / ${libs} libs ==`);
  generate(apps, libs);
  if (!verified) {
    // vp resolves and orders the same workspace pnpm installed — verify once that the
    // pinned vp is what pnpm exec finds
    const v = run("pnpm", ["exec", "vp", "--version"], { env: vpEnv, timeout: 120_000 });
    const vLine = v.out.split("\n")[0].trim();
    if (v.code !== 0 || vLine !== `vp v${VITE_PLUS_VERSION}`)
      fail(`vp --version reports "${vLine}" (exit ${v.code}), expected vp v${VITE_PLUS_VERSION}`);
    verified = true;
  }
  const focus = midApp();
  // alternate which runner goes first per scale — a fixed order would give the second
  // runner a systematically warmer page cache on its cold sample; the order is recorded
  const turboFirst = SCALES.indexOf(scale) % 2 === 0;
  const rec = { focusApp: focus, runnerOrder: turboFirst ? "turbo,vp" : "vp,turbo" };

  const runTurbo = () => {
    // turbo under enterSourceVisible — without it turbo hashes nothing of the gitignored
    // tree and warm runs are false cache hits (the repo's central correctness lesson)
    const leave = enterSourceVisible(REPO);
    try {
      rec.turboWhole = coldWarm(`turbo whole ${scale}`, turboColdPrep, turboRun, "typecheck:tsgo");
      rec.turboFocused = coldWarm(
        `turbo focused ${scale}`,
        turboColdPrep,
        turboRun,
        "typecheck:tsgo",
        `${focus}...`,
      );
    } finally {
      leave();
    }
  };
  const runVp = () => {
    // vp on the PLAIN tree — apps/ and packages/ are gitignored right now (probed, not
    // assumed); an all-cached warm here is the fs-traced cache working on source that
    // .gitignore hides from turbo
    const probe = spawnSync("git", ["check-ignore", "-q", join("apps", focusDirName(focus))], {
      cwd: REPO,
    });
    const sourceIgnored = probe.status === 0;
    rec.vpWhole = coldWarm(`vp whole ${scale}`, vpColdPrep, vpRun, "typecheck:tsgo");
    rec.vpFocused = coldWarm(
      `vp focused ${scale}`,
      vpColdPrep,
      vpRun,
      "typecheck:tsgo",
      `${focus}...`,
    );
    // measured: the tree was gitignored AND every vp warm sample above was all-cached
    rec.vpCachesGitignoredSource = sourceIgnored;
    if (!sourceIgnored)
      console.log("  NOTE: apps/ was not gitignored during the vp rungs — recorded false");
  };
  if (turboFirst) {
    runTurbo();
    runVp();
  } else {
    runVp();
    runTurbo();
  }

  // parity: the two runners must have executed the same task sets
  if (rec.turboWhole.tasks !== rec.vpWhole.tasks)
    fail(
      `whole-repo task-count mismatch: turbo ${rec.turboWhole.tasks} vs vp ${rec.vpWhole.tasks}`,
    );
  if (rec.turboFocused.tasks !== rec.vpFocused.tasks)
    fail(
      `focused task-count mismatch: turbo ${rec.turboFocused.tasks} vs vp ${rec.vpFocused.tasks}`,
    );

  out.scales[scale] = rec;
  OUT_FILES.persist(out); // completed measurements survive a later rung's hard fail
}

// ---- edit-invalidation, at the last generated scale ---------------------------------------------
console.log(`\n== edit-invalidation: one lib src edit, both runners warm ==`);
{
  const libs = readdirSync(join(REPO, "packages")).sort();
  const lib = libs[Math.floor(libs.length / 2)];
  const libPkg = JSON.parse(readFileSync(join(REPO, "packages", lib, "package.json"), "utf8")).name;
  const mod = join(REPO, "packages", lib, "src", "index.ts");
  // re-warm the WHOLE-repo cache on both runners (the focused rungs' cold prep wiped
  // it): one repopulating run, then one asserted all-cached — the measured deltas below
  // are then attributable to the edit alone
  {
    const leaveW = enterSourceVisible(REPO);
    try {
      turboRun("typecheck:tsgo");
      const t = turboRun("typecheck:tsgo");
      if (t.cached !== t.total)
        fail(`edit-invalidation pre-warm: turbo not all-cached (${t.cached}/${t.total})`);
    } finally {
      leaveW();
    }
    vpRun("typecheck:tsgo");
    const v = vpRun("typecheck:tsgo");
    if (v.cached !== v.total)
      fail(`edit-invalidation pre-warm: vp not all-cached (${v.cached}/${v.total})`);
  }
  writeFileSync(mod, readFileSync(mod, "utf8") + "\nexport const benchEditProbe = 1;\n");
  const leave = enterSourceVisible(REPO);
  let turboAfter;
  try {
    turboAfter = turboRun("typecheck:tsgo");
  } finally {
    leave();
  }
  const vpAfter = vpRun("typecheck:tsgo");
  const turboRecomputed = turboAfter.total - turboAfter.cached;
  const vpRecomputed = vpAfter.total - vpAfter.cached;
  // the edited lib itself must recompute on both, or the rung measured nothing
  if (turboRecomputed < 1) fail("edit-invalidation: turbo recomputed 0 tasks after a src edit");
  if (vpRecomputed < 1) fail("edit-invalidation: vp recomputed 0 tasks after a src edit");
  out.editInvalidation = {
    editedLib: libPkg,
    turbo: {
      recomputed: turboRecomputed,
      total: turboAfter.total,
      dependentsInvalidated: turboRecomputed > 1,
      note: "package-scoped input hashing: with the ^build edge removed (the dep-free shape both runners compare on) an importer's task inputs do not span packages, so dependents stay cached. turbo's native mechanisms for cross-package invalidation are the dependsOn ^build edge (propagates through the build chain, scheduling builds) or globalDependencies (invalidates every task on any match) — per-dependent propagation without one of those is not expressible",
    },
    vp: {
      recomputed: vpRecomputed,
      total: vpAfter.total,
      dependentsInvalidated: vpRecomputed > 1,
      note: "fs-traced inputs: every task whose traced read set contains the edited file recomputes — cross-package invalidation with zero task config",
    },
  };
  console.log(
    `  after 1 lib src edit: turbo recomputed ${turboRecomputed}/${turboAfter.total}; vp recomputed ${vpRecomputed}/${vpAfter.total}`,
  );
  OUT_FILES.persist(out);
}

// ---- boundary + test rungs, at the last generated scale -----------------------------------------
console.log(`\n== boundary: a self-mutating task (next build) ==`);
{
  const focus = midApp();
  // turbo: cold build of one app's closure, then warm — cached via declared outputs
  const leave = enterSourceVisible(REPO);
  let turboBoundary;
  try {
    turboColdPrep();
    const cold = turboRun("build", `${focus}...`);
    if (cold.total === 0) fail("turbo boundary cold: matched 0 tasks");
    if (cold.cached !== 0)
      fail(`turbo boundary cold: expected 0 cached, got ${cold.cached}/${cold.total}`);
    const warm = turboRun("build", `${focus}...`);
    if (warm.cached !== warm.total || warm.total !== cold.total)
      fail(
        `turbo warm build: expected ${cold.total}/${cold.total} cached, got ${warm.cached}/${warm.total}`,
      );
    turboBoundary = { cachesNextBuild: true, coldMs: cold.ms, warmMs: warm.ms, tasks: cold.total };
  } finally {
    leave();
  }
  // vp: ONLY the app's build task (exact filter, no `...`): the lib closure's dist is on
  // disk from turbo's run, so nothing rebuilds concurrently under vp's dependency-free
  // scheduling, and the verdict is exactly about the next build task
  vpColdPrep();
  // raw runs: a run whose only task is refused for input-modification prints no
  // "X/Y cache hit" summary at all — the verdict is parsed per-task from --last-details
  const vpBoundaryArgs = [
    "exec",
    "vp",
    "run",
    "--filter",
    focus,
    "--cache",
    "--log",
    "grouped",
    "build",
  ];
  const b1 = run("pnpm", vpBoundaryArgs, { env: vpEnv });
  if (b1.code !== 0) fail(`vp boundary build (1st) exited ${b1.code}:\n${b1.out.slice(-400)}`);
  const b2 = run("pnpm", vpBoundaryArgs, { env: vpEnv });
  if (b2.code !== 0) fail(`vp boundary build (2nd) exited ${b2.code}:\n${b2.out.slice(-400)}`);
  const details = run("pnpm", ["exec", "vp", "run", "--last-details"], {
    env: vpEnv,
    timeout: 120_000,
  });
  if (details.code !== 0)
    fail(`vp run --last-details exited ${details.code} — the boundary evidence is missing`);
  // classify the APP's build task from its own details entry — aggregate counts can't:
  // the lib closure (tsc, clean writes) caching or not would contaminate the verdict
  const lines = details.out.split("\n");
  const appIdx = lines.findIndex((l) => l.includes(`${focus}#build`));
  if (appIdx === -1)
    fail(`vp run --last-details has no entry for ${focus}#build:\n${details.out.slice(-600)}`);
  const appStatus = (lines[appIdx + 1] || "").trim();
  const vpCachesNextBuild = /cache hit/i.test(appStatus);
  const refusal = /not cached/i.test(appStatus) ? appStatus : null;
  if (!vpCachesNextBuild && !refusal)
    fail(
      `vp did not cache ${focus}#build but its status line records no refusal reason: "${appStatus}"`,
    );
  out.boundary = {
    task: "build (next build for one app + its lib closure)",
    msNote:
      "cacheability is the finding on this rung; the vp pass runs after turbo left dist/.next on disk, so its ms are not cold-comparable and are diagnostic only",
    turbo: turboBoundary,
    vp: {
      cachesNextBuild: vpCachesNextBuild,
      refusalSample: refusal || null,
    },
  };
  console.log(
    `  turbo caches next build: true (warm ${turboBoundary.warmMs}ms); vp caches it: ${vpCachesNextBuild}${refusal ? `\n    ${refusal}` : ""}`,
  );
}

console.log(`\n== test axis: turbo run test vs vp run -r test (node --test) ==`);
{
  const leave = enterSourceVisible(REPO);
  let turboTest;
  try {
    turboTest = coldWarm("turbo test", turboColdPrep, turboRun, "test");
  } finally {
    leave();
  }
  const vpTest = coldWarm("vp test", vpColdPrep, vpRun, "test");
  if (turboTest.tasks !== vpTest.tasks)
    fail(`test task-count mismatch: turbo ${turboTest.tasks} vs vp ${vpTest.tasks}`);
  out.testAxis = {
    task: "test (node --test smoke test per package)",
    turbo: turboTest,
    vp: vpTest,
  };
}

// ---- write -------------------------------------------------------------------------------------
const canonical = SCALES.join(" ") === CANONICAL && SAMPLES === 3;
if (canonical) OUT_FILES.promote(out);
else OUT_FILES.persist(out);
console.log(
  `\n--- bench/vite-task-bench${canonical ? "" : ".partial"}.json written${canonical ? "" : " (non-canonical args → partial)"} ---`,
);
for (const [scale, r] of Object.entries(out.scales))
  console.log(
    `${scale}: whole cold turbo ${r.turboWhole.coldMs}ms vs vp ${r.vpWhole.coldMs}ms; warm ${r.turboWhole.warmMs}ms vs ${r.vpWhole.warmMs}ms; focused warm ${r.turboFocused.warmMs}ms vs ${r.vpFocused.warmMs}ms`,
  );

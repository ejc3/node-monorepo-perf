#!/usr/bin/env node
// The DEVELOPER inner loops on the optimal stack (bun + tsgo + oxlint + turbo) at 4000:400,
// for the two day-to-day roles, each reported as FRESH (first time) vs SUBSEQUENT (repeat):
//
//   App developer  — touches one app + the libs it imports (O(closure)).
//   Lib developer  — touches one leaf lib + the libs it imports (O(closure)); its pre-merge
//                    gate re-checks the lib's dependents.
//
// For each role it measures, fresh vs subsequent where the distinction exists:
//   - typecheck-on-save — tsgo over the package + its closure, from source (no dist build)
//   - lint-on-save      — oxlint over the one package dir
//   - focused gate      — turbo typecheck:tsgo over the closure / dependents, COLD then WARM
// plus the one-time onboarding `bun install`, fresh (cold node_modules) vs subsequent (warm).
// The workspace-author core-package gate is O(repo) and lives in optimal-gate-bench.mjs; the
// whole-program tsgo gate there has no cache (fresh == subsequent).
//
//   node scripts/dev-loop-bench.mjs 4000:400   (APP_LOOP_TARGET / LIB_LOOP_TARGET to pick)
//
// Destructive (regenerates the tree, overwrites the root package.json), so it REFUSES to run
// outside a dedicated git worktree and, on exit, restores the tracked files it overwrites (root
// package.json, .gitignore, the temp tsconfigs, lockfiles) so git status stays clean; the
// regenerated apps/packages tree is left in the worktree as gitignored scratch. The turbo runs
// go through enterSourceVisible so input hashing is representative. Core-bound, so it refuses
// to run on a loaded box. Direct-tool steps run APP_LOOP_SAMPLES+1 times: run #1 is the fresh
// number, the median of the rest is subsequent.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, availableParallelism, loadavg } from "node:os";
import { enterSourceVisible } from "./_source-visible.mjs";

const spec = (process.argv[2] || "4000:400").trim();
const m = spec.match(/^(\d+):(\d+)$/);
if (!m) {
  console.error(`usage: dev-loop-bench.mjs <apps>:<libs>  (got "${spec}")`);
  process.exit(1);
}
const APPS = +m[1];
const LIBS = +m[2];
const MODULES = +(process.env.MODULES || 16);
if (APPS < 1 || LIBS < 1) {
  console.error(`apps and libs must each be >= 1 (got ${APPS}:${LIBS})`);
  process.exit(1);
}
const ROOT = process.cwd();
const PKG = join(ROOT, "package.json");
const BUN = existsSync(join(homedir(), ".bun/bin/bun")) ? join(homedir(), ".bun/bin/bun") : "bun";
const SAMPLES = (() => {
  const n = Math.floor(Number(process.env.APP_LOOP_SAMPLES));
  return Number.isFinite(n) && n >= 1 ? n : 3;
})();
const GATE_SAMPLES = (() => {
  const n = Math.floor(Number(process.env.GATE_SAMPLES));
  return Number.isFinite(n) && n >= 1 ? n : 3;
})();
const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  TURBO_CACHE_DIR: join(ROOT, ".turbo", "cache"),
};
const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...opts });
const bin = (name) => join(ROOT, "node_modules", ".bin", name);
const ver = (name) =>
  existsSync(bin(name))
    ? execSync(`${bin(name)} --version`)
        .toString()
        .trim()
    : null;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2);
};

// Destructive: regenerates apps/packages and overwrites the tracked root package.json, so it
// must run in a throwaway worktree. A LINKED worktree's git-dir (.../worktrees/<name>) differs
// from its git-common-dir (.../.git); the PRIMARY checkout has them equal — an exact test, not
// a substring heuristic (a primary checkout whose path contains "worktrees" must still refuse).
const gitDir = sh("git rev-parse --git-dir", { encoding: "utf8" }).trim();
const gitCommonDir = sh("git rev-parse --git-common-dir", { encoding: "utf8" }).trim();
if (gitDir === gitCommonDir) {
  console.error(
    "refusing to run outside a dedicated git worktree — it overwrites package.json and the generated tree.",
  );
  console.error("create one (e.g. `git worktree add ~/src/dev-loop HEAD`) and run there.");
  process.exit(1);
}

// The timed steps are core-bound (tsgo is parallel; turbo runs at 100% concurrency), so a
// co-tenant hogging cores would collapse the numbers — refuse on a busy box.
const CORES = availableParallelism();
const load1 = loadavg()[0];
if (load1 > CORES * 0.5 && !process.env.APP_LOOP_ALLOW_BUSY) {
  console.error(
    `1-min load average ${load1.toFixed(1)} on ${CORES} cores — busy box; the timings would be contended.\n` +
      `Wait for it to quiesce, or set APP_LOOP_ALLOW_BUSY=1.`,
  );
  process.exit(1);
}

const aw = String(APPS).length;
const lw = String(LIBS).length;
const pad = (n, w) => String(n).padStart(w, "0");
const APP = process.env.APP_LOOP_TARGET || `app-${pad(Math.max(1, Math.floor(APPS / 2)), aw)}`;
const LIB = process.env.LIB_LOOP_TARGET || `lib-${pad(LIBS, lw)}`; // highest lib = a leaf
const APPPKG = `@demo/${APP}`;
const LIBPKG = `@demo/${LIB}`;

// Cold = no turbo cache AND no leftover incremental state. The app's typecheck tsconfig sets
// `incremental`, so a stale *.tsbuildinfo left by a prior sample could let a "cold" run go
// incrementally fast and understate the cold gate. Clear both. (The libs' tsc `^build` is
// non-incremental and turbo re-runs it on a cache miss anyway, so dist is fresh each cold run.)
const coldCache = () =>
  sh(
    "rm -rf .turbo node_modules/.cache/turbo; " +
      "find apps packages -name '*.tsbuildinfo' -not -path '*/node_modules/*' -delete",
  );
const rmNodeModules = () => sh("find . -name node_modules -type d -prune -exec rm -rf {} +");
const rmLocks = () => {
  for (const f of ["pnpm-lock.yaml", "bun.lock", "bun.lockb"])
    rmSync(join(ROOT, f), { force: true });
};

// ---- setup: generate, decatalog, bun-installable root ---------------------------
console.log(`# dev inner loops: ${APPS} apps / ${LIBS} libs — app ${APPPKG}, leaf lib ${LIBPKG}`);
sh(
  `node scripts/generate.mjs --apps ${APPS} --libs ${LIBS} --modules ${MODULES} --universal 1 --tsgo-task --clean`,
);
for (const [pkg, dir] of [
  [APP, join(ROOT, "apps", APP)],
  [LIB, join(ROOT, "packages", LIB)],
]) {
  if (!existsSync(dir)) {
    console.error(`target ${pkg} was not generated (target out of range?)`);
    process.exit(1);
  }
}
sh(`node scripts/rewrite-protocols.mjs --dir apps --catalog ${join(ROOT, "pnpm-workspace.yaml")}`);
sh(
  `node scripts/rewrite-protocols.mjs --dir packages --catalog ${join(ROOT, "pnpm-workspace.yaml")}`,
);

// Capture what we mutate and register an idempotent restore (normal exit, throw, Ctrl-C/kill)
// BEFORE the long bun install so an interrupt can't leave the worktree dirty.
const origPkg = readFileSync(PKG, "utf8");
const tsconfigs = [];
let restoreGi;
let restored = false;
function restoreAll() {
  if (restored) return;
  restored = true;
  if (restoreGi) restoreGi();
  writeFileSync(PKG, origPkg);
  for (const f of tsconfigs) rmSync(f, { force: true });
  rmLocks();
}
process.on("exit", restoreAll);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const toolchain = JSON.parse(origPkg).devDependencies;
const bunVer = execSync(`${BUN} --version`).toString().trim();
writeFileSync(
  PKG,
  JSON.stringify(
    {
      name: "dev-loop-bench",
      private: true,
      packageManager: `bun@${bunVer}`,
      workspaces: ["apps/*", "packages/*"],
      devDependencies: {
        turbo: toolchain.turbo,
        typescript: toolchain.typescript,
        "@typescript/native-preview": toolchain["@typescript/native-preview"],
        oxlint: "latest",
      },
    },
    null,
    2,
  ) + "\n",
);
rmLocks();

// ---- onboarding: bun install, fresh (cold node_modules) vs subsequent (warm) ----
// Pre-warm the store + lockfile (discard), then time a FRESH install (node_modules wiped) and
// a SUBSEQUENT one (node_modules present). Both are warm-store; fresh is the per-clone link
// cost, subsequent is the no-op re-run a dev hits on an unchanged tree.
console.log("\n## onboarding: bun install — fresh (cold node_modules) vs subsequent (warm)");
sh(`${BUN} install`, { encoding: "utf8" }); // pre-warm store + lockfile
rmNodeModules();
let t = process.hrtime.bigint();
sh(`${BUN} install`, { encoding: "utf8" });
const installFreshMs = Math.round(Number(process.hrtime.bigint() - t) / 1e6);
t = process.hrtime.bigint();
sh(`${BUN} install`, { encoding: "utf8" });
const installSubsequentMs = Math.round(Number(process.hrtime.bigint() - t) / 1e6);
console.log(`  bun install: fresh ${installFreshMs}ms, subsequent ${installSubsequentMs}ms`);

const result = {
  apps: APPS,
  libs: LIBS,
  modulesPerLib: MODULES,
  cores: CORES,
  preRunLoadAvg1: +load1.toFixed(2),
  samples: SAMPLES,
  versions: {
    bun: bunVer,
    tsgo: ver("tsgo"),
    tsc: ver("tsc"),
    oxlint: ver("oxlint"),
    turbo: ver("turbo"),
    node: process.version,
  },
  onboarding: {
    tool: "bun",
    storeWarm: true,
    freshMs: installFreshMs,
    subsequentMs: installSubsequentMs,
  },
};

// Repeats of the same warm command cluster tightly on a quiet box. A sample far above the
// median means a co-tenant spun up MID-RUN (the start-of-run load guard can't see that). Refuse
// rather than publish a contended number — the spread is the signal. High side only: a fast
// outlier isn't contention, and the median is robust to it.
function assertNotContended(label, samples) {
  if (samples.length < 2) return;
  const m = median(samples);
  const hi = Math.max(...samples);
  if (hi > 2 * m && hi - m > 50) {
    throw new Error(
      `${label}: samples too noisy (${samples.join(",")}ms; max ${hi} > 2x median ${m}) — ` +
        `the box was contended mid-run; re-run when idle.`,
    );
  }
}

// Run a direct tool SAMPLES+1 times: run #1 is the FIRST invocation, the median of the rest is
// the STEADY state. tsgo/oxlint are AOT binaries with no persistent incremental cache, so the
// two differ only by OS page-cache warmth — negligible here (the JSON shows first ~= steady).
// `mustExitZero` asserts a clean exit (a valid package must typecheck and lint clean), so a
// silently-failed run can't be recorded as a fast time.
function freshVsSubsequent(cmd, label, { mustExitZero = false, captureRss = false } = {}) {
  const one = () => {
    const s = process.hrtime.bigint();
    let ok = true;
    let out = "";
    try {
      out = sh(cmd, { encoding: "utf8" });
    } catch (e) {
      ok = false;
      out = (e.stdout || "") + (e.stderr || "");
    }
    return { ms: Math.round(Number(process.hrtime.bigint() - s) / 1e6), ok, out };
  };
  const runs = Array.from({ length: SAMPLES + 1 }, one);
  if (mustExitZero && !runs.every((r) => r.ok)) {
    const bad = runs.find((r) => !r.ok);
    throw new Error(
      `${label} did not exit cleanly (expected a valid package):\n${bad.out.slice(-800)}`,
    );
  }
  const fresh = runs[0].ms;
  const rest = runs.slice(1).map((r) => r.ms);
  const subsequent = median(rest);
  assertNotContended(`${label} subsequent`, rest);
  const rep = runs
    .slice(1)
    .reduce((a, b) => (Math.abs(b.ms - subsequent) < Math.abs(a.ms - subsequent) ? b : a));
  const rss = captureRss
    ? Math.round(+(rep.out.match(/Maximum resident set size \(kbytes\): (\d+)/) || [])[1] / 1024) ||
      null
    : undefined;
  if (captureRss && rss == null)
    throw new Error(`${label}: peak RSS not captured — is /usr/bin/time GNU time with -v?`);
  console.log(
    `  ${label}: fresh ${fresh}ms, subsequent ${subsequent}ms${rss != null ? ` / ${rss}MB` : ""} (subsequent samples ${rest.join(",")})`,
  );
  return { freshMs: fresh, subsequentMs: subsequent, samples: rest, maxRssMB: rss };
}

// A focused turbo run, asserted COLD (cached 0) or WARM (every task cached). Any failure or
// wrong cache state throws, so neither a stale-cache "cold" nor a partial "warm" is recorded.
function turbo(task, filter, { warm } = {}) {
  if (!warm) coldCache();
  const cmd = `${bin("turbo")} run ${task} --filter=${filter} --cache=local:rw --concurrency=100% --output-logs=errors-only`;
  const s = process.hrtime.bigint();
  let out;
  try {
    out = sh(cmd, { encoding: "utf8" });
  } catch (e) {
    throw new Error(
      `turbo run must succeed: ${cmd}\n${((e.stdout || "") + (e.stderr || "")).slice(-1500)}`,
    );
  }
  const ms = Math.round(Number(process.hrtime.bigint() - s) / 1e6);
  const tm = out.match(/Tasks:\s+(\d+) successful, (\d+) total/);
  const cm = out.match(/Cached:\s+(\d+) cached, (\d+) total/);
  if (!tm || !cm) throw new Error(`could not parse turbo summary: ${cmd}\n${out.slice(-1500)}`);
  const total = +tm[2];
  const cached = +cm[1];
  if (total === 0)
    throw new Error(
      `turbo selected no tasks (a no-op gate reads as a clean 0): ${cmd}\n${out.slice(-1500)}`,
    );
  if (!warm && cached !== 0)
    throw new Error(`expected a cold run but ${cached}/${total} were cached: ${cmd}`);
  if (warm && cached !== total)
    throw new Error(`expected a warm run but only ${cached}/${total} were cached: ${cmd}`);
  return { ms, total, cached };
}

// Turbo's graph-load + input-hash + cache-restore cost in a 4,400-package workspace is noisy,
// so a single gate shot is unreliable (a co-tenant during one ~20s run skews it). Run the gate
// GATE_SAMPLES times and report the median. Each cold sample clears the cache first (turbo()
// does), so every cold sample is truly cold; the warm samples all hit the cache the preceding
// cold run left populated.
function gateMedian(task, filter, { warm } = {}) {
  const runs = Array.from({ length: GATE_SAMPLES }, () => turbo(task, filter, { warm }));
  const totals = runs.map((r) => r.total);
  if (totals.some((t) => t !== totals[0]))
    throw new Error(`gate task total drifted across samples (${totals.join(",")}) for ${filter}`);
  const samples = runs.map((r) => r.ms);
  assertNotContended(`${warm ? "warm" : "cold"} gate ${filter}`, samples);
  return { ms: median(samples), samples, total: totals[0] };
}

// Measure one role's inner loop + focused gate. `gateFilter` selects what the gate rebuilds:
// an app pushes its own closure (`app...` = the app + its dependencies); a lib author's
// pre-merge gate re-checks dependents (`...lib` = the lib + everything that imports it).
function devLoop({ name, pkg, dir, includeGlobs, gateFilter }) {
  const ts = join(ROOT, `tsconfig.${name}.json`);
  tsconfigs.push(ts);
  writeFileSync(
    ts,
    JSON.stringify({
      extends: "./tsconfig.base.json",
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "preserve",
        noEmit: true,
        declaration: false,
        allowJs: true,
        paths: { "@demo/*": ["./packages/*/src/index.ts"] },
      },
      include: includeGlobs,
    }),
  );
  console.log(`\n## ${name} (${pkg}) — typecheck-on-save / lint-on-save / focused gate`);
  const tsgo = freshVsSubsequent(
    `/usr/bin/time -v ${bin("tsgo")} --noEmit -p tsconfig.${name}.json 2>&1`,
    `${name} tsgo`,
    { mustExitZero: true, captureRss: true },
  );
  const ox = freshVsSubsequent(`${bin("oxlint")} ${dir}`, `${name} oxlint`, { mustExitZero: true });
  const cold = gateMedian("typecheck:tsgo", gateFilter);
  console.log(
    `  ${name} gate cold: ${cold.ms}ms (samples ${cold.samples.join(",")}), ${cold.total} tasks`,
  );
  const warm = gateMedian("typecheck:tsgo", gateFilter, { warm: true });
  console.log(`  ${name} gate warm: ${warm.ms}ms (samples ${warm.samples.join(",")})`);
  return {
    target: pkg,
    typecheckOnSave: {
      tool: "tsgo (from src)",
      freshMs: tsgo.freshMs,
      subsequentMs: tsgo.subsequentMs,
      maxRssMB: tsgo.maxRssMB,
    },
    lintOnSave: { tool: "oxlint", freshMs: ox.freshMs, subsequentMs: ox.subsequentMs },
    focusedGate: {
      tool: "turbo+tsgo",
      filter: gateFilter,
      closureTasks: cold.total,
      coldMs: cold.ms,
      coldSamples: cold.samples,
      warmMs: warm.ms,
      warmSamples: warm.samples,
    },
  };
}

try {
  restoreGi = enterSourceVisible(ROOT);

  result.appDev = devLoop({
    name: "appDev",
    pkg: APPPKG,
    dir: `apps/${APP}`,
    includeGlobs: [`apps/${APP}/**/*.ts`, `apps/${APP}/**/*.tsx`],
    gateFilter: `${APPPKG}...`, // the app + its dependencies (its closure) — pre-push gate
  });
  result.libDev = devLoop({
    name: "libDev",
    pkg: LIBPKG,
    dir: `packages/${LIB}`,
    includeGlobs: [`packages/${LIB}/src/**/*.ts`],
    gateFilter: `...${LIBPKG}`, // the lib + its dependents — pre-merge gate
  });

  result.summary = {
    installFreshMs: installFreshMs,
    installSubsequentMs: installSubsequentMs,
    app: {
      tsgoFresh: result.appDev.typecheckOnSave.freshMs,
      tsgoSubsequent: result.appDev.typecheckOnSave.subsequentMs,
      oxlintSubsequent: result.appDev.lintOnSave.subsequentMs,
      gateCold: result.appDev.focusedGate.coldMs,
      gateWarm: result.appDev.focusedGate.warmMs,
      gateTasks: result.appDev.focusedGate.closureTasks,
    },
    lib: {
      tsgoFresh: result.libDev.typecheckOnSave.freshMs,
      tsgoSubsequent: result.libDev.typecheckOnSave.subsequentMs,
      oxlintSubsequent: result.libDev.lintOnSave.subsequentMs,
      gateCold: result.libDev.focusedGate.coldMs,
      gateWarm: result.libDev.focusedGate.warmMs,
      gateTasks: result.libDev.focusedGate.closureTasks,
    },
  };
  mkdirSync(join(ROOT, "bench"), { recursive: true });
  writeFileSync(join(ROOT, "bench/dev-loop-bench.json"), JSON.stringify(result, null, 2));
  console.log("\n--- bench/dev-loop-bench.json written ---");
  console.log(JSON.stringify(result.summary, null, 2));
} finally {
  restoreAll();
}

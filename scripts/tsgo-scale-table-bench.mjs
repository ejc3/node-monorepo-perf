// tsgo whole-program typecheck cost across the README scaling table's scale points.
//
// The README "Results: Scaling Behavior" table's `typecheck` column is the
// turbo-orchestrated tsc path (`turbo run typecheck` = per-package tsc `--noEmit` behind
// a tsc `^build`, cold then warm-cache). This bench measures the checker the stack
// actually recommends instead: ONE `tsgo --noEmit -p tsconfig.whole.json` process over the
// whole workspace from source (`@demo/*` -> `packages/*/src`), the model
// `optimal-gate-bench.mjs` uses to get its 1.32s number, swept over the SAME scale points
// (200:100 / 1000:200 / 2000:300 / 4000:300, modules 16) so the README table can gain a
// tsgo column that is like-for-like on the tree.
//
// tsgo whole-program keeps no incremental cache, so its cold run IS its steady state:
// there is no warm-cache row to report (the per-package turbo+tsgo path that DOES cache is
// priced separately by optimal-gate-bench.mjs / lib-rev-bench.mjs). Methodology mirrors
// the tsc column: files are OS-cached (a warmup run is discarded first, absorbing binary
// load + first-touch fs), no drop_caches, so tsgo's number sits in the same fs-cache state
// the tsc table was measured in. Each measured sample is a fresh tsgo process; the median
// of TSGO_TABLE_SAMPLES is reported with peak RSS (VmHWM via `/usr/bin/time -v`).
//
// Per scale a valid tree MUST typecheck green (0 errors); a non-green tree or a
// signal-killed tsgo is a harness fault and hard-fails (never recorded as a time). The
// bench regenerates the tree, runs `pnpm install`, and writes tsconfig.whole.json, so it
// is destructive and refuses to run outside a dedicated git worktree; it is core-bound and
// refuses on a loaded box unless TSGO_TABLE_ALLOW_BUSY=1. tsconfig.whole.json is removed on
// exit. Canonical only at the default scales + sample count; any other -> gitignored
// bench/tsgo-scale-table.partial.json.
//
//   node scripts/tsgo-scale-table-bench.mjs
//   TSGO_TABLE_SCALES="200:100" TSGO_TABLE_SAMPLES=1 node scripts/tsgo-scale-table-bench.mjs

import { execSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { availableParallelism, loadavg } from "node:os";

const DEFAULT_SCALES = "200:100 1000:200 2000:300 4000:300";
const DEFAULT_MODULES = 16;
const SCALES_SPEC = (process.env.TSGO_TABLE_SCALES || DEFAULT_SCALES).trim();
const SAMPLES = +(process.env.TSGO_TABLE_SAMPLES || 3);
if (!Number.isInteger(SAMPLES) || SAMPLES < 1) {
  console.error(`TSGO_TABLE_SAMPLES must be a positive integer (got "${process.env.TSGO_TABLE_SAMPLES}")`);
  process.exit(1);
}
const MODULES = +(process.env.MODULES || DEFAULT_MODULES);
if (!Number.isInteger(MODULES) || MODULES < 1) {
  console.error(`MODULES must be a positive integer (got "${process.env.MODULES}")`);
  process.exit(1);
}
const ALLOW_BUSY = process.env.TSGO_TABLE_ALLOW_BUSY === "1";
const ROOT = process.cwd();
// availableParallelism honors cgroup CPU limits (cpus().length reports host cores, which
// would overstate usable parallelism on a constrained CI runner and let a contended run pass).
const CORES = availableParallelism();

const SCALES = SCALES_SPEC.split(/\s+/).map((s) => {
  const m = s.match(/^(\d+):(\d+)$/);
  if (!m) {
    console.error(`bad scale "${s}" — expected <apps>:<libs>`);
    process.exit(1);
  }
  return { label: `${m[1]}:${m[2]}`, apps: +m[1], libs: +m[2] };
});

const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", TURBO_TELEMETRY_DISABLED: "1" };
const sh = (cmd, opts = {}) =>
  execSync(cmd, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 28,
    encoding: "utf8",
    ...opts,
  });

const bin = (name) => join(ROOT, "node_modules", ".bin", name);
const ver = (name) => (existsSync(bin(name)) ? sh(`${bin(name)} --version`).trim() : null);
const WHOLE_TSCONFIG = join(ROOT, "tsconfig.whole.json");
const median = (xs) => {
  if (!xs.length) throw new Error("median of empty sample set");
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Untimed completeness gate: a tsconfig that silently includes nothing also reports 0
// errors, so a vacuously-green config would record a fast false number. Assert tsgo loaded
// EVERY workspace source file that exists on disk (apps/ + packages/*/src, excluding
// node_modules and .next) — not a loose floor, the exact set — so a partial include or a
// truncated --listFiles can't certify the program.
function workspaceSourceOnDisk() {
  // Match tsgo's include globs: apps/*/**/*.ts(x) + packages/*/src/**/*.ts, minus node_modules/.next.
  const out = sh(
    `find apps packages \\( -name node_modules -o -name .next \\) -prune -o -type f \\( -name '*.ts' -o -name '*.tsx' \\) -print`,
  );
  const files = out.split("\n").filter((l) => /^(apps|packages)\//.test(l));
  // packages files are only counted under */src (the include is packages/*/src/**/*.ts).
  return new Set(files.filter((f) => f.startsWith("apps/") || /^packages\/[^/]+\/src\//.test(f)));
}
function assertProgramComplete(apps, libs) {
  const expected = workspaceSourceOnDisk();
  let listing = "";
  try {
    listing = sh(`${bin("tsgo")} --noEmit -p tsconfig.whole.json --listFiles 2>&1`);
  } catch (e) {
    listing = (e.stdout || "") + (e.stderr || "");
    // A signal-killed --listFiles prints a partial list; that must not certify the program.
    const sigLine = listing.match(/Command terminated by signal\s+(\d+)/);
    if (e.signal || (e.status != null && e.status >= 128) || sigLine)
      throw new Error(`--listFiles killed (${e.signal ?? "signal"}) — cannot certify program completeness`);
    // A non-signal non-zero exit (e.g. type errors) still prints the full file list, which is
    // all this gate needs; the green gate below is what fails on actual type errors.
  }
  // Normalize listed paths to workspace-relative and keep only workspace source files.
  const listed = new Set();
  for (const line of listing.split("\n")) {
    const m = line.match(/(?:^|\/)((?:apps|packages)\/[^\s]*\.tsx?)\s*$/);
    if (m && (m[1].startsWith("apps/") || /^packages\/[^/]+\/src\//.test(m[1]))) listed.add(m[1]);
  }
  const missing = [...expected].filter((f) => !listed.has(f));
  if (missing.length)
    throw new Error(
      `completeness gate: tsgo loaded ${listed.size} of ${expected.size} workspace source files at ` +
        `${apps} apps / ${libs} libs; ${missing.length} missing (e.g. ${missing[0]}). ` +
        `The tsconfig include is broken — refusing to record a partial run.`,
    );
  return expected.size;
}

// Destructive (regenerates the tree, overwrites node_modules, writes tsconfig.whole.json):
// a linked worktree's git-dir lives under .../worktrees/. Same guard the generate-and-
// measure benches use.
const gitDir = sh("git rev-parse --git-dir").trim();
if (!gitDir.includes("worktrees")) {
  console.error(
    "refusing to run outside a dedicated git worktree — it regenerates the tree and runs pnpm install.",
  );
  console.error("create one: `git worktree add ~/src/tsgo-scale-table HEAD` and run there.");
  process.exit(1);
}

// Core-bound: tsgo is multithreaded, so a busy box inflates the wall. Refuse unless waived.
const preRunLoadAvg1 = loadavg()[0];
if (!ALLOW_BUSY && preRunLoadAvg1 > CORES / 2) {
  console.error(
    `load average ${preRunLoadAvg1.toFixed(2)} > ${CORES / 2} (half of ${CORES} cores); refusing.`,
  );
  console.error("set TSGO_TABLE_ALLOW_BUSY=1 to override (the wall will be contended).");
  process.exit(1);
}

// tsconfig.whole.json is scratch, never committed — remove it however we exit.
process.on("exit", () => rmSync(WHOLE_TSCONFIG, { force: true }));

const writeWholeTsconfig = () =>
  writeFileSync(
    WHOLE_TSCONFIG,
    JSON.stringify(
      {
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
        include: ["apps/*/**/*.ts", "apps/*/**/*.tsx", "packages/*/src/**/*.ts"],
        exclude: ["node_modules", "**/.next"],
      },
      null,
      2,
    ) + "\n",
  );

// One whole-workspace tsgo run from scratch (no incremental cache). `/usr/bin/time -v`
// writes peak RSS to stderr, merged via 2>&1 so it is captured on a clean (exit 0) run.
function wholeProgram() {
  const t0 = process.hrtime.bigint();
  let ok = true;
  let out = "";
  try {
    out = sh(`/usr/bin/time -v ${bin("tsgo")} --noEmit -p tsconfig.whole.json 2>&1`);
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
    // A signal-killed tsgo is a harness fault, not a type-error verdict. /usr/bin/time
    // turns a child's signal death into exit 128+signo (e.signal stays null), so detect it
    // numerically AND via GNU time's marker line and hard-fail.
    const sigLine = out.match(/Command terminated by signal\s+(\d+)/);
    if (e.signal || (e.status != null && e.status >= 128) || sigLine) {
      const how = e.signal ?? (sigLine ? `signal ${sigLine[1]}` : `exit ${e.status}`);
      throw new Error(`tsgo killed (${how}) — a crashed checker is a harness fault: ${out.slice(-800)}`);
    }
    ok = false;
  }
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const rssKb = +(out.match(/Maximum resident set size \(kbytes\): (\d+)/) || [])[1] || null;
  return {
    ms,
    ok,
    maxRssMB: rssKb ? Math.round(rssKb / 1024) : null,
    errors: (out.match(/error TS\d+/g) || []).length,
    sample: (out.match(/error TS\d+[^\n]*/) || [])[0] || null,
  };
}

const results = [];
for (const { label, apps, libs } of SCALES) {
  console.log(`\n# ${label}: ${apps} apps / ${libs} libs, ${MODULES} modules`);
  // Pin every tree-shape flag explicitly (generate.mjs reads no env; these match its
  // defaults and the tsc table's tree: plain graph, next framework, non-versioned).
  sh(
    `node scripts/generate.mjs --apps ${apps} --libs ${libs} --modules ${MODULES} --app-deps 4 --lib-deps 3 --layers 6 --clean`,
    { stdio: "inherit" },
  );
  // Untimed: node_modules is needed for next/react type resolution, and this is the same
  // install path (pnpm, catalog specs) the tsc table's tree used.
  console.log(`  pnpm install ...`);
  sh(`pnpm install --prefer-offline --config.confirmModulesPurge=false`, { stdio: "inherit" });
  writeWholeTsconfig();

  const programFileCount = assertProgramComplete(apps, libs); // untimed completeness gate
  console.log(`  program: ${programFileCount} workspace source files (all loaded)`);
  const loadAvg1 = loadavg()[0];
  wholeProgram(); // warmup, discarded (binary load + first-touch fs)
  const runs = [];
  for (let i = 0; i < SAMPLES; i++) {
    const r = wholeProgram();
    if (!r.ok || r.errors > 0)
      throw new Error(
        `whole-program tsgo must be green on a valid ${label} tree — got ${r.errors} errors` +
          (r.sample ? ` (sample: ${r.sample})` : ` (exit non-zero, no TS error parsed)`),
      );
    if (r.maxRssMB == null) throw new Error(`peak RSS not captured — is /usr/bin/time GNU time -v?`);
    runs.push(r);
    console.log(`  sample ${i + 1}/${SAMPLES}: ${r.ms}ms, ${r.maxRssMB}MB`);
  }
  const rec = {
    label,
    apps,
    libs,
    modules: MODULES,
    samples: SAMPLES,
    programFiles: programFileCount,
    preRunLoadAvg1: loadAvg1,
    coldMedianMs: median(runs.map((r) => r.ms)),
    coldMs: runs.map((r) => r.ms),
    maxRssMB: Math.max(...runs.map((r) => r.maxRssMB)),
    rssSamplesMB: runs.map((r) => r.maxRssMB),
  };
  results.push(rec);
  console.log(`  => median ${rec.coldMedianMs}ms, peak ${rec.maxRssMB}MB`);
}

const canonical = SCALES_SPEC === DEFAULT_SCALES && SAMPLES === 3 && MODULES === DEFAULT_MODULES;
const out = {
  measures:
    "whole-program tsgo cold typecheck (one `tsgo --noEmit` over @demo/*->src), swept over the README scaling-table scales; no incremental cache so cold is steady state",
  tsc_column_note:
    "the README table's tsc `typecheck` column is turbo-orchestrated tsc (build + tsc --noEmit), cold then warm-cache; this tsgo column is one whole-program process, cold only",
  versions: { tsgo: ver("tsgo"), node: process.version, pnpm: sh(`pnpm --version`).trim() },
  cores: CORES,
  preRunLoadAvg1,
  scales: results,
};
const dir = join(ROOT, "bench");
mkdirSync(dir, { recursive: true });
const file = join(dir, canonical ? "tsgo-scale-table.json" : "tsgo-scale-table.partial.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${file}${canonical ? "" : " (partial: non-default scales/samples)"}`);

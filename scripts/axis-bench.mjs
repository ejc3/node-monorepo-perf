#!/usr/bin/env node
// Decompose scaling along each axis separately, because in the real world apps
// grow fast and shared libs grow slowly. Two sweeps share a corner (200 apps /
// 100 libs):
//   apps axis: libs fixed at 100, apps in {200, 500, 1000}
//   libs axis: apps fixed at 200, libs in {50, 100, 150, 300}
//
// Per point: clean install, then time the operations and record the graph sizes.
// The question it answers: which operations scale with #apps, which with #libs?
// (Hypothesis: focus build + its closure track LIBS, not apps; whole-repo
// install/typecheck track total packages = apps + libs.)
//
//   node scripts/axis-bench.mjs

import { spawnSync } from "node:child_process";
import {
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  openSync,
  closeSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { enterSourceVisible } from "./_source-visible.mjs";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const LOGFILE = "/tmp/axis-bench.log";
// TURBO_CACHE_DIR pins Turbo's cache inside this working tree so clearTurbo's
// `rm -rf .turbo` actually clears it (in a git worktree Turbo would otherwise
// cache in the primary worktree, making "cold" runs stale cache hits).
const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  TURBO_CACHE_DIR: join(REPO, ".turbo", "cache"),
};

// unique points; corner (200,100) is shared by both axes
const POINTS = [
  { apps: 200, libs: 100, axis: "corner" },
  { apps: 500, libs: 100, axis: "apps" },
  { apps: 1000, libs: 100, axis: "apps" },
  { apps: 200, libs: 50, axis: "libs" },
  { apps: 200, libs: 150, axis: "libs" },
  { apps: 200, libs: 300, axis: "libs" },
];

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 27, env });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${(r.stderr || "").slice(-1000)}`);
  return r.stdout || "";
}
function timed(cmd, args) {
  const logFd = openSync(LOGFILE, "w");
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { cwd: REPO, stdio: ["ignore", logFd, logFd], env });
  closeSync(logFd);
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")} failed:\n${(existsSync(LOGFILE) ? readFileSync(LOGFILE, "utf8") : "").slice(-1500)}`,
    );
  return Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
}
const clearTurbo = () => {
  rmSync(join(REPO, ".turbo"), { recursive: true, force: true });
  rmSync(join(REPO, "node_modules/.cache/turbo"), { recursive: true, force: true });
};
const dry = (filter) => {
  const o = sh("pnpm", [
    "exec",
    "turbo",
    "run",
    "build",
    ...(filter ? [`--filter=${filter}`] : []),
    "--dry=json",
  ]);
  const j = JSON.parse(o);
  return j.packages?.length ?? null;
};

// Walk up from a package dir resolving a dependency, stopping at the repo root —
// the workspace-root node_modules is the last valid hop.
function resolvesFrom(dir, dep) {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, "node_modules", dep, "package.json"))) return true;
    if (d === REPO) return false;
    const u = dirname(d);
    if (u === d) return false;
    d = u;
  }
}
// Fail loud on a silently-partial install: every package under apps/* and
// packages/* must resolve all its deps (incl. devDependencies). Otherwise turbo
// would treat missing packages as no-ops/cache-hits and record an artificially
// low scaling point.
function verifyComplete() {
  const missing = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(REPO, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, name);
      const pj = join(pkgDir, "package.json");
      if (!existsSync(pj)) continue;
      const pkg = JSON.parse(readFileSync(pj, "utf8"));
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
    throw new Error(`INCOMPLETE install, unresolved deps:\n${missing.slice(0, 10).join("\n")}`);
  }
}

// pre-warm the global store so every measured install is warm-store (no network),
// not a cache-order artifact of whichever point ran first.
sh("node", [
  "scripts/generate.mjs",
  "--apps",
  "200",
  "--libs",
  "100",
  "--modules",
  "16",
  "--clean",
]);
rmSync(join(REPO, "node_modules"), { recursive: true, force: true });
rmSync(join(REPO, "pnpm-lock.yaml"), { force: true });
sh("pnpm", ["install", "--config.confirm-modules-purge=false"]);

// make generated source visible to Turbo (tracked source, ignored build outputs)
// so warm-cache/graph numbers reflect real per-file hashing. Restored on exit.
enterSourceVisible(REPO);

const out = [];
for (const { apps, libs, axis } of POINTS) {
  const appW = String(apps).length;
  const mid = `@demo/app-${String(Math.floor(apps / 2)).padStart(appW, "0")}`;

  sh("node", [
    "scripts/generate.mjs",
    "--apps",
    String(apps),
    "--libs",
    String(libs),
    "--modules",
    "16",
    "--clean",
  ]);
  rmSync(join(REPO, "node_modules"), { recursive: true, force: true });
  rmSync(join(REPO, "pnpm-lock.yaml"), { force: true });
  const installMs = timed("pnpm", ["install", "--config.confirm-modules-purge=false"]);
  verifyComplete(); // abort if the install silently dropped packages (not counted in installMs)

  const totalTasks = dry(null);
  const focusClosure = dry(`${mid}...`);

  clearTurbo();
  const tcColdMs = timed("pnpm", [
    "exec",
    "turbo",
    "run",
    "typecheck",
    "--concurrency=100%",
    "--cache=local:rw",
    "--output-logs=errors-only",
  ]);
  clearTurbo();
  const focusMs = timed("pnpm", [
    "exec",
    "turbo",
    "run",
    "build",
    `--filter=${mid}...`,
    "--concurrency=100%",
    "--cache=local:rw",
    "--output-logs=errors-only",
  ]);
  // Source is visible to git (enterSourceVisible) while build outputs stay
  // ignored, so plain prune (respecting .gitignore) copies the source subtree and
  // skips .next/dist/node_modules.
  rmSync(join(REPO, "out"), { recursive: true, force: true });
  const pruneMs = timed("pnpm", ["exec", "turbo", "prune", mid, "--docker"]);

  const rec = { apps, libs, axis, totalTasks, focusClosure, installMs, tcColdMs, focusMs, pruneMs };
  out.push(rec);
  mkdirSync(join(REPO, "bench"), { recursive: true });
  writeFileSync(join(REPO, "bench/axis-bench.json"), JSON.stringify(out, null, 2));
  console.log(
    `apps=${apps} libs=${libs} [${axis}]: install ${(installMs / 1000).toFixed(0)}s · tc cold ${(tcColdMs / 1000).toFixed(1)}s · focus ${(focusMs / 1000).toFixed(1)}s (closure ${focusClosure}/${totalTasks}) · prune ${(pruneMs / 1000).toFixed(1)}s`,
  );
}
console.log("--- bench/axis-bench.json written ---");

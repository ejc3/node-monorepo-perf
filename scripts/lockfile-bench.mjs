#!/usr/bin/env node
// Decompose install into its whole-workspace parts for BOTH pnpm and bun, per scale:
//   resolve  = `install --lockfile-only`  (resolve all manifests + write the lockfile;
//              NO node_modules) — the irreducibly O(repo) part
//   verify   = `install --lockfile-only` again with the lockfile present
//   full     = plain `install`            (resolve + materialize node_modules)
// Also records lockfile size (lines, bytes). resolveSharePct = resolve / full.
//
//   node scripts/lockfile-bench.mjs "200:100 1000:200 2000:300"
//
// Runs in an isolated, decataloged workspace (bun ignores pnpm-workspace.yaml and
// catalog:, so we give it a package.json "workspaces" field + concrete versions —
// the same dependency set both tools resolve). Child output -> log file; failures
// throw with the log tail.

import { spawnSync } from "node:child_process";
import {
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  openSync,
  closeSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DIR = "/tmp/lockfile-bench";
const BUN = join(homedir(), ".bun/bin/bun");
const LOGFILE = "/tmp/lockfile-bench.log";
const SCALES = (process.argv[2] || "200:100 1000:200 2000:300")
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
function timed(cmd, args) {
  const logFd = openSync(LOGFILE, "w");
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { cwd: DIR, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")} failed:\n${(existsSync(LOGFILE) ? readFileSync(LOGFILE, "utf8") : "").slice(-1500)}`,
    );
  return Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
}
function lockSize(file) {
  const p = join(DIR, file);
  if (!existsSync(p)) return { lines: null, bytes: null };
  const b = readFileSync(p);
  return { lines: (b.toString().match(/\n/g) || []).length, bytes: b.length };
}
// The resolve phase must write a real lockfile. The workspace always carries the
// catalog's external deps (next/react/typescript/vite/...) plus their transitive
// closure, so a healthy lockfile is hundreds of lines; a missing file (lockSize ->
// null) or a trivial one means resolve produced nothing and the clean resolveMs
// would read a failure as success.
const LOCK_FLOOR = 50;
function assertLockResolved(tool, file, lock) {
  if (!Number.isFinite(lock.lines) || lock.lines < LOCK_FLOOR)
    throw new Error(
      `${tool} resolve produced no/trivial ${file} (${lock.lines} lines, floor ${LOCK_FLOOR})`,
    );
}
// Resolve `dep` from `dir` by walking node_modules upward, STOPPING at the
// benchmark workspace root (DIR) — an ambient parent node_modules must not
// satisfy verification for an incomplete install.
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
// After a full install, every package under apps/* and packages/* must resolve
// all its declared deps (incl. devDependencies) in node_modules — so a partial
// install can't record a fast, clean fullMs. Throws if any dep is missing.
function verifyComplete() {
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
  for (const pkgDir of pkgDirs) {
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const deps = [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
    ];
    for (const dep of deps) {
      if (!resolvesFrom(pkgDir, dep) && missing.length < 20) missing.push(`${pkgDir} -> ${dep}`);
    }
  }
  if (missing.length)
    throw new Error(`INCOMPLETE install, unresolved deps:\n${missing.slice(0, 10).join("\n")}`);
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
    JSON.stringify({ name: "lf-bench", private: true, workspaces: ["apps/*", "packages/*"] }) +
      "\n",
  );
}
const rmAll = () => {
  // full-tree cleanup (root + every per-package node_modules) so pnpm's per-app
  // trees can't contaminate the next (bun) install's timing; throw on failure.
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
  for (const f of ["pnpm-lock.yaml", "bun.lock", "bun.lockb"])
    rmSync(join(DIR, f), { force: true });
};
const PI = "--config.confirm-modules-purge=false";

// pre-warm pnpm + bun store/metadata so resolve and full both run against a warm
// cache — otherwise resolve (run first) warms it for full and skews resolveSharePct.
setup(SCALES[0].apps, SCALES[0].libs);
rmAll();
timed("pnpm", ["install", PI]);
rmAll();
timed(BUN, ["install"]);

const out = [];
for (const { apps, libs } of SCALES) {
  setup(apps, libs);

  rmAll();
  const pResolve = timed("pnpm", ["install", "--lockfile-only", PI]);
  const pLock = lockSize("pnpm-lock.yaml");
  assertLockResolved("pnpm", "pnpm-lock.yaml", pLock);
  const pVerify = timed("pnpm", ["install", "--lockfile-only", PI]);
  rmAll();
  const pFull = timed("pnpm", ["install", PI]);
  verifyComplete();

  rmAll();
  const bResolve = timed(BUN, ["install", "--lockfile-only"]);
  const bLockFile = existsSync(join(DIR, "bun.lock")) ? "bun.lock" : "bun.lockb";
  const bLock = lockSize(bLockFile);
  assertLockResolved("bun", bLockFile, bLock);
  rmAll();
  const bFull = timed(BUN, ["install"]);
  verifyComplete();

  const rec = {
    apps,
    libs,
    pnpm: {
      resolveMs: pResolve,
      verifyMs: pVerify,
      fullMs: pFull,
      lockLines: pLock.lines,
      lockBytes: pLock.bytes,
      resolveSharePct: Math.round((pResolve / pFull) * 100),
    },
    bun: {
      resolveMs: bResolve,
      fullMs: bFull,
      lockLines: bLock.lines,
      lockBytes: bLock.bytes,
      resolveSharePct: Math.round((bResolve / bFull) * 100),
    },
  };
  out.push(rec);
  mkdirSync(join(REPO, "bench"), { recursive: true });
  writeFileSync(join(REPO, "bench/lockfile-bench.json"), JSON.stringify(out, null, 2));
  console.log(`${apps}/${libs}:`);
  console.log(
    `  pnpm  resolve ${pResolve}ms verify ${pVerify}ms full ${pFull}ms (resolve ${rec.pnpm.resolveSharePct}% of full) lock ${pLock.lines} lines`,
  );
  console.log(
    `  bun   resolve ${bResolve}ms             full ${bFull}ms (resolve ${rec.bun.resolveSharePct}% of full) lock ${bLock.lines} lines`,
  );
}
console.log("--- bench/lockfile-bench.json written ---");

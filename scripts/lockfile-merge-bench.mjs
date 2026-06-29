#!/usr/bin/env node
// Show-don't-tell for the lockfile claims in OPTIMIZATIONS.md §1.3/§1.5 and the
// Vercel/pnpm "lockfile at scale" story. Each demo is a real git + pnpm run; we
// report what actually happened, not what the docs say should.
//
//   1. Churn magnitude    — add ONE dep to ONE app; how many lockfile lines move?
//   2. Catalog shield     — bump a catalog version; how many package.json files
//                           change (0) vs the same bump pinned per-app (N)?
//   3. Merge auto-resolve — two branches bump the same catalog dep to different
//                           versions; does git conflict pnpm-lock.yaml, and does
//                           `pnpm install` then resolve it? (pnpm.io/git claim)
//   4. Branch lockfiles   — does gitBranchLockfile produce a per-branch lockfile?
//
//   node scripts/lockfile-merge-bench.mjs            # default 200:50
//   node scripts/lockfile-merge-bench.mjs 500:80
//
// Uses `pnpm install --lockfile-only` (no node_modules) for speed. Needs network
// to resolve. Writes bench/lockfile-merge-bench.json. Self-contained in /tmp.

import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const [a, l] = (process.argv[2] || "200:50").split(":");
const APPS = +a;
const LIBS = +l;
if (!Number.isInteger(APPS) || !Number.isInteger(LIBS) || APPS < 4 || LIBS < 1) {
  throw new Error(`scale must be "<apps>:<libs>" (apps>=4); got "${process.argv[2]}"`);
}

const DIR = "/tmp/lockfile-merge-bench";
const LF = "pnpm-lock.yaml";
const WS = "pnpm-workspace.yaml";
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", TURBO_TELEMETRY_DISABLED: "1" };

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 27, env, cwd: DIR, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.code || r.error.message}`);
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")} (status ${r.status}):\n${(r.stderr || "").slice(-800)}`,
    );
  return r.stdout || "";
}
// git that tolerates non-zero (e.g. merge conflict); returns {status, stdout}
function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 27, env, cwd: DIR });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const lockfileOnly = () =>
  sh("pnpm", ["install", "--lockfile-only", "--config.confirm-modules-purge=false"]);
const lockLines = () => readFileSync(join(DIR, LF), "utf8").split("\n").length;
// added+removed lines for a path vs HEAD
function diffLines(path) {
  const r = git(["diff", "--numstat", "--", path]);
  let add = 0,
    del = 0;
  for (const line of r.out.trim().split("\n").filter(Boolean)) {
    const [aa, dd] = line.split("\t");
    add += Number(aa) || 0;
    del += Number(dd) || 0;
  }
  return { added: add, removed: del };
}
const changedManifests = () =>
  git(["diff", "--name-only", "--", "apps/**/package.json", "packages/**/package.json"])
    .out.trim()
    .split("\n")
    .filter(Boolean).length;
// rewrite one catalog entry in pnpm-workspace.yaml (`  <dep>: <version>`)
function setCatalog(dep, version) {
  const p = join(DIR, WS);
  const text = readFileSync(p, "utf8");
  const re = new RegExp(`^(\\s*"?${dep.replace(/[/@-]/g, "\\$&")}"?:\\s*).*$`, "m");
  if (!re.test(text)) throw new Error(`catalog entry for ${dep} not found in ${WS}`);
  writeFileSync(p, text.replace(re, `$1${version}`));
}
const resetHard = () => {
  git(["checkout", "-f", "base"]);
  git(["clean", "-fdq"]);
};

function setup() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  sh("node", [
    join(REPO, "scripts/generate.mjs"),
    "--apps",
    String(APPS),
    "--libs",
    String(LIBS),
    "--modules",
    "6",
    "--clean",
  ]);
  // Keep the generated catalog:/workspace:* specs — they are pnpm-native, and the
  // catalog is the whole point of demos 2-3. (Do NOT run rewrite-protocols here;
  // that materializes catalog:->concrete for the bun/deploy path and would defeat
  // the catalog test.) Copy the repo's pnpm-workspace.yaml so catalog: resolves.
  copyFileSync(join(REPO, "pnpm-workspace.yaml"), join(DIR, WS));
  const pkgVer = sh("pnpm", ["--version"]).trim();
  writeFileSync(
    join(DIR, "package.json"),
    JSON.stringify({ name: "lf-bench", private: true, packageManager: `pnpm@${pkgVer}` }) + "\n",
  );
  writeFileSync(join(DIR, ".gitignore"), "node_modules\n");
  lockfileOnly();
  sh("git", ["init", "-q"]);
  sh("git", ["config", "user.email", "bench@example.com"]);
  sh("git", ["config", "user.name", "bench"]);
  sh("git", ["add", "-A"]);
  sh("git", ["commit", "-q", "-m", "base"]);
  sh("git", ["branch", "-M", "base"]);
}

setup();
const out = {
  apps: APPS,
  libs: LIBS,
  pnpm: sh("pnpm", ["--version"]).trim(),
  baselineLockfileLines: lockLines(),
};

// --- 1. churn from adding one dependency to one app ---
{
  const app = join("apps", `app-${String(1).padStart(String(APPS).length, "0")}`, "package.json");
  const pj = JSON.parse(readFileSync(join(DIR, app), "utf8"));
  pj.dependencies = { ...pj.dependencies, nanoid: "^5.0.0" };
  writeFileSync(join(DIR, app), JSON.stringify(pj, null, 2) + "\n");
  lockfileOnly();
  out.churnOneDep = { dep: "nanoid", appsChanged: changedManifests(), lockfile: diffLines(LF) };
  resetHard();
}

// --- 2. catalog shields manifests vs per-app pinning ---
{
  setCatalog("typescript", "5.8.3"); // was ^5.9.0; one catalog line
  lockfileOnly();
  out.catalogBump = {
    dep: "typescript 5.9->5.8.3 via catalog",
    manifestsChanged: changedManifests(), // expect 0 — apps say "catalog:"
    workspaceYamlChanged: diffLines(WS).added + diffLines(WS).removed,
    lockfile: diffLines(LF),
  };
  resetHard();

  // contrast: pin the same version directly in 25 apps (no catalog) → per-app churn
  const N = Math.min(25, APPS);
  for (let i = 1; i <= N; i++) {
    const app = join(
      DIR,
      "apps",
      `app-${String(i).padStart(String(APPS).length, "0")}`,
      "package.json",
    );
    const pj = JSON.parse(readFileSync(app, "utf8"));
    pj.devDependencies = { ...pj.devDependencies, typescript: "5.8.3" }; // pinned, off-catalog
    writeFileSync(app, JSON.stringify(pj, null, 2) + "\n");
  }
  lockfileOnly();
  out.pinnedBump = {
    dep: "typescript 5.8.3 pinned in N apps",
    apps: N,
    manifestsChanged: changedManifests(),
    lockfile: diffLines(LF),
  };
  resetHard();
}

// --- 3. merge conflict + pnpm auto-resolve (pnpm.io/git) ---
{
  git(["checkout", "-q", "-b", "lf-a", "base"]);
  setCatalog("typescript", "5.8.3");
  lockfileOnly();
  sh("git", ["commit", "-aqm", "bump ts 5.8.3"]);

  git(["checkout", "-q", "-b", "lf-b", "base"]);
  setCatalog("typescript", "5.7.3");
  lockfileOnly();
  sh("git", ["commit", "-aqm", "bump ts 5.7.3"]);

  git(["checkout", "-q", "lf-a"]);
  const merge = git(["merge", "--no-edit", "lf-b"]);
  const conflicted = git(["diff", "--name-only", "--diff-filter=U"])
    .out.trim()
    .split("\n")
    .filter(Boolean);
  const lockConflictMarkers = (readFileSync(join(DIR, LF), "utf8").match(/^<<<<<<< /gm) || [])
    .length;
  // resolve the small source conflict (pick one catalog version), then let pnpm
  // fix the lockfile — the documented "just run pnpm install".
  git(["checkout", "--ours", "--", WS]);
  git(["add", "--", WS]);
  lockfileOnly();
  const markersAfter = (readFileSync(join(DIR, LF), "utf8").match(/^<<<<<<< /gm) || []).length;
  out.mergeAutoResolve = {
    mergeExitNonZero: merge.status !== 0,
    conflictedFiles: conflicted,
    lockfileConflicted: conflicted.includes(LF),
    lockfileConflictMarkersBefore: lockConflictMarkers,
    lockfileConflictMarkersAfterPnpmInstall: markersAfter,
    pnpmResolvedLockfile: lockConflictMarkers > 0 && markersAfter === 0,
  };
  resetHard();
  git(["branch", "-D", "lf-a"]);
  git(["branch", "-D", "lf-b"]);
}

// --- 4. git branch lockfiles ---
{
  git(["checkout", "-q", "-b", "feature-x", "base"]);
  writeFileSync(join(DIR, ".npmrc"), "git-branch-lockfile=true\n");
  setCatalog("typescript", "5.8.3"); // a real change so pnpm writes a (branch) lockfile
  lockfileOnly();
  const branchLf = sh("bash", ["-c", `ls pnpm-lock.*.yaml 2>/dev/null || true`]).trim();
  out.gitBranchLockfile = {
    setting: ".npmrc git-branch-lockfile=true",
    perBranchLockfile: branchLf || null,
    created: !!branchLf,
  };
  resetHard();
  rmSync(join(DIR, ".npmrc"), { force: true });
  git(["branch", "-D", "feature-x"]);
}

mkdirSync(join(REPO, "bench"), { recursive: true });
writeFileSync(join(REPO, "bench/lockfile-merge-bench.json"), JSON.stringify(out, null, 2));
rmSync(DIR, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 2));

// This is a verification artifact backing the docs — fail loud if any demo did not
// behave as claimed (don't just record a regressed result).
const checks = [
  ["catalog shields manifests (0 changed)", out.catalogBump.manifestsChanged === 0],
  ["catalog bump propagates to the lockfile", out.catalogBump.lockfile.added > 0],
  ["pinning/skew edits per-app manifests", out.pinnedBump.manifestsChanged === out.pinnedBump.apps],
  ["adding a dep churns the lockfile", out.churnOneDep.lockfile.added > 0],
  [
    "a real merge conflicts the lockfile",
    out.mergeAutoResolve.mergeExitNonZero &&
      out.mergeAutoResolve.lockfileConflicted &&
      out.mergeAutoResolve.lockfileConflictMarkersBefore > 0,
  ],
  [
    "pnpm install resolves the lockfile conflict",
    out.mergeAutoResolve.pnpmResolvedLockfile === true,
  ],
  ["git branch lockfile created", out.gitBranchLockfile.created === true],
];
const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  throw new Error(`lockfile-merge-bench: demonstrations regressed:\n- ${failed.join("\n- ")}`);
}

#!/usr/bin/env node
// Answer "what does an install actually cost, depending on the situation?" by
// timing the three real modes against one workspace:
//
//   A. cold-resolve   no lockfile present  -> pnpm install (resolve + link).
//                     This is authoring the lockfile: a fresh repo, or a dep change.
//   B. frozen, warm   lockfile present, node_modules absent, store warm ->
//                     pnpm install --frozen-lockfile (skip resolve, just link).
//                     This is a returning machine / CI with a cached store.
//   C. frozen, cold   lockfile present, node_modules absent, FRESH store ->
//                     frozen install into an empty store (download + link, no resolve).
//                     This is a brand-new CI runner with no store cache.
//
//   node scripts/install-modes-bench.mjs            # default 1000:200
//
// Writes bench/install-modes-bench.json. Self-contained in /tmp.

import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const [a, l] = (process.argv[2] || "1000:200").split(":");
const APPS = +a;
const LIBS = +l;
if (!Number.isInteger(APPS) || !Number.isInteger(LIBS) || APPS < 1 || LIBS < 1) {
  throw new Error(`scale must be "<apps>:<libs>"; got "${process.argv[2]}"`);
}
const DIR = "/tmp/install-modes-bench";
const LF = join(DIR, "pnpm-lock.yaml");
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
const PNPM_VER = sh("pnpm", ["--version"], { cwd: REPO }).trim();
const rmNM = () =>
  sh("bash", [
    "-c",
    `set -euo pipefail; find ${JSON.stringify(DIR)} -name node_modules -type d -prune -exec rm -rf {} +`,
  ]);
function timed(args) {
  const t0 = process.hrtime.bigint();
  sh("pnpm", args);
  return Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
}

// setup: pnpm-native catalog/workspace specs (no rewrite)
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
sh("node", [
  join(REPO, "scripts/generate.mjs"),
  "--apps",
  String(APPS),
  "--libs",
  String(LIBS),
  "--modules",
  "8",
  "--clean",
]);
copyFileSync(join(REPO, "pnpm-workspace.yaml"), join(DIR, "pnpm-workspace.yaml"));
writeFileSync(
  join(DIR, "package.json"),
  JSON.stringify({ name: "im-bench", private: true, packageManager: `pnpm@${PNPM_VER}` }) + "\n",
);
writeFileSync(join(DIR, ".gitignore"), "node_modules\n");

const PI = "--config.confirm-modules-purge=false";
// author the lockfile + warm the default store (discarded)
sh("pnpm", ["install", PI]);
const lockLines = readFileSync(LF, "utf8").split("\n").length;

// B. frozen, warm store
rmNM();
const frozenWarmMs = timed(["install", "--frozen-lockfile", PI]);

// C. frozen, cold store (fresh empty store dir → must download)
rmNM();
const coldStore = join(DIR, ".cold-store");
const frozenColdStoreMs = timed([
  "install",
  "--frozen-lockfile",
  `--config.store-dir=${coldStore}`,
  PI,
]);

// A. cold-resolve (no lockfile; store still warm so this isolates the resolve)
rmNM();
rmSync(LF, { force: true });
const coldResolveMs = timed(["install", PI]);

// After A, the lockfile + node_modules are present again. Now the case that
// actually matters: a DEPENDENCY CHANGE against the existing lockfile. pnpm should
// reuse the locked versions and only re-resolve the delta (incremental), not redo
// the from-scratch resolve.
// D. add one new dependency to one app
const oneApp = join(
  DIR,
  "apps",
  `app-${String(1).padStart(String(APPS).length, "0")}`,
  "package.json",
);
const oneAppPkg = JSON.parse(readFileSync(oneApp, "utf8"));
oneAppPkg.dependencies = { ...oneAppPkg.dependencies, nanoid: "^5.0.0" };
writeFileSync(oneApp, JSON.stringify(oneAppPkg, null, 2) + "\n");
const depChangeAddOneMs = timed(["install", PI]);
// E. bump one catalog version (a shared dep used by every package)
const wsPath = join(DIR, "pnpm-workspace.yaml");
writeFileSync(wsPath, readFileSync(wsPath, "utf8").replace(/^(\s*typescript:\s*).*$/m, "$15.8.3"));
const depChangeCatalogBumpMs = timed(["install", PI]);

const out = {
  apps: APPS,
  libs: LIBS,
  pnpm: PNPM_VER,
  lockfileLines: lockLines,
  coldResolveMs, // no lockfile: full resolve + link (authoring the lockfile)
  frozenWarmMs, // lockfile present, store warm: link only (returning machine / cached CI)
  frozenColdStoreMs, // lockfile present, empty store: download + link (brand-new CI runner)
  depChangeAddOneMs, // +1 dep, lockfile present: incremental re-resolve + link
  depChangeCatalogBumpMs, // bump a shared catalog version, lockfile present: incremental re-resolve
  frozenWarmPctOfCold: +((frozenWarmMs / coldResolveMs) * 100).toFixed(1),
  depChangeAddPctOfCold: +((depChangeAddOneMs / coldResolveMs) * 100).toFixed(1),
};
mkdirSync(join(REPO, "bench"), { recursive: true });
writeFileSync(join(REPO, "bench/install-modes-bench.json"), JSON.stringify(out, null, 2));
rmSync(DIR, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 2));
console.log(
  `\n${APPS}/${LIBS}:\n` +
    `  cold-resolve (no lockfile)        ${(coldResolveMs / 1000).toFixed(1)}s\n` +
    `  dep change: +1 dep (lockfile present) ${(depChangeAddOneMs / 1000).toFixed(1)}s (${out.depChangeAddPctOfCold}% of cold)\n` +
    `  dep change: catalog bump          ${(depChangeCatalogBumpMs / 1000).toFixed(1)}s\n` +
    `  frozen, warm store                ${(frozenWarmMs / 1000).toFixed(1)}s (${out.frozenWarmPctOfCold}% of cold)\n` +
    `  frozen, cold store                ${(frozenColdStoreMs / 1000).toFixed(1)}s`,
);

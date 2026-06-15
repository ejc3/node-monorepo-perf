#!/usr/bin/env node
// Verify two "focused install" claims live, instead of trusting the issue
// trackers (OPTIMIZATIONS.md §1.4 / §4.1 / §5):
//
//   A. Does `pnpm install --filter <app>...` actually scope, or does the shared
//      workspace lockfile make it materialize the whole workspace? We count how
//      many apps get a node_modules tree under a filtered install vs a full one.
//   B. Does `turbo prune <app> --docker` produce a COMPLETE, buildable subtree?
//      We check every internal package in the app's closure is present in
//      out/full, then actually `pnpm install --frozen-lockfile` + build it.
//
//   node scripts/focus-install-bench.mjs            # default 80:25
//   node scripts/focus-install-bench.mjs 120:40
//
// Writes bench/focus-install-bench.json. Runs in /tmp (ext4), self-contained.

import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
// The bare temp workspace has no turbo of its own; drive it with the repo's turbo.
const TURBO = join(REPO, "node_modules", ".bin", "turbo");
const [a, l] = (process.argv[2] || "80:25").split(":");
const APPS = +a;
const LIBS = +l;
if (!Number.isInteger(APPS) || !Number.isInteger(LIBS) || APPS < 2 || LIBS < 1) {
  throw new Error(`scale must be "<apps>:<libs>" (apps>=2); got "${process.argv[2]}"`);
}

const DIR = "/tmp/focus-install-bench";
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", TURBO_TELEMETRY_DISABLED: "1" };

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 27, env, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.code || r.error.message}`);
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")} failed (status ${r.status}):\n${(r.stderr || "").slice(-1200)}`,
    );
  return r.stdout || "";
}
function statInt(script, cwd) {
  const out = sh("bash", ["-c", `set -o pipefail; ${script}`], { cwd }).trim();
  if (!/^\d+$/.test(out)) throw new Error(`stat not an integer: "${out}" (${script})`);
  return parseInt(out, 10);
}
// count of <group>/*/node_modules dirs that exist (isolated linker gives each
// installed package its own node_modules)
const nmCount = (group) =>
  statInt(`find ${join(DIR, group)} -mindepth 2 -maxdepth 2 -name node_modules -type d | wc -l`);
const rmTrees = () =>
  sh("bash", [
    "-c",
    `set -o pipefail; find ${JSON.stringify(DIR)} -name node_modules -type d -prune -exec rm -rf {} + ; rm -f ${JSON.stringify(join(DIR, "pnpm-lock.yaml"))}`,
  ]);

function setup() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  sh(
    "node",
    [
      join(REPO, "scripts/generate.mjs"),
      "--apps",
      String(APPS),
      "--libs",
      String(LIBS),
      "--modules",
      "8",
      "--clean",
    ],
    { cwd: DIR },
  );
  for (const dir of ["apps", "packages"]) {
    sh(
      "node",
      [
        join(REPO, "scripts/rewrite-protocols.mjs"),
        "--dir",
        dir,
        "--catalog",
        join(REPO, "pnpm-workspace.yaml"),
      ],
      { cwd: DIR },
    );
  }
  writeFileSync(join(DIR, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  writeFileSync(
    join(DIR, "package.json"),
    JSON.stringify({ name: "focus-bench", private: true, packageManager: `pnpm@${PNPM_VER}` }) +
      "\n",
  );
  // turbo + base tsconfig are root configs generate.mjs doesn't emit into a bare dir
  for (const f of ["turbo.json", "tsconfig.base.json"]) {
    if (existsSync(join(REPO, f))) copyFileSync(join(REPO, f), join(DIR, f));
  }
}

// internal package closure of `app` (app + the libs it transitively needs)
function closure(app) {
  const o = sh(TURBO, ["run", "build", `--filter=${app}...`, "--dry=json"], { cwd: DIR });
  const j = JSON.parse(o);
  const pkgs = j.packages;
  if (!Array.isArray(pkgs)) throw new Error("turbo --dry=json returned no packages[]");
  // packages[] may include "//" (the workspace root); keep only @demo/* names
  return pkgs.filter((p) => p.startsWith("@demo/"));
}

const PNPM_VER = sh("pnpm", ["--version"]).trim();
const appW = String(APPS).length;
const target = `@demo/app-${String(Math.floor(APPS / 2)).padStart(appW, "0")}`;
const out = {
  apps: APPS,
  libs: LIBS,
  target,
  pnpm: PNPM_VER,
  turbo: sh(TURBO, ["--version"]).trim(),
};

setup();
const clo = closure(target);
out.closurePackages = clo.length;

// ---- A. filtered install scope ----
rmTrees();
sh("pnpm", ["install", "--config.confirm-modules-purge=false"], { cwd: DIR });
const fullApps = nmCount("apps");
const fullLibs = nmCount("packages");

rmTrees();
sh("pnpm", ["install", `--filter=${target}...`, "--config.confirm-modules-purge=false"], {
  cwd: DIR,
});
const filtApps = nmCount("apps");
const filtLibs = nmCount("packages");

out.filteredInstall = {
  totalApps: APPS,
  totalLibs: LIBS,
  fullInstall: { appsWithNodeModules: fullApps, libsWithNodeModules: fullLibs },
  filteredInstall: { appsWithNodeModules: filtApps, libsWithNodeModules: filtLibs },
  // if a filtered install materializes node_modules for apps outside the closure,
  // it installed (much of) the whole workspace despite --filter.
  scopedToClosure: filtApps <= clo.filter((p) => p.startsWith("@demo/app-")).length,
};

// ---- B. turbo prune completeness + pruned-lockfile size + buildability ----
// measure the full whole-workspace lockfile first (written by the install above)
const fullLockLines = statInt(`wc -l < ${JSON.stringify(join(DIR, "pnpm-lock.yaml"))}`);
// prune reads that lockfile; drop only node_modules so prune still has source + lockfile
sh("bash", [
  "-c",
  `set -euo pipefail; find ${JSON.stringify(DIR)} -name node_modules -type d -prune -exec rm -rf {} +`,
]);
sh(TURBO, ["prune", target, "--docker"], { cwd: DIR });
const outJson = join(DIR, "out", "json");
const outFull = join(DIR, "out", "full");
// claim: prune ships a pruned lockfile (a subset of the original)
const prunedLockLines = statInt(`wc -l < ${JSON.stringify(join(outJson, "pnpm-lock.yaml"))}`);
// completeness: every internal package in the closure is present in out/full
const missingInPrune = clo.filter((p) => {
  const rel = p.replace("@demo/", "");
  return (
    !existsSync(join(outFull, "apps", rel, "package.json")) &&
    !existsSync(join(outFull, "packages", rel, "package.json"))
  );
});
// buildability: build the pruned output exactly as the documented Dockerfile does —
// install from the json layer (manifests + pruned lockfile), overlay full source, build.
// prune omits root configs like tsconfig.base.json (apps extend it); record that,
// then replicate the documented fix (deploy-vercel.mjs copies it) so the build runs.
const prunedHasBaseTsconfig = existsSync(join(outFull, "tsconfig.base.json"));
const build = join(DIR, "build");
let buildOk = true;
let buildErr = null;
try {
  sh("bash", [
    "-c",
    `set -euo pipefail; mkdir -p ${JSON.stringify(build)}; cp -a ${JSON.stringify(outJson)}/. ${JSON.stringify(build)}/`,
  ]);
  sh("pnpm", ["install", "--frozen-lockfile", "--config.confirm-modules-purge=false"], {
    cwd: build,
  });
  sh("bash", [
    "-c",
    `set -euo pipefail; cp -a ${JSON.stringify(outFull)}/. ${JSON.stringify(build)}/; cp -a ${JSON.stringify(join(DIR, "tsconfig.base.json"))} ${JSON.stringify(build)}/`,
  ]);
  sh(TURBO, ["run", "build", `--filter=${target}`], { cwd: build });
} catch (e) {
  buildOk = false;
  buildErr = String(e.message).split("\n").slice(0, 6).join(" ");
}
out.prune = {
  closurePackages: clo.length,
  missingFromPrune: missingInPrune,
  internalDepsComplete: missingInPrune.length === 0,
  fullLockfileLines: fullLockLines,
  prunedLockfileLines: prunedLockLines,
  prunedHasBaseTsconfig,
  dockerFlowBuildOk: buildOk,
  buildError: buildErr,
};

mkdirSync(join(REPO, "bench"), { recursive: true });
writeFileSync(join(REPO, "bench/focus-install-bench.json"), JSON.stringify(out, null, 2));
rmSync(DIR, { recursive: true, force: true });

console.log(JSON.stringify(out, null, 2));
console.log(
  `\nA. filtered install: full materialized ${fullApps}/${APPS} apps; ` +
    `\`--filter=${target}...\` materialized ${filtApps}/${APPS} apps → ` +
    (out.filteredInstall.scopedToClosure ? "SCOPED to closure" : "installed WHOLE workspace"),
);
console.log(
  `B. turbo prune: closure ${clo.length} pkgs, ${missingInPrune.length} missing from out/full; ` +
    `pruned lockfile ${prunedLockLines}/${fullLockLines} lines; ` +
    `docker-flow build ${buildOk ? "OK" : "FAILED: " + buildErr}`,
);

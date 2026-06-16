#!/usr/bin/env node
// Verify the §3.1/§5 claim "Turbopack speeds the build but can regress bundle
// size — measure both" instead of asserting it. Builds ONE app's production
// bundle with webpack and with Turbopack and reports build time AND output size
// for each. Libraries are built once up front (apps import their dist), so the
// comparison isolates the app build.
//
//   node scripts/turbopack-bench.mjs            # default 8:4
//
// Writes bench/turbopack-bench.json. Self-contained in /tmp. Needs a full install
// (Next must be on disk to build).

import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const TURBO = join(REPO, "node_modules", ".bin", "turbo");
const [a, l] = (process.argv[2] || "8:4").split(":");
const APPS = +a;
const LIBS = +l;
if (!Number.isInteger(APPS) || !Number.isInteger(LIBS) || APPS < 1 || LIBS < 1) {
  throw new Error(`scale must be "<apps>:<libs>"; got "${process.argv[2]}"`);
}
const DIR = "/tmp/turbopack-bench";
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", TURBO_TELEMETRY_DISABLED: "1" };

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 27, env, cwd: DIR, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.code || r.error.message}`);
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")} (status ${r.status}):\n${(r.stderr || "").slice(-1500)}`,
    );
  return (r.stdout || "") + (r.stderr || "");
}
const PNPM_VER = sh("pnpm", ["--version"], { cwd: REPO }).trim();
function statInt(script, cwd) {
  const out = sh("bash", ["-c", `set -o pipefail; ${script}`], { cwd }).trim();
  if (!/^\d+$/.test(out)) throw new Error(`stat not an integer: "${out}"`);
  return parseInt(out, 10);
}

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
  copyFileSync(join(REPO, "pnpm-workspace.yaml"), join(DIR, "pnpm-workspace.yaml"));
  writeFileSync(
    join(DIR, "package.json"),
    JSON.stringify({ name: "tp-bench", private: true, packageManager: `pnpm@${PNPM_VER}` }) + "\n",
  );
  writeFileSync(join(DIR, ".gitignore"), "node_modules\n");
  for (const f of ["turbo.json", "tsconfig.base.json"]) {
    if (existsSync(join(REPO, f))) copyFileSync(join(REPO, f), join(DIR, f));
  }
  sh("pnpm", ["install", "--config.confirm-modules-purge=false"]);
}

const appW = String(APPS).length;
const target = `@demo/app-${String(Math.ceil(APPS / 2)).padStart(appW, "0")}`;
const appDir = join(DIR, "apps", `app-${String(Math.ceil(APPS / 2)).padStart(appW, "0")}`);
const nextBin = join(appDir, "node_modules", ".bin", "next");

setup();
// build the app's closure once (libs emit dist that the app imports)
sh(TURBO, ["run", "build", `--filter=${target}...`, "--output-logs=errors-only"]);

function build(turbopack) {
  rmSync(join(appDir, ".next"), { recursive: true, force: true });
  const args = ["build", ...(turbopack ? ["--turbopack"] : [])];
  const t0 = process.hrtime.bigint();
  const out = sh(nextBin, args, { cwd: appDir });
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  // bundle size = .next minus the (non-shipped) build cache
  const total = statInt(`du -sb ${JSON.stringify(join(appDir, ".next"))} | awk '{print $1}'`);
  const cacheDir = join(appDir, ".next", "cache");
  const cache = existsSync(cacheDir)
    ? statInt(`du -sb ${JSON.stringify(cacheDir)} | awk '{print $1}'`)
    : 0;
  const usedTurbopack = /turbopack/i.test(out);
  return {
    ms,
    bundleBytes: total - cache,
    dotNextBytes: total,
    bundlerReported: usedTurbopack ? "turbopack" : "webpack",
  };
}

const out = {
  apps: APPS,
  libs: LIBS,
  app: target,
  pnpm: PNPM_VER,
  next: sh(nextBin, ["--version"]).trim(),
  webpack: build(false),
  turbopack: build(true),
};
out.buildSpeedup = +(out.webpack.ms / out.turbopack.ms).toFixed(2);
out.bundleSizeDeltaPct = +(
  ((out.turbopack.bundleBytes - out.webpack.bundleBytes) / out.webpack.bundleBytes) *
  100
).toFixed(1);

mkdirSync(join(REPO, "bench"), { recursive: true });
writeFileSync(join(REPO, "bench/turbopack-bench.json"), JSON.stringify(out, null, 2));
rmSync(DIR, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 2));
console.log(
  `\nbuild: webpack ${(out.webpack.ms / 1000).toFixed(1)}s (${(out.webpack.bundleBytes / 1e6).toFixed(2)}MB) vs ` +
    `turbopack ${(out.turbopack.ms / 1000).toFixed(1)}s (${(out.turbopack.bundleBytes / 1e6).toFixed(2)}MB) → ` +
    `${out.buildSpeedup}x faster, bundle ${out.bundleSizeDeltaPct >= 0 ? "+" : ""}${out.bundleSizeDeltaPct}%`,
);

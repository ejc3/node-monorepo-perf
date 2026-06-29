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

function detectBundler(out) {
  // Next prints a version banner like "▲ Next.js 16.2.9 (Turbopack)"; the bundler marker on that
  // banner line is the authoritative signal. Anchor to the VERSION banner specifically (a "Next.js"
  // followed by a version number), not any line mentioning "Next.js" (e.g. a "reserved Next.js
  // pages" warning) and not a bare substring of the whole log that the echoed --turbopack flag could
  // trip. Require an EXPLICIT marker and return null otherwise: a banner that names neither bundler
  // is an unrecognized format the caller throws on — never default to "webpack", which would let a
  // marker-less Turbopack build read as webpack and record a spurious webpack-vs-turbopack speedup.
  const banner = out.split("\n").find((line) => /Next\.js\s+v?\d/i.test(line));
  if (!banner) return null;
  if (/turbopack/i.test(banner)) return "turbopack";
  if (/webpack/i.test(banner)) return "webpack";
  return null;
}

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
  const bundlerReported = detectBundler(out);
  if (!bundlerReported)
    throw new Error(
      `\`next ${args.join(" ")}\` — could not identify the bundler from Next's banner ` +
        `(no Turbopack/webpack marker); update turbopack-bench's detectBundler for this Next version`,
    );
  return {
    ms,
    bundleBytes: total - cache,
    dotNextBytes: total,
    bundlerReported,
  };
}

// Two invocations: plain `next build`, and `next build --turbopack`. On Next 16
// `next build` is already Turbopack, so the second is a no-op — which the bench
// detects (identical bundler + output) rather than presenting a webpack-vs-turbopack
// speedup that didn't happen.
const nextBuild = build(false);
const nextBuildTurboFlag = build(true);
const out = {
  apps: APPS,
  libs: LIBS,
  app: target,
  pnpm: PNPM_VER,
  next: sh(nextBin, ["--version"]).trim(),
  nextBuild, // `next build`
  nextBuildTurboFlag, // `next build --turbopack`
};
// Declare the no-op only on a real no-op: both banners report Turbopack AND the shipped
// output is byte-identical. Compare bundleBytes (.next minus the non-shipped build cache),
// not dotNextBytes — .next/cache is the least-deterministic part of a build, so two genuine
// Turbopack builds can differ there by a few bytes; the shipped bundle is what "identical
// output" means. Either signal alone is insufficient — a banner match without identical
// output isn't a no-op, and identical bytes without a banner match could be two degenerate builds.
out.bothTurbopack =
  nextBuild.bundlerReported === "turbopack" &&
  nextBuildTurboFlag.bundlerReported === "turbopack" &&
  nextBuild.bundleBytes === nextBuildTurboFlag.bundleBytes;
if (out.bothTurbopack) {
  // No webpack production path on Next 16 → no meaningful webpack-vs-turbopack ratio.
  out.note =
    "Next 16 `next build` uses Turbopack by default; `--turbopack` is a no-op (identical output). No separate webpack production build to compare against.";
  out.buildSpeedup = null;
  out.bundleSizeDeltaPct = null;
} else {
  // A webpack-vs-turbopack ratio is only meaningful as a real contrast: exactly
  // one build reported Turbopack AND the output differs. Anything else would be a
  // vacuous speedup over two equivalent runs — refuse it instead of recording it.
  const turbopackCount = [nextBuild, nextBuildTurboFlag].filter(
    (b) => b.bundlerReported === "turbopack",
  ).length;
  if (turbopackCount !== 1 || nextBuild.bundleBytes === nextBuildTurboFlag.bundleBytes)
    throw new Error(
      `refusing a webpack-vs-turbopack ratio that isn't a real contrast: bundlers ` +
        `${nextBuild.bundlerReported}/${nextBuildTurboFlag.bundlerReported}, bundle ` +
        `${nextBuild.bundleBytes}/${nextBuildTurboFlag.bundleBytes} bytes`,
    );
  out.buildSpeedup =
    nextBuildTurboFlag.ms > 0 ? +(nextBuild.ms / nextBuildTurboFlag.ms).toFixed(2) : null;
  out.bundleSizeDeltaPct =
    nextBuild.bundleBytes > 0
      ? +(
          ((nextBuildTurboFlag.bundleBytes - nextBuild.bundleBytes) / nextBuild.bundleBytes) *
          100
        ).toFixed(1)
      : null;
}

mkdirSync(join(REPO, "bench"), { recursive: true });
writeFileSync(join(REPO, "bench/turbopack-bench.json"), JSON.stringify(out, null, 2));
rmSync(DIR, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 2));
console.log(
  out.bothTurbopack
    ? `\nNext ${out.next}: \`next build\` and \`next build --turbopack\` identical ` +
        `(${(nextBuild.ms / 1000).toFixed(1)}s, ${(nextBuild.bundleBytes / 1e6).toFixed(2)}MB) — Turbopack is the default, --turbopack a no-op.`
    : `\nnext build ${(nextBuild.ms / 1000).toFixed(1)}s vs --turbopack ${(nextBuildTurboFlag.ms / 1000).toFixed(1)}s → ${out.buildSpeedup}x, bundle ${out.bundleSizeDeltaPct}%`,
);

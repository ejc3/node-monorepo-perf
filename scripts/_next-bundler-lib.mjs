// Shared helpers for the Next.js bundler benches (rspack-pnp-bench,
// rspack-turbopack-speed-bench): the compiler-identity proof and the env/output
// discipline both benches depend on. Kept in one place so the load-bearing trace
// discriminator can't drift between the two scripts.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The positive compiler proof. Next writes a span trace to .next/trace. The JS
// webpack compiler instruments its own pipeline (webpack-compilation, seal, make,
// optimize-chunks); rspack compiles in native Rust and emits none of them (it only
// rides Next's outer run-webpack wrapper); Turbopack emits run-turbopack. So the
// presence of a webpack-internal span means the JS webpack compiler actually ran —
// exactly what a "rspack silently fell back to webpack" bug would trip.
export const WEBPACK_COMPILER_SPANS = ["webpack-compilation", "seal", "make", "optimize-chunks"];

export function hasTraceSpan(dir, spanNames) {
  const p = join(dir, ".next", "trace");
  if (!existsSync(p)) return false;
  let content;
  try {
    content = readFileSync(p, "utf8");
  } catch {
    return false;
  }
  const wanted = new Set(spanNames);
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let arr;
    try {
      arr = JSON.parse(line);
    } catch {
      continue;
    }
    if (Array.isArray(arr) && arr.some((e) => e && wanted.has(e.name))) return true;
  }
  return false;
}

export const ranJsWebpackCompiler = (dir) => hasTraceSpan(dir, WEBPACK_COMPILER_SPANS);

// Which bundler announced itself: Turbopack prints a "(Turbopack)" banner;
// next-rspack prints its experimental banner (at config load — weak on its own, so
// it is cross-checked against the trace); a plain webpack build prints neither.
export function bundlerSignatures(out) {
  return {
    turbopackBanner: /\(Turbopack\)/.test(out),
    rspackBanner: /next-rspack.*experimental/is.test(out),
  };
}

// A completed build writes BUILD_ID + the routes and build manifests (present for
// every successful build across turbopack/webpack/rspack); exit 0 alone is not it.
export function outputComplete(dotNext) {
  return (
    existsSync(join(dotNext, "BUILD_ID")) &&
    existsSync(join(dotNext, "routes-manifest.json")) &&
    existsSync(join(dotNext, "build-manifest.json"))
  );
}

// Scrub every env var that selects the bundler or injects build options, so a
// stray host setting (a shell that exported TURBOPACK=1, NEXT_RSPACK, NODE_OPTIONS,
// a TURBO_*/NEXT_PRIVATE_* knob) can't flip which bundler a cell runs and defeat
// the identity guards. Each cell then selects its bundler only through its own
// config + flag. Returns a fresh env with the yarn/telemetry knobs set.
export function scrubBundlerEnv(baseEnv) {
  const env = { ...baseEnv };
  for (const k of Object.keys(env)) {
    if (
      /^(TURBOPACK|NEXT_RSPACK|RSPACK_CONFIG_VALIDATE|NODE_OPTIONS)$/.test(k) ||
      /^(TURBO_|NEXT_PRIVATE_)/.test(k)
    )
      delete env[k];
  }
  env.YARN_IGNORE_PATH = "1";
  env.CI = "false";
  env.NEXT_TELEMETRY_DISABLED = "1";
  return env;
}

// Apparent .next size in bytes (KiB-granular, diagnostic only). GNU du.
export function duApparentBytes(path) {
  const r = spawnSync("du", ["-sk", "--apparent-size", path], { encoding: "utf8" });
  if (r.status !== 0) return 0;
  return (parseInt(r.stdout.trim().split(/\s+/)[0], 10) || 0) * 1024;
}

// Refuse a work dir that would delete the repo, $HOME, or a filesystem root when
// wiped recursively. Returns the resolved path.
export function guardWorkDir(work, repo) {
  const resolved = resolve(work);
  if (
    resolved === "/" ||
    resolved === resolve(repo) ||
    (process.env.HOME && resolved === resolve(process.env.HOME)) ||
    resolved.split("/").filter(Boolean).length < 2
  )
    throw new Error(`refusing work dir ${resolved} (too close to /, the repo, or $HOME)`);
  return resolved;
}

// The next.config.js body for a builder: rspack engages via withRspack + no
// builder flag; turbopack/webpack use a plain config (withRspack aborts if a
// builder flag is also passed).
export function nextConfigFor(builder) {
  return builder === "rspack"
    ? "const withRspack = require('next-rspack');\nmodule.exports = withRspack({ turbopack: { root: __dirname } });\n"
    : "module.exports = { turbopack: { root: __dirname } };\n";
}

// The one-line build banner for the console log.
export function cellBanner(sig, webpackCompilationSpan) {
  return `tp=${sig.turbopackBanner ? 1 : 0} rs=${sig.rspackBanner ? 1 : 0} wpc=${
    webpackCompilationSpan ? 1 : 0
  }`;
}

// Shared helpers for the Next.js bundler benches (rspack-pnp-bench,
// rspack-turbopack-speed-bench; pnp-compat-bench uses the crash signature): the
// compiler-identity proof, the PnP failure signatures, the control-node fetch,
// and the env/output discipline the benches depend on. Kept in one place so the
// load-bearing discriminators cannot drift between scripts.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONTROL_NODE } from "./_pins.mjs";

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

// Apparent .next size in bytes (KiB-granular, diagnostic only). GNU du. Throws if
// du did not exit 0 with a number: a failed probe must not read as "0 bytes".
export function duApparentBytes(path) {
  const r = spawnSync("du", ["-sk", "--apparent-size", path], { encoding: "utf8" });
  const field = (r.stdout || "").trim().split(/\s+/)[0] ?? "";
  if (r.error || r.signal || r.status !== 0 || !/^\d+$/.test(field))
    throw new Error(
      `du failed on ${path} (status ${r.status}, signal ${r.signal}, output "${field.slice(0, 40)}")`,
    );
  const bytes = Number(field) * 1024;
  if (!Number.isSafeInteger(bytes)) throw new Error(`du reported an out-of-range size on ${path}`);
  return bytes;
}

// Every entry under `dir` → a one-line state (file: size + mtime; symlink: its
// target; directory: its presence), keyed by relative path. Two equal inventories
// taken around a command mean it created, removed, rewrote and touched nothing.
export function treeInventory(dir) {
  const inv = new Map();
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatSync(join(dir, p));
      if (st.isSymbolicLink()) inv.set(p, `l:${readlinkSync(join(dir, p))}`);
      else if (st.isDirectory()) {
        inv.set(p, "d");
        stack.push(p);
      } else inv.set(p, `f:${st.size}:${st.mtimeMs}`);
    }
  }
  return inv;
}
// The relative paths whose state differs between two inventories (added, removed,
// or changed), sorted.
export function inventoryDiff(before, after) {
  const changed = [];
  for (const [p, s] of before) if (after.get(p) !== s) changed.push(p);
  for (const p of after.keys()) if (!before.has(p)) changed.push(p);
  return changed.sort();
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

// ---- Next under Yarn PnP: the two failure signatures ---------------------------
// (1) The config-load crash. On current node 22, `next build` under yarn PnP dies
// while LOADING next.config, before a bundler is selected: next's config transpile
// hook (next-config-ts/require-hook.js) reads `require.extensions['.js']` at module
// scope, and the require() it is handed under the PnP loader has no extensions
// table. Every builder fails identically. The signature requires BOTH the hook's
// path in the stack AND the exact TypeError, so an unrelated failure that merely
// mentions one of them is not recorded as this finding.
export const isPnpConfigLoadCrash = (out) =>
  /next-config-ts[\\/]require-hook\.js/.test(out) &&
  /TypeError: Cannot read properties of undefined \(reading '\.js'\)/.test(out);

// (2) Turbopack's own PnP failure: it has no PnP resolver and cannot find
// next/package.json by filesystem walk (vercel/next.js#42651). The signature
// requires BOTH the resolution-failure wording AND the unresolved target, so a
// failure that merely prints the path `next/package.json` is not this finding.
const TURBOPACK_RESOLVE_WORDING = /couldn't find the Next\.js package/i;
export const isTurbopackPnpResolveFailure = (out) =>
  TURBOPACK_RESOLVE_WORDING.test(out) && /next\/package\.json/.test(out);
// The output line carrying that wording, bounded, persisted next to the boolean so
// the record holds its own evidence (null when the signature did not match).
export const turbopackPnpResolveFailureLine = (out) =>
  isTurbopackPnpResolveFailure(out)
    ? (out.split("\n").find((l) => TURBOPACK_RESOLVE_WORDING.test(l)) ?? "").trim().slice(0, 300)
    : null;

// The pinned older node the PnP trees are re-run under (CONTROL_NODE, _pins.mjs).
// It is the measured evidence that the config-load crash is scoped to the node
// version: the same installed PnP tree, the same yarn and next, behaves the old
// way on it.
export const CONTROL_NODE_VERSION = CONTROL_NODE.version;

// Downloads the control node into `workDir` (removed with it), verifies the
// tarball's SHA-256 against the pin BEFORE extracting or executing anything, and
// returns its bin directory. Throws on an unsupported platform, a failed or
// stalled download (bounded by curl's and the spawn's timeouts), a digest
// mismatch, or a binary that does not report the pinned version.
export function fetchControlNode(workDir) {
  const arch = { arm64: "arm64", x64: "x64" }[process.arch];
  const digest = arch && CONTROL_NODE.sha256[arch];
  if (!digest || process.platform !== "linux")
    throw new Error(`control node: unsupported platform ${process.platform}/${process.arch}`);
  const name = `node-v${CONTROL_NODE_VERSION}-linux-${arch}`;
  const tarball = join(workDir, `${name}.tar.xz`);
  const dl = spawnSync(
    "curl",
    [
      "-fsSL",
      "--connect-timeout",
      "30",
      "--max-time",
      "600",
      "-o",
      tarball,
      `https://nodejs.org/dist/v${CONTROL_NODE_VERSION}/${name}.tar.xz`,
    ],
    { encoding: "utf8", timeout: 660_000 },
  );
  if (dl.error || dl.status !== 0)
    throw new Error(
      `control node download failed: ${dl.error?.message || (dl.stderr || "").slice(-400)}`,
    );
  const got = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (got !== digest)
    throw new Error(`control node tarball sha256 ${got} does not match the pinned ${digest}`);
  const tar = spawnSync("tar", ["-xJf", tarball, "-C", workDir], {
    encoding: "utf8",
    timeout: 300_000,
  });
  if (tar.error || tar.status !== 0)
    throw new Error(`control node extract failed: ${tar.error?.message || tar.stderr}`);
  // version-asserted through the same checked probe every cell's node goes through
  return nodeBinDirFor(join(workDir, name, "bin", "node"), `v${CONTROL_NODE_VERSION}`);
}

// The bin dir that must lead PATH for a child running under `nodeExe`. Tools a
// build spawns by name (shebang scripts, yarn's children) resolve `node` in that
// dir, so the dir's `node` must BE the expected release: it is run (to completion,
// exit 0) and its reported version compared. A renamed executable, a wrapper, or a
// dir whose `node` is another release throws here instead of letting a record name
// a node that did not run its cells.
export function nodeBinDirFor(nodeExe, expectedVersion) {
  const dir = dirname(nodeExe);
  for (const exe of new Set([nodeExe, join(dir, "node")])) {
    const v = spawnSync(exe, ["--version"], { encoding: "utf8", timeout: 60_000 });
    const got = (v.stdout || "").trim();
    if (v.error || v.signal || v.status !== 0 || got !== expectedVersion)
      throw new Error(
        `node identity: ${exe} did not exit 0 reporting ${expectedVersion} ` +
          `(status ${v.status}, signal ${v.signal}, reported "${got}")`,
      );
  }
  return dir;
}

// The env for a child that must run under a specific node: that node's bin dir
// leads PATH, so every `node` the build spawns by name follows the binary the
// cell was launched with. Used for BOTH sides — the bench's own node
// (dirname(process.execPath)) and the control node — so the node a cell records
// is the node that ran it.
export const envForNode = (baseEnv, nodeBinDir) => ({
  ...baseEnv,
  PATH: `${nodeBinDir}:${baseEnv.PATH ?? ""}`,
});

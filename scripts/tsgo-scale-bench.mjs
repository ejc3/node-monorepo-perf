#!/usr/bin/env node
// How do type checkers behave as ONE program grows to a million files? The repo's
// largest measured whole-program gate is ~30k files (optimal-gate-bench, 1.32s / 911MB
// at 4,000:400); this bench extends the one-process question two orders of magnitude
// for THREE checkers — tsgo (the subject: TypeScript's native port), tsc (the baseline
// anchor), and Flow (Meta's checker, built for exactly this scale) — with wall time,
// peak RSS, and CPU% per scale, so each scaling curve (and any capacity cliff) is the
// finding.
//
//   node scripts/tsgo-scale-bench.mjs
//   TSGO_SCALE_POINTS="10000 100000" TSGO_SCALE_SAMPLES=3 node scripts/tsgo-scale-bench.mjs
//
// CORPUS GEOMETRY — layered, fixed depth. Module i sits in layer i % LAYERS (default
// 100) and imports up to 3 modules from the previous layer (i-1, i-1-LAYERS,
// i-1-2*LAYERS), so the import graph's DEPTH stays at LAYERS while its WIDTH grows
// with N — the geometry real monorepos have. This replaces typecheck-bench's
// depth-growing chain deliberately: a chain whose depth grows with N stack-overflows
// tsc's incremental change propagation at ~5,000 modules (RangeError, reproduced —
// recorded in the JSON as chainShapeNote), so a depth-growing corpus would measure
// recursion depth, not program size. Module content depends only on (i, LAYERS):
// growing N appends files, never rewrites. Sharded 1,000 files/dir. The Flow corpus
// mirrors the same geometry module-for-module in Flow's dialect (.js + `// @flow`,
// ReadonlyArray, inline `type` import specifiers) — same types, same graph, translated.
//
// FOUR ROWS per checker, each anchored to the developer it answers for:
//   cold          — page caches DROPPED before every sample (sudo vm.drop_caches=3,
//                   verified up front) + no incremental state: the fresh CI runner's
//                   first check, fs reads included
//   full          — no incremental state, page cache warm (one discarded warmup): the
//                   recurring whole-program pre-merge gate (optimal-gate's case at scale)
//   incrNoChange  — warm incremental state, nothing edited: the no-op re-check floor
//                   (CI retrigger with no change)
//   incrOneEdit   — warm incremental state, ONE mid-corpus module gets a content edit
//                   per sample (a fresh non-exported const — a real change with minimal
//                   invalidation scope): the developer's typecheck-after-one-edit loop,
//                   at its floor (not a fanout test); the module is restored afterward
//
// Each checker runs the way it is meant to run, at its best:
//   tsgo — the platform-native binary invoked directly (not the node .bin shim), so
//          /usr/bin/time attributes RSS to the real process; incremental via
//          incremental:true + tsBuildInfoFile
//   tsc  — node with a 64GB heap ceiling (recorded) so node's default heap never
//          masquerades as a tsc limit; same incremental config
//   flow — cold/full are one-shot `flow check`; the incremental rows use Flow's real
//          model, the PERSISTENT SERVER: `flow start --wait` (init time recorded as
//          serverInitMs), then timed `flow status` with nothing changed, and timed
//          `flow force-recheck <file> && flow status` after the edit. Server peak RSS
//          read from /proc VmHWM (GNU time on a client would measure the client).
//          Rows are labeled closest-equivalents, not identical mechanics.
//
// GATES per scale (untimed): a seeded type error must turn each checker red (tsgo/tsc:
// TS2322; flow: seeded errors in BOTH the first and last module reported by path), and
// the program must be exactly N src files (tsgo/tsc: --listFiles count; flow: a
// server-free `flow ls` count — the same strength). A checker that no-ops or
// skips part of the tree cannot produce a timed number. tsc anchors stop at
// TSC_ANCHOR_MAX (default 100k — a tsc sample beyond that is minutes long, and the
// tsc-vs-tsgo ratio is already typecheck-bench/TYPECHECKERS.md's axis); flow runs the
// full sweep (Meta scale is its claim). The asymmetry is labeled in the JSON.
//
// A signal-killed or timed-out run is that row's recorded outcome (SIGKILL = the OOM
// signature) and stops the sweep — this is a capacity probe and "it dies at N" is the
// answer, not a harness fault. Any other nonzero exit on the clean corpus hard-fails
// the bench (a type error in generated code is a scaffold bug, never data).
//
// Self-contained and non-destructive: corpora live under TSGO_SCALE_WORK (default
// /mnt/fcvm-btrfs/tsgo-scale-bench — two million inodes belong on the big btrfs mount;
// mount recorded), removed on exit unless TSGO_SCALE_KEEP=1; flow-bin installs into the
// work dir, never the repo; any flow server is stopped on exit. Core-bound: refuses on
// a loaded box unless TSGO_SCALE_ALLOW_BUSY=1; per-scale 1-min load recorded.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, readlinkSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as osConstants } from "node:os";
import { median, loadGuard, load1Now } from "./_pm-bench-lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POINTS = (process.env.TSGO_SCALE_POINTS || "10000 100000 250000 500000 1000000")
  .trim()
  .split(/\s+/)
  .map(Number);
const CANONICAL_POINTS = "10000 100000 250000 500000 1000000";
const SAMPLES = Number(process.env.TSGO_SCALE_SAMPLES || 3);
const LAYERS = Number(process.env.TSGO_SCALE_LAYERS || 100);
const TSC_ANCHOR_MAX = Number(process.env.TSC_ANCHOR_MAX || 100000);
const FLOW_VERSION = "0.321.0";
const WORK = process.env.TSGO_SCALE_WORK || "/mnt/fcvm-btrfs/tsgo-scale-bench";
const PER_DIR = 1000; // a million entries in one directory is its own pathology — shard
const RUN_TIMEOUT_MS = 3_600_000; // a hung checker is a timedOut outcome, not a stall

// fail() THROWS so every enclosing finally (seed restores, edit restores) unwinds
// before the process dies — process.exit here would leave a seeded error on disk
class BenchFailure extends Error {}
const fail = (m) => {
  throw new BenchFailure(`FAIL: ${m}`);
};
process.on("uncaughtException", (e) => {
  console.error(`\n${e instanceof BenchFailure ? e.message : e.stack || e}`);
  process.exit(1);
});
if (!Number.isInteger(SAMPLES) || SAMPLES < 1) fail("TSGO_SCALE_SAMPLES must be an integer >= 1");
if (!Number.isInteger(LAYERS) || LAYERS < 2) fail("TSGO_SCALE_LAYERS must be an integer >= 2");
if (!Number.isFinite(TSC_ANCHOR_MAX)) fail("TSC_ANCHOR_MAX must be a number");
if (POINTS.some((n) => !Number.isInteger(n) || n < LAYERS * 3))
  fail(`every point must be >= 3*LAYERS (${LAYERS * 3}) for the layered geometry`);
if (POINTS.some((n, i) => i > 0 && n <= POINTS[i - 1]))
  fail("TSGO_SCALE_POINTS must be strictly increasing (the corpus grows incrementally)");
const envInfo = loadGuard("TSGO_SCALE_ALLOW_BUSY");

const DIR = join(WORK, "corpus"); // TS corpus (tsgo + tsc)
const FDIR = join(WORK, "flow-corpus"); // Flow corpus, same geometry in Flow's dialect
const LOCK = join(WORK, "bench.lock");
const STATE = join(WORK, "corpus-state.json"); // reconciles `generated` with disk across runs
mkdirSync(WORK, { recursive: true });

// two concurrent invocations would share (and mutually rmSync) the same corpus — refuse
// cleanup ownership: only the process that actually acquired the lock may clean up —
// a losing invocation's exit would otherwise rmSync the corpus under the winner
// (observed: run killed mid-250k by a concurrent invocation's cleanup)
let lockOwned = false;
const acquireLock = () => {
  try {
    writeFileSync(LOCK, String(process.pid), { flag: "wx" }); // atomic create
    lockOwned = true;
    return true;
  } catch {
    return false;
  }
};
if (!acquireLock()) {
  const pid = Number(readFileSync(LOCK, "utf8").trim());
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    // stale lock from a dead process
  }
  if (alive) fail(`another tsgo-scale-bench (pid ${pid}) is running in ${WORK}`);
  rmSync(LOCK, { force: true });
  if (!acquireLock()) fail(`lost the lock race for ${WORK}`);
}

// a leftover corpus (TSGO_SCALE_KEEP=1, or a hard-killed run) is adopted only when the
// state marker proves its exact extent and geometry — anything else is wiped, so a
// stale tree can never inflate the program behind the completeness gate
let generated = 0;
if (existsSync(STATE)) {
  try {
    const st = JSON.parse(readFileSync(STATE, "utf8"));
    if (st.layers === LAYERS && st.perDir === PER_DIR && Number.isInteger(st.generated))
      generated = st.generated;
  } catch {
    // unreadable marker — treat as absent
  }
}
// a corpus larger than the sweep's FIRST point cannot be scoped down (include is
// directory-based): adoption only helps runs starting at or above what's on disk
if (generated > POINTS[0]) generated = 0;
if (generated === 0) {
  rmSync(DIR, { recursive: true, force: true });
  rmSync(FDIR, { recursive: true, force: true });
}
mkdirSync(join(DIR, "src"), { recursive: true });
mkdirSync(join(FDIR, "src"), { recursive: true });

let flowStopDir = null;
process.on("exit", () => {
  if (!lockOwned) return; // a losing invocation owns nothing — touch nothing
  if (flowStopDir) spawnSync(FLOW, ["stop"], { cwd: flowStopDir, stdio: "ignore" });
  rmSync(LOCK, { force: true });
  if (process.env.TSGO_SCALE_KEEP === "1") return;
  // remove only what this run created — TSGO_SCALE_WORK may name a caller-owned dir
  for (const d of [DIR, FDIR, join(WORK, "flow-bin")]) rmSync(d, { recursive: true, force: true });
  rmSync(STATE, { force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

// ---- toolchain ----------------------------------------------------------------------------------
// the .bin/tsgo shim execs node -> tsgo.js -> native binary; invoke the native binary
// directly so the timed process IS the checker (and RSS attribution is exact)
const tsgoShim = join(REPO, "node_modules", ".bin", "tsgo");
const TSC = join(REPO, "node_modules", ".bin", "tsc");
if (!existsSync(tsgoShim) || !existsSync(TSC))
  fail("tsgo/tsc not found — run `pnpm install` at the repo root first");
// pnpm isolation hides the platform package from the repo root — resolve the wrapper
// package first, realpath into .pnpm, and resolve the platform binary from THERE
const nativeProbe = spawnSync(
  "node",
  [
    "-e",
    // the platform package's exports map exposes only ./package.json — resolve THAT
    // (from the wrapper's realpath, where pnpm isolation makes it visible) and join to
    // the binary; getExePath.js is ESM and unusable from require()
    `const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");
const wrapper = dirname(realpathSync(require.resolve("@typescript/native-preview/package.json")));
const platformPkg = require.resolve("@typescript/native-preview-linux-arm64/package.json", { paths: [wrapper] });
process.stdout.write(join(dirname(platformPkg), "lib", "tsgo"));`,
  ],
  { cwd: REPO, encoding: "utf8" },
);
const TSGO =
  nativeProbe.status === 0 && existsSync(nativeProbe.stdout.trim())
    ? nativeProbe.stdout.trim()
    : tsgoShim;
const tsgoInvocation =
  TSGO === tsgoShim
    ? ".bin shim (native platform package not resolvable; node>=22.15 execve makes the shim become the native process)"
    : "native binary (direct)";
if (spawnSync(TSGO, ["--version"], { encoding: "utf8" }).status !== 0)
  fail(`resolved tsgo does not run: ${TSGO}`);

// flow-bin installed into the work dir (pinned), never the repo tree
const flowInstallDir = join(WORK, "flow-bin");
mkdirSync(flowInstallDir, { recursive: true });
if (!existsSync(join(flowInstallDir, "node_modules", ".bin", "flow"))) {
  writeFileSync(join(flowInstallDir, "package.json"), JSON.stringify({ private: true }) + "\n");
  const i = spawnSync("npm", ["install", `flow-bin@${FLOW_VERSION}`, "--no-audit", "--no-fund"], {
    cwd: flowInstallDir,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (i.status !== 0) fail(`flow-bin install failed:\n${(i.stderr || "").slice(-400)}`);
}
const FLOW = join(flowInstallDir, "node_modules", ".bin", "flow");
{
  // a reused WORK dir must not silently benchmark a different flow
  const probeFlowVersion = () => {
    const v = spawnSync(FLOW, ["version", "--semver"], { encoding: "utf8" });
    return v.status === 0 ? v.stdout.trim() : null;
  };
  let got = probeFlowVersion();
  if (got !== FLOW_VERSION) {
    rmSync(flowInstallDir, { recursive: true, force: true });
    mkdirSync(flowInstallDir, { recursive: true });
    writeFileSync(join(flowInstallDir, "package.json"), JSON.stringify({ private: true }) + "\n");
    const ri = spawnSync(
      "npm",
      ["install", `flow-bin@${FLOW_VERSION}`, "--no-audit", "--no-fund"],
      { cwd: flowInstallDir, encoding: "utf8", timeout: 600_000 },
    );
    if (ri.status !== 0) fail(`flow-bin reinstall failed:\n${(ri.stderr || "").slice(-400)}`);
    got = probeFlowVersion();
  }
  if (got !== FLOW_VERSION) fail(`flow reports ${got}, expected ${FLOW_VERSION}`);
}

// true cold needs root: verify drop_caches actually works once, up front
const dropCaches = () => {
  const r = spawnSync("sudo", ["-n", "sh", "-c", "sync; echo 3 > /proc/sys/vm/drop_caches"], {
    encoding: "utf8",
  });
  return r.status === 0;
};
const COLD_AVAILABLE = dropCaches();
if (!COLD_AVAILABLE)
  console.log("NOTE: drop_caches unavailable (no root) — cold rows recorded as unavailable");

// the mount the corpora live on — device behavior is part of reproducing the numbers
const mnt = spawnSync("findmnt", ["-n", "-o", "TARGET,FSTYPE,SOURCE", "-T", WORK], {
  encoding: "utf8",
});
const workMount = mnt.status === 0 ? mnt.stdout.trim() : "unknown";

// ---- corpora ------------------------------------------------------------------------------------
// layered geometry: layer(i) = i % LAYERS; module i imports up to 3 modules of layer
// i%LAYERS - 1 (i-1, i-1-LAYERS, i-1-2*LAYERS). Depth bounded at LAYERS; width grows
// with N. Layer-0 modules import nothing (the foundation tier).
const shard = (i) => String(Math.floor(i / PER_DIR)).padStart(4, "0");
const importsOf = (i) => {
  if (i % LAYERS === 0) return [];
  return [i - 1, i - 1 - LAYERS, i - 1 - 2 * LAYERS].filter((j) => j >= 0);
};
const relPath = (from, to) =>
  shard(from) === shard(to) ? `./m${to}.js` : `../${shard(to)}/m${to}.js`;

const moduleSrc = (i, dialect) => {
  const imports = importsOf(i);
  const importLines = imports
    .map((j) => `import { v${j}, type T${j} } from "${relPath(i, j)}";`)
    .join("\n");
  const useSum = imports.map((j) => `v${j}`).join(" + ") || "0";
  if (dialect === "ts")
    return `${importLines}
export interface T${i} { id: number; tag: string; deps: readonly number[]; }
export function make${i}(id: number): T${i} { return { id, tag: "m${i}", deps: [${imports.join(", ")}] }; }
export function fold${i}(xs: readonly T${i}[]): number { return xs.reduce((a, b) => a + b.id, 0) + ${useSum}; }
export const v${i}: number = ${i} + ${useSum};
`;
  return `// @flow
${importLines}
export type T${i} = { id: number, tag: string, deps: ReadonlyArray<number> };
export function make${i}(id: number): T${i} { return { id, tag: "m${i}", deps: [${imports.join(", ")}] }; }
export function fold${i}(xs: ReadonlyArray<T${i}>): number { return xs.reduce((a, b) => a + b.id, 0) + ${useSum}; }
export const v${i}: number = ${i} + ${useSum};
`;
};

function growCorpora(n) {
  if (n < generated) return 0; // already on disk (adopted from the state marker)
  const t0 = process.hrtime.bigint();
  for (let i = generated; i < n; i++) {
    const sh = shard(i);
    if (i % PER_DIR === 0) {
      mkdirSync(join(DIR, "src", sh), { recursive: true });
      mkdirSync(join(FDIR, "src", sh), { recursive: true });
    }
    writeFileSync(join(DIR, "src", sh, `m${i}.ts`), moduleSrc(i, "ts"));
    writeFileSync(join(FDIR, "src", sh, `m${i}.js`), moduleSrc(i, "flow"));
  }
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  generated = n;
  writeFileSync(STATE, JSON.stringify({ generated, layers: LAYERS, perDir: PER_DIR }) + "\n");
  return ms;
}

writeFileSync(
  join(DIR, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src"],
    },
    null,
    2,
  ),
);
const CFG = join(DIR, "tsconfig.json");
const CFG_INCR = join(DIR, "tsconfig.incr.json");
const BUILDINFO = join(DIR, "bench.tsbuildinfo");
writeFileSync(
  CFG_INCR,
  JSON.stringify(
    {
      extends: "./tsconfig.json",
      compilerOptions: { incremental: true, noEmit: true, tsBuildInfoFile: "./bench.tsbuildinfo" },
      include: ["src"],
    },
    null,
    2,
  ),
);
writeFileSync(join(FDIR, ".flowconfig"), "[options]\n");

// ---- one measured run under GNU time --------------------------------------------------------------
// tsc is node: give it heap far beyond need (recorded) so the anchor measures tsc, not
// node's default heap ceiling. Exit >= 128 numerically = signal-killed. The GNU time
// "Elapsed" LABEL contains colons ("(h:mm:ss or m:ss)") — parse the line's last
// whitespace token, never a label-spanning regex (the repo's documented gotcha).
const SIGNAMES = {
  1: "SIGHUP",
  2: "SIGINT",
  6: "SIGABRT",
  7: "SIGBUS",
  9: "SIGKILL",
  11: "SIGSEGV",
  15: "SIGTERM",
};
const SIGNAME_BY_NUM = Object.fromEntries(
  Object.entries(osConstants.signals).map(([k, v]) => [v, k]),
);
const signalNum = (name) =>
  typeof name === "number"
    ? name
    : // full OS table, then -1: an unknown signal NAME must still classify as killed,
      // never collapse to 0/not-killed and get misattributed to the checker's output
      (osConstants.signals[name] ?? -1);
// only a CRASH signal is a capacity finding (SIGKILL = the OOM signature; SIGSEGV/
// SIGABRT/SIGBUS = the checker fell over). An operator/harness interrupt (SIGINT/
// SIGTERM/SIGHUP) is NOT a measurement and hard-fails instead of minting a false
// capacity boundary.
function classifyKill(sig, tail) {
  if (sig === 2 || sig === 15 || sig === 1)
    fail(`interrupted by ${SIGNAMES[sig] || sig} — not a measurement`);
  return {
    exit: null,
    signal: sig,
    signalName: SIGNAME_BY_NUM[sig] || SIGNAMES[sig] || String(sig),
    timedOut: false,
    ms: null,
    peakRssMB: null,
    cpuPct: null,
    tail,
  };
}
const timedEnv = { ...process.env, NODE_OPTIONS: "--max-old-space-size=65536" };
function timedRun(bin, args, cwd = DIR) {
  const r = spawnSync("/usr/bin/time", ["-v", bin, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout: RUN_TIMEOUT_MS,
    env: timedEnv,
  });
  if (r.error && r.error.code === "ETIMEDOUT") {
    // spawnSync's timeout killed /usr/bin/time, NOT the checker underneath (reproduced:
    // the child survives) — kill stragglers by their unique binary path so they cannot
    // pollute later rows, then record the outcome
    spawnSync("pkill", ["-9", "-f", bin], { stdio: "ignore" });
    if (bin === FLOW) spawnSync(FLOW, ["stop"], { cwd: FDIR, stdio: "ignore" });
    return {
      exit: null,
      signal: null,
      timedOut: true,
      ms: null,
      peakRssMB: null,
      cpuPct: null,
      tail: "",
    };
  }
  if (r.error) fail(`/usr/bin/time spawn failed: ${r.error.code || r.error.message}`);
  // a kill can land on /usr/bin/time ITSELF (r.signal set, status null) — classify that
  // path too, not only the 128+N propagation from the child
  if (r.signal !== null) return classifyKill(signalNum(r.signal), "");
  const out = (r.stdout || "") + (r.stderr || "");
  const wallLine = out.split("\n").find((l) => l.includes("Elapsed (wall clock) time"));
  const wallTok = wallLine?.trim().split(/\s+/).pop(); // "1:23.45" or "1:02:03"
  let ms = null;
  if (wallTok) {
    const parts = wallTok.split(":").map(Number);
    if (parts.every(Number.isFinite)) ms = Math.round(parts.reduce((a, p) => a * 60 + p, 0) * 1000);
  }
  const rss = /Maximum resident set size \(kbytes\): (\d+)/.exec(out);
  const cpu = /Percent of CPU this job got: (\d+)%/.exec(out);
  const sig =
    r.status !== null && r.status >= 128
      ? r.status - 128
      : /terminated by signal (\d+)/.exec(out)?.[1];
  if (sig) return classifyKill(Number(sig), out.slice(-2400));
  return {
    exit: r.status,
    signal: null,
    timedOut: false,
    ms,
    peakRssMB: rss ? Math.round(Number(rss[1]) / 1024) : null,
    cpuPct: cpu ? Number(cpu[1]) : null,
    // the assert-facing tail must be CHECKER output: GNU time -v appends its ~700-char
    // report after the child's output, and at scale a verbose error rendering plus the
    // report pushed the checker's own summary line out of a fixed-size raw tail
    // (observed: flow's "Found 3 errors" — the run was correctly red, the assert
    // window was not). classifyKill above keeps the RAW tail: the "Command terminated
    // by signal" evidence lives in the report.
    tail: stripTimeReport(out).slice(-2400),
    // the checker's OWN verdict lives on stdout; stderr carries flow's server-init
    // progress, which grows with program size and floods any merged tail at scale —
    // red-row assertions must read this, never `tail`
    outTail: (r.stdout || "").slice(-2400),
  };
}
function stripTimeReport(out) {
  const i = out.lastIndexOf("\tCommand being timed:");
  return i === -1 ? out : out.slice(0, i);
}
const tsArgs = (cfg) => ["--noEmit", "-p", cfg];

// ---- gates (all untimed) ---------------------------------------------------------------------------
const seedLine = (i) => `export const seededBad${i}: number = "not a number";\n`;
function withSeed(dir, ext, i, body) {
  const p = join(dir, "src", shard(i), `m${i}.${ext}`);
  const orig = readFileSync(p, "utf8");
  writeFileSync(p, orig + seedLine(i));
  try {
    return body(p);
  } finally {
    writeFileSync(p, orig);
  }
}
// the gates run the FIRST full-program processes at each new scale — at the capacity
// cliff the OOM kill lands HERE, so a gate kill must return the capacity record, never
// masquerade as a scaffold failure
const gateKill = (r, phase, onTimeout = null) => {
  // a gate that times out is a capacity outcome (the gates run the FIRST full-program
  // check at each scale), not an interrupt — and never a fake "seeded error not found"
  if (r.error && r.error.code === "ETIMEDOUT") {
    if (onTimeout) onTimeout();
    return { killed: true, timedOut: true, phase };
  }
  const sig =
    r.signal !== null && r.signal !== undefined
      ? signalNum(r.signal)
      : r.status !== null && r.status >= 128
        ? r.status - 128
        : null;
  return sig ? { ...classifyKill(sig, ""), killed: true, phase } : null;
};
function tsPositiveControl(bin, label, n) {
  return withSeed(DIR, "ts", n - 1, () => {
    const r = spawnSync(bin, tsArgs(CFG), {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      env: timedEnv,
      timeout: RUN_TIMEOUT_MS,
    });
    const kill = gateKill(r, "positive control", () => spawnSync("pkill", ["-9", "-f", bin]));
    if (kill) return kill;
    const out = (r.stdout || "") + (r.stderr || "");
    if (r.status === 0) fail(`${label} positive control: exit 0 on a seeded type error at n=${n}`);
    if (!/TS2322/.test(out))
      fail(`${label} positive control: seeded error not TS2322 at n=${n}:\n${out.slice(-300)}`);
    return null;
  });
}
function tsProgramComplete(bin, label, n) {
  const r = spawnSync(bin, [...tsArgs(CFG), "--listFiles"], {
    encoding: "utf8",
    maxBuffer: 1 << 30, // ~90MB of paths at 1M files
    env: timedEnv,
    timeout: RUN_TIMEOUT_MS,
  });
  const kill = gateKill(r, "listFiles gate", () => spawnSync("pkill", ["-9", "-f", bin]));
  if (kill) return kill;
  if (r.status !== 0) fail(`${label} --listFiles exited ${r.status} at n=${n}`);
  const count = (r.stdout.match(/\/src\/\d{4}\/m\d+\.ts$/gm) || []).length;
  if (count !== n) fail(`${label} program has ${count} src files at n=${n}, expected ${n}`);
  return null;
}
// flow has no cheap exact-count equivalent: seed errors in the FIRST and LAST module —
// both must be reported by path (a span check, labeled weaker than the ts exact count)
function flowProgramComplete(n) {
  // `flow ls` is server-free and lists tracked files; every generated module carries
  // the `// @flow` pragma (and .flowconfig has no all=true), so tracked == checked for
  // THIS corpus — that equivalence (plus the seeded controls proving both ends are
  // really checked) is what makes the count the same strength as --listFiles
  const r = spawnSync(FLOW, ["ls"], {
    cwd: FDIR,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    timeout: RUN_TIMEOUT_MS,
  });
  const kill = gateKill(r, "flow ls gate", () => spawnSync("pkill", ["-9", "-f", FLOW]));
  if (kill) return kill;
  if (r.status !== 0) fail(`flow ls exited ${r.status} at n=${n}`);
  const count = (r.stdout.match(/\/src\/\d{4}\/m\d+\.js$/gm) || []).length;
  if (count !== n) fail(`flow will check ${count} src files at n=${n}, expected ${n}`);
  return null;
}
function flowPositiveControls(n) {
  const lsKill = flowProgramComplete(n);
  if (lsKill) return lsKill;
  for (const i of [0, n - 1]) {
    const kill = withSeed(FDIR, "js", i, () => {
      // flow check runs through a server in 0.321 — a survivor from the previous
      // control would serve STALE state (the first seed's error, reproduced in smoke);
      // each control gets a fresh check
      spawnSync(FLOW, ["stop"], { cwd: FDIR, stdio: "ignore" });
      const r = spawnSync(FLOW, ["check"], {
        cwd: FDIR,
        encoding: "utf8",
        maxBuffer: 1 << 28,
        timeout: RUN_TIMEOUT_MS,
      });
      const k = gateKill(r, `positive control (m${i})`, () => {
        spawnSync("pkill", ["-9", "-f", FLOW]);
        spawnSync(FLOW, ["stop"], { cwd: FDIR, stdio: "ignore" });
      });
      if (k) return k;
      const out = (r.stdout || "") + (r.stderr || "");
      if (r.status === 0)
        fail(`flow positive control: exit 0 on a seeded error in m${i} at n=${n}`);
      if (!out.includes(`m${i}.js`))
        fail(
          `flow positive control: seeded error in m${i} not reported at n=${n}:\n${out.slice(-300)}`,
        );
      return null;
    });
    if (kill) return kill;
  }
  return null;
}

// ---- row sampling ----------------------------------------------------------------------------------
function summarize(runs) {
  const cpus = runs.map((r) => r.cpuPct).filter((c) => c !== null);
  return {
    killed: false,
    medianMs: median(runs.map((r) => r.ms)),
    samplesMs: runs.map((r) => r.ms),
    peakRssMB: runs.some((r) => r.peakRssMB !== null)
      ? Math.max(...runs.map((r) => r.peakRssMB ?? 0))
      : null,
    cpuPct: cpus.length ? Math.round(cpus.reduce((a, c) => a + c, 0) / cpus.length) : null,
  };
}
// requireRss=false only for flow client round-trips, whose memory lives in the server
// (recorded separately) — everywhere else a null stat means the GNU-time parse broke
// and must fail, not flow into the record as a silent null/0
function sampleRow(exec, label, n, { prep = null, count = SAMPLES, requireRss = true } = {}) {
  const runs = [];
  for (let i = 0; i < count; i++) {
    if (prep) prep(i);
    const r = exec();
    if (r.timedOut) return { killed: true, timedOut: true, phase: `sample ${i}` };
    if (r.signal !== null)
      return {
        killed: true,
        signal: r.signal,
        signalName: r.signalName,
        phase: `sample ${i}`,
        tail: r.tail,
      };
    if (r.exit !== 0)
      fail(`${label} sample ${i} exited ${r.exit} on the clean corpus at n=${n}:\n${r.tail}`);
    if (r.ms === null) fail(`${label} sample ${i}: wall-clock parse failed at n=${n}`);
    if (requireRss && r.peakRssMB === null)
      fail(`${label} sample ${i}: RSS parse failed at n=${n}`);
    runs.push(r);
  }
  return summarize(runs);
}

const editIndexFor = (n) => {
  // a mid-corpus module that is NOT layer 0 (a layer-0 edit would have no importers)
  let i = Math.floor(n / 2);
  if (i % LAYERS === 0) i += 1;
  return i;
};
// three modules in the TOP layer, spread across the corpus — layer L imports L-1 and
// no layer imports LAYERS-1, so these are true leaves: an error seeded here is the
// developer's own broken new code, with zero downstream invalidation
const leafIndicesFor = (n) => {
  const snap = (i) => {
    let x = Math.max(LAYERS - 1, Math.min(n - 1, i));
    x = x - (x % LAYERS) + (LAYERS - 1);
    return x >= n ? x - LAYERS : x;
  };
  return [...new Set([snap(Math.floor(n / 3)), snap(Math.floor((2 * n) / 3)), snap(n - 1)])];
};
function withSeeds(dir, ext, indices, body) {
  const files = indices.map((i) => {
    const p = join(dir, "src", shard(i), `m${i}.${ext}`);
    return { p, orig: readFileSync(p, "utf8"), i };
  });
  for (const f of files) writeFileSync(f.p, f.orig + seedLine(f.i));
  try {
    return body();
  } finally {
    for (const f of files) writeFileSync(f.p, f.orig);
  }
}
// a prep-phase checker death (kill/timeout) must become the ROW's recorded outcome,
// not a scaffold hard-fail — preps run full-program checks at the same scale as rows
class RowAbort extends Error {
  constructor(record) {
    super("row abort");
    this.record = record;
  }
}
// red-row sampler: the check must EXIT NONZERO and report exactly the seeded errors —
// a red row that comes back clean, crashes, or flags the wrong thing can't post a time
function sampleRowRed(
  exec,
  label,
  n,
  expectFn,
  { prep = null, count = SAMPLES, requireRss = true } = {},
) {
  const runs = [];
  for (let i = 0; i < count; i++) {
    if (prep) prep(i);
    const r = exec();
    if (r.timedOut) return { killed: true, timedOut: true, phase: `sample ${i}` };
    if (r.signal !== null)
      return {
        killed: true,
        signal: r.signal,
        signalName: r.signalName,
        phase: `sample ${i}`,
        tail: r.tail,
      };
    if (r.exit === 0)
      fail(`${label} sample ${i} exited 0 — seeded leaf error(s) not reported at n=${n}`);
    if (!expectFn(r.outTail ?? r.tail ?? ""))
      fail(
        `${label} sample ${i}: seeded-error assertion failed at n=${n}:\n${(r.outTail || r.tail || "").slice(-400)}`,
      );
    if (r.ms === null) fail(`${label} sample ${i}: wall-clock parse failed at n=${n}`);
    if (requireRss && r.peakRssMB === null)
      fail(`${label} sample ${i}: RSS parse failed at n=${n}`);
    runs.push(r);
  }
  return summarize(runs);
}

// tsgo/tsc: four rows via config state
function benchTsChecker(bin, label, n) {
  const g1 = tsPositiveControl(bin, label, n);
  if (g1) return { gate: g1 };
  const g2 = tsProgramComplete(bin, label, n);
  if (g2) return { gate: g2 };
  const rows = {};

  rmSync(BUILDINFO, { force: true });
  if (COLD_AVAILABLE) {
    rows.cold = sampleRow(() => timedRun(bin, tsArgs(CFG)), `${label} cold`, n, {
      prep: () => {
        if (!dropCaches()) fail("drop_caches stopped working mid-run");
      },
    });
    if (rows.cold.killed) return rows;
  } else rows.cold = { unavailable: "drop_caches needs root" };

  const warm = timedRun(bin, tsArgs(CFG));
  if (warm.timedOut || warm.signal !== null)
    return {
      ...rows,
      full: {
        killed: true,
        signal: warm.signal ?? null,
        timedOut: !!warm.timedOut,
        phase: "warmup",
      },
    };
  if (warm.exit !== 0) fail(`${label} warmup exited ${warm.exit} on the clean corpus at n=${n}`);
  rows.full = sampleRow(() => timedRun(bin, tsArgs(CFG)), `${label} full`, n);
  if (rows.full.killed) return rows;

  // the RED pre-merge gate: same stateless full check, but the corpus carries 3 type
  // errors in leaf modules — the cost of a failing gate vs a passing one
  const leaves = leafIndicesFor(n);
  rows.fullWithLeafErrors = withSeeds(DIR, "ts", leaves, () =>
    sampleRowRed(
      () => timedRun(bin, tsArgs(CFG)),
      `${label} full-leaf-errors`,
      n,
      (tail) => (tail.match(/error TS2322/g) || []).length === leaves.length,
    ),
  );
  if (rows.fullWithLeafErrors.killed) return rows;

  rmSync(BUILDINFO, { force: true });
  const prime = timedRun(bin, tsArgs(CFG_INCR));
  if (prime.timedOut || prime.signal !== null)
    return {
      ...rows,
      incrNoChange: {
        killed: true,
        signal: prime.signal ?? null,
        timedOut: !!prime.timedOut,
        phase: "prime",
      },
    };
  if (prime.exit !== 0) fail(`${label} incremental prime exited ${prime.exit} at n=${n}`);
  rows.incrPrimeMs = prime.ms; // the ts counterpart of flow's serverInitMs — entry cost
  if (!existsSync(BUILDINFO)) {
    // a checker that ignores incremental would otherwise time a silent full re-check
    // as an "incremental" number — record the absence instead
    rows.incrNoChange = { unavailable: "no .tsbuildinfo written — incremental not supported" };
    rows.incrOneEdit = rows.incrNoChange;
    return rows;
  }
  rows.incrNoChange = sampleRow(() => timedRun(bin, tsArgs(CFG_INCR)), `${label} incr-nochange`, n);
  if (rows.incrNoChange.killed) return rows;

  const ei = editIndexFor(n);
  const editTarget = join(DIR, "src", shard(ei), `m${ei}.ts`);
  const editOrig = readFileSync(editTarget, "utf8");
  try {
    let edit = 0;
    rows.incrOneEdit = sampleRow(
      () => timedRun(bin, tsArgs(CFG_INCR)),
      `${label} incr-oneedit`,
      n,
      {
        prep: () => {
          edit++;
          writeFileSync(editTarget, editOrig + `const benchEdit${edit} = ${edit};\n`);
        },
      },
    );
  } finally {
    writeFileSync(editTarget, editOrig);
  }
  if (rows.incrOneEdit.killed) return rows;

  // the after-save loop when the edit is WRONG: each sample re-greens the incremental
  // state untimed first (else later samples would time diagnostic REPLAY from the
  // buildinfo, not an edit->red check), then times the check that discovers the error
  const redLeaf = leafIndicesFor(n)[leafIndicesFor(n).length - 1];
  const redTarget = join(DIR, "src", shard(redLeaf), `m${redLeaf}.ts`);
  const redOrig = readFileSync(redTarget, "utf8");
  try {
    rows.incrOneEditError = sampleRowRed(
      () => timedRun(bin, tsArgs(CFG_INCR)),
      `${label} incr-oneedit-error`,
      n,
      (tail) => (tail.match(/error TS2322/g) || []).length === 1,
      {
        prep: () => {
          writeFileSync(redTarget, redOrig);
          const green = spawnSync(bin, tsArgs(CFG_INCR), {
            stdio: "ignore",
            env: timedEnv,
            timeout: RUN_TIMEOUT_MS,
          });
          const gk = gateKill(green, "re-green pass", () => spawnSync("pkill", ["-9", "-f", bin]));
          if (gk) throw new RowAbort(gk);
          if (green.status !== 0)
            fail(`${label} incr-oneedit-error: re-green pass exited ${green.status} at n=${n}`);
          writeFileSync(redTarget, redOrig + seedLine(redLeaf));
        },
      },
    );
  } catch (e) {
    if (e instanceof RowAbort) rows.incrOneEditError = e.record;
    else throw e;
  } finally {
    writeFileSync(redTarget, redOrig);
  }
  return rows;
}

// the flow server log holds crash evidence a timed-out CLIENT can't show (observed: a
// worker panic — WorkerCanceled unwrap — wedged the server and the status client hung)
function flowServerLogTail() {
  try {
    const enc = FDIR.replaceAll("/", "zS");
    return readFileSync(`/tmp/flow/${enc}.log`, "utf8").split("\n").slice(-8).join("\n");
  } catch {
    return null;
  }
}
// flow: cold/full = one-shot `flow check`; incremental rows = the persistent server
function flowServerRss() {
  // SUM of VmHWM across THIS bench's flow process tree (server + monitor + watcher —
  // the watcher tracking N files is real checker footprint), identified by
  // /proc/<pid>/cwd === FDIR so a foreign flow server on the box can never pollute the
  // reading. A sum of per-process peaks is an upper bound on concurrent footprint —
  // labeled in flowNote.
  const pg = spawnSync("pgrep", ["-f", "flow"], { encoding: "utf8" });
  let sum = 0;
  for (const pid of (pg.stdout || "").trim().split("\n").filter(Boolean)) {
    try {
      // ours = cwd is the corpus, or the corpus path appears in the cmdline (the
      // monitor/watcher name their target dir); both exclude foreign flow servers
      const cwdOk = (() => {
        try {
          return readlinkSync(`/proc/${pid}/cwd`) === FDIR;
        } catch {
          return false;
        }
      })();
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cwdOk && !cmd.includes(FDIR)) continue;
      const st = readFileSync(`/proc/${pid}/status`, "utf8");
      if (!/^Name:\s+flow/m.test(st)) continue;
      const m = /VmHWM:\s+(\d+) kB/.exec(st);
      if (m) sum += Math.round(Number(m[1]) / 1024);
    } catch {
      // process exited between pgrep and read
    }
  }
  return sum || null;
}
function benchFlow(n) {
  const g = flowPositiveControls(n);
  if (g) return { gate: g };
  const rows = {};

  // every timed one-shot check gets a server-free start — a stale server would serve
  // the previous corpus state (the smoke-reproduced staleness) and pollute the timing.
  // The stop happens in prep BEFORE drop_caches, so no flow process survives to keep
  // the 79MB binary mapped through the cold drop. flow check runs THROUGH a spawned
  // server (measured: the GNU-time child is a 43MB client), so wall time is end-to-end
  // (spawn + init + check), RSS is the server tree's /proc VmHWM read right after (null
  // if unreadable — never the client's), and client CPU% is dropped as unattributable.
  const stopFlow = () => spawnSync(FLOW, ["stop"], { cwd: FDIR, stdio: "ignore" });
  const flowCheckTimed = () => {
    const r = timedRun(FLOW, ["check"], FDIR);
    return { ...r, peakRssMB: flowServerRss(), cpuPct: null };
  };
  if (COLD_AVAILABLE) {
    rows.cold = sampleRow(flowCheckTimed, "flow cold", n, {
      prep: () => {
        stopFlow();
        if (!dropCaches()) fail("drop_caches stopped working mid-run");
      },
    });
    if (rows.cold.killed) return rows;
  } else rows.cold = { unavailable: "drop_caches needs root" };

  stopFlow();
  const warm = flowCheckTimed();
  if (warm.timedOut || warm.signal !== null)
    return {
      ...rows,
      full: {
        killed: true,
        signal: warm.signal ?? null,
        timedOut: !!warm.timedOut,
        phase: "warmup",
      },
    };
  if (warm.exit !== 0) fail(`flow warmup exited ${warm.exit} on the clean corpus at n=${n}`);
  rows.full = sampleRow(flowCheckTimed, "flow full", n, { prep: () => stopFlow() });
  if (rows.full.killed) return rows;

  const leaves = leafIndicesFor(n);
  rows.fullWithLeafErrors = withSeeds(FDIR, "js", leaves, () =>
    sampleRowRed(
      flowCheckTimed,
      "flow full-leaf-errors",
      n,
      (tail) => new RegExp(`Found ${leaves.length} errors`).test(tail),
      { prep: () => stopFlow() },
    ),
  );
  if (rows.fullWithLeafErrors.killed) return rows;

  // the server model: start (init = flow's own prime, recorded), then status rows.
  // stop the full row's check server first — start exits 11 on a live server (reproduced)
  spawnSync(FLOW, ["stop"], { cwd: FDIR, stdio: "ignore" });
  flowStopDir = FDIR;
  const t0 = process.hrtime.bigint();
  const start = spawnSync(FLOW, ["start", "--wait"], {
    cwd: FDIR,
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
  });
  if (start.error && start.error.code === "ETIMEDOUT") {
    spawnSync(FLOW, ["stop"], { cwd: FDIR, stdio: "ignore" });
    rows.incrNoChange = { killed: true, timedOut: true, phase: "server init" };
    return rows;
  }
  const startKill = gateKill(start, "server init");
  if (startKill) {
    rows.incrNoChange = startKill;
    return rows;
  }
  if (start.status !== 0) {
    rows.incrNoChange = { unavailable: `flow server failed to start (exit ${start.status})` };
    rows.incrOneEdit = rows.incrNoChange;
    return rows;
  }
  rows.serverInitMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);

  const status = () => {
    // --no-auto-start: a server that died between samples must surface as a client
    // error, not silently auto-start and post its cold init as an incremental sample
    const r = timedRun(FLOW, ["status", "--no-auto-start"], FDIR);
    // client round-trip: its RSS/CPU are the client's, not the checker's — the server's
    // peak lives in serverPeakRssMB
    return { ...r, cpuPct: null, peakRssMB: null };
  };
  rows.incrNoChange = sampleRow(status, "flow incr-nochange", n, { requireRss: false });
  if (rows.incrNoChange.killed) return rows;

  const ei = editIndexFor(n);
  const editTarget = join(FDIR, "src", shard(ei), `m${ei}.js`);
  const editOrig = readFileSync(editTarget, "utf8");
  try {
    let edit = 0;
    rows.incrOneEdit = sampleRow(
      () => {
        // deterministic: tell the server about the change, then time the recheck wait.
        // the force-recheck notification is part of the developer-visible latency, so
        // its time is folded in by timing from before the notify call
        const t0 = process.hrtime.bigint();
        const fr = spawnSync(FLOW, ["force-recheck", "--no-auto-start", editTarget], {
          cwd: FDIR,
          timeout: RUN_TIMEOUT_MS,
        });
        if (fr.error && fr.error.code === "ETIMEDOUT")
          return {
            exit: null,
            signal: null,
            timedOut: true,
            ms: null,
            peakRssMB: null,
            cpuPct: null,
            tail: "",
          };
        const frKill = gateKill(fr, "force-recheck");
        if (frKill)
          return {
            ...frKill,
            exit: null,
            timedOut: false,
            ms: null,
            peakRssMB: null,
            cpuPct: null,
          };
        if (fr.status !== 0) fail(`flow force-recheck exited ${fr.status} at n=${n}`);
        const r = status();
        return r.ms === null
          ? r
          : { ...r, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6) };
      },
      "flow incr-oneedit",
      n,
      {
        requireRss: false,
        prep: () => {
          edit++;
          writeFileSync(editTarget, editOrig + `const benchEdit${edit}: number = ${edit};\n`);
        },
      },
    );
  } finally {
    writeFileSync(editTarget, editOrig);
  }
  if (rows.incrOneEdit.killed) return rows;

  // edit->red against the live server, symmetric with incrOneEdit's window; each
  // sample re-greens (restore + force-recheck + clean status) untimed first
  const redLeaf = leafIndicesFor(n)[leafIndicesFor(n).length - 1];
  const redTarget = join(FDIR, "src", shard(redLeaf), `m${redLeaf}.js`);
  const redOrig = readFileSync(redTarget, "utf8");
  const notifyThenStatus = () => {
    const t0 = process.hrtime.bigint();
    const fr = spawnSync(FLOW, ["force-recheck", "--no-auto-start", redTarget], {
      cwd: FDIR,
      timeout: RUN_TIMEOUT_MS,
    });
    if (fr.error && fr.error.code === "ETIMEDOUT")
      return {
        exit: null,
        signal: null,
        timedOut: true,
        ms: null,
        peakRssMB: null,
        cpuPct: null,
        tail: "",
      };
    const frKill = gateKill(fr, "force-recheck (red)");
    if (frKill)
      return { ...frKill, exit: null, timedOut: false, ms: null, peakRssMB: null, cpuPct: null };
    if (fr.status !== 0) fail(`flow force-recheck exited ${fr.status} at n=${n}`);
    const r = status();
    return r.ms === null ? r : { ...r, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6) };
  };
  try {
    rows.incrOneEditError = sampleRowRed(
      notifyThenStatus,
      "flow incr-oneedit-error",
      n,
      (tail) => tail.includes(`m${redLeaf}.js`),
      {
        requireRss: false,
        prep: () => {
          writeFileSync(redTarget, redOrig);
          const fr = spawnSync(FLOW, ["force-recheck", "--no-auto-start", redTarget], {
            cwd: FDIR,
            timeout: RUN_TIMEOUT_MS,
          });
          const frk = gateKill(fr, "re-green force-recheck", () =>
            spawnSync(FLOW, ["stop"], { cwd: FDIR, stdio: "ignore" }),
          );
          if (frk) throw new RowAbort(frk);
          const green = spawnSync(FLOW, ["status", "--no-auto-start"], {
            cwd: FDIR,
            timeout: RUN_TIMEOUT_MS,
          });
          const gk = gateKill(green, "re-green status", () =>
            spawnSync(FLOW, ["stop"], { cwd: FDIR, stdio: "ignore" }),
          );
          if (gk) throw new RowAbort(gk);
          if (green.status !== 0)
            fail(`flow incr-oneedit-error: re-green status exited ${green.status} at n=${n}`);
          writeFileSync(redTarget, redOrig + seedLine(redLeaf));
        },
      },
    );
  } catch (e) {
    if (e instanceof RowAbort) rows.incrOneEditError = e.record;
    else throw e;
  } finally {
    writeFileSync(redTarget, redOrig);
  }
  rows.serverPeakRssMB = flowServerRss();
  if (rows.serverPeakRssMB === null)
    // the server can exit between the last sample and this read (observed: a post-
    // sample crash) — a missing reading is a recorded gap with evidence, not a
    // bench failure
    rows.serverRssNote = `server process gone at read time; log tail: ${(flowServerLogTail() || "unavailable").slice(-300)}`;
  spawnSync(FLOW, ["stop"], { cwd: FDIR, stdio: "ignore" });
  flowStopDir = null;
  return rows;
}

// ---- sweep -----------------------------------------------------------------------------------------
const out = {
  versions: {
    tsgo: JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).devDependencies[
      "@typescript/native-preview"
    ],
    typescript: JSON.parse(
      readFileSync(join(REPO, "node_modules", "typescript", "package.json"), "utf8"),
    ).version,
    flow: FLOW_VERSION,
    node: process.version,
  },
  ...envInfo,
  samples: SAMPLES,
  layers: LAYERS,
  workMount,
  tsgoInvocation,
  coldMode:
    "page caches dropped (vm.drop_caches=3) before every cold sample + no incremental state",
  rows: {
    cold: "caches dropped per sample, no incremental state — the fresh CI runner's first check (node's text pages ride warm on the bench process for the tsc row; the flow server is stopped before each drop)",
    full: "no incremental state, page cache warm (post-warmup) — the recurring whole-program pre-merge gate (optimal-gate's case at scale)",
    incrNoChange:
      "warm incremental state, nothing edited. ts checkers: process re-launch + tsbuildinfo re-read (the CI-retrigger cost); flow: a `flow status` round-trip to the LIVE server — a different mechanic (see mechanicNote), so the ts and flow cells answer different questions",
    incrOneEdit:
      "warm incremental state, one non-exported const appended to a mid-corpus module per sample — the developer's typecheck-after-one-edit loop at its minimal-invalidation floor (a real edit, not a fanout test). ts checkers: re-launch + buildinfo; flow: force-recheck notify + status against the live server, timed end-to-end from the notify",
    fullWithLeafErrors:
      "the RED pre-merge gate: the stateless full check over a corpus carrying 3 seeded type errors in leaf (top-layer, zero-dependents) modules; the run must exit nonzero and report exactly the 3 seeded TS2322/Flow errors — prices a failing gate vs the passing `full` row",
    incrOneEditError:
      "the after-save loop when the edit is WRONG: warm incremental state, one leaf edit that introduces a type error; each sample re-greens untimed first (restore + clean pass) so the timed run is edit->red discovery, never diagnostic replay from saved state; asserts exactly the 1 seeded error. ts checkers: re-launch + buildinfo; flow: notify + status window against the live server",
  },
  mechanicNote:
    "the incremental rows pit flow's persistent server (its primary mechanic) against the ts checkers' process-relaunch incremental (their CLI mechanic); the mechanic-matched ts counterparts — tsc --watch / tsgo --lsp daemons — are not measured here (the repo measures the ts daemon loop in editor-loop-bench). incrPrimeMs (ts) and serverInitMs (flow) are the recorded entry costs of each mechanic",
  corpusShape: `layered, depth fixed at ${LAYERS}: module i in layer i%${LAYERS} imports up to 3 modules of the previous layer; width grows with N — the wide-not-deep geometry real monorepos have; the flow corpus mirrors it module-for-module in Flow's dialect`,
  chainShapeNote:
    "a depth-growing chain corpus (typecheck-bench's shape) stack-overflows tsc's incremental change propagation at ~5,000 modules (RangeError: Maximum call stack size exceeded, reproduced); a depth-growing corpus would measure recursion depth, not program size — hence the fixed-depth geometry",
  flowNote:
    "flow's incremental rows use its real model (persistent server: start --wait recorded as serverInitMs, then status / force-recheck+status) — closest-equivalent rows, not identical mechanics; flow's completeness gates are an exact server-free `flow ls` count (same strength as --listFiles) plus seeded errors in the first AND last module; flow check itself runs through a spawned server (measured), so all flow wall times are end-to-end client round-trips, flow RSS is the SUM of the bench-owned flow process tree's /proc VmHWM peaks (server + monitor + watcher, cwd-verified — an upper bound on concurrent footprint), and flow CPU% is not recorded (the GNU-time child is the client)",
  tscAnchorMax: TSC_ANCHOR_MAX,
  tscNote:
    "tsc runs the same protocol only at points <= tscAnchorMax (NODE_OPTIONS --max-old-space-size=65536 — parity-restoring vs the Go/OCaml runtimes' unbounded heaps; under a 64GB ceiling V8 collects lazily, so tsc's peak RSS reads as unconstrained-V8, not minimum footprint); the tsc-vs-tsgo ratio at scale is typecheck-bench/TYPECHECKERS.md's axis — this bench's axis is behavior at scale; flow runs the full sweep (Meta scale is its claim)",
  killedNote:
    "a signal-killed or timed-out run records that row's outcome (SIGKILL = the OOM signature) as that CHECKER's capacity boundary; the checker is skipped at larger points while the others keep sweeping — one checker's cliff must not cost another its curve",
  points: {},
};

const dead = { tsgo: false, tsc: false, flow: false };
for (const n of POINTS) {
  if (dead.tsgo && dead.flow) break; // nothing left alive to measure (tsc is anchor-only)
  console.log(`\n== ${n.toLocaleString()} modules ==`);
  const loadBefore = load1Now(); // ambient load, sampled BEFORE our own generation work
  const genMs = growCorpora(n);
  console.log(`  corpora grown to ${n.toLocaleString()} modules each (+${genMs}ms generation)`);
  const rec = { generateToHereMs: genMs, loadAvg1Before: loadBefore };

  const show = (name, rows) => {
    if (rows.failed) return true;
    if (rows.skipped) {
      console.log(`  ${name}: skipped (${rows.skipped})`);
      return false;
    }
    for (const [row, v] of Object.entries(rows)) {
      if (typeof v === "number") console.log(`  ${name} ${row}: ${v}`);
      else if (v.unavailable) console.log(`  ${name} ${row}: unavailable (${v.unavailable})`);
      else if (v.killed)
        console.log(
          `  ${name} ${row}: ${v.timedOut ? "TIMED OUT" : `KILLED by signal ${v.signal}`} (${v.phase})`,
        );
      else
        console.log(
          `  ${name} ${row}: ${v.medianMs}ms median, peak RSS ${v.peakRssMB}MB, ${v.cpuPct}% CPU`,
        );
    }
    return Object.values(rows).some((v) => v?.killed);
  };

  if (!dead.tsgo) {
    rec.tsgo = benchTsChecker(TSGO, "tsgo", n);
    if (show("tsgo", rec.tsgo)) {
      dead.tsgo = true;
      console.log(`  — tsgo capacity boundary at ${n.toLocaleString()} modules`);
    }
  } else rec.tsgo = { skipped: "tsgo died at a smaller scale (see that point's record)" };

  if (n <= TSC_ANCHOR_MAX && !dead.tsc) {
    try {
      rec.tsc = benchTsChecker(TSC, "tsc", n);
    } catch (e) {
      rec.tsc = { failed: String(e?.message || e) };
      dead.tsc = true;
      console.log(`  tsc FAILED at ${n.toLocaleString()}: ${rec.tsc.failed}`);
    }
    // a dead anchor is recorded at ITS point and skipped afterward — its limit is not
    // the subject's boundary
    if (show("tsc", rec.tsc)) dead.tsc = true;
  } else if (dead.tsc) {
    rec.tsc = { skipped: "tsc died at a smaller scale (see that point's record)" };
  } else {
    // absent-vs-died must be distinguishable inside the data itself
    rec.tsc = { skipped: "beyond tscAnchorMax — cost-based cutoff, not a capacity result" };
  }

  if (!dead.flow) {
    try {
      rec.flow = benchFlow(n);
      if (show("flow", rec.flow)) {
        dead.flow = true;
        const evidence = flowServerLogTail();
        if (evidence) rec.flow.serverLogTail = evidence;
        spawnSync(FLOW, ["stop"], { cwd: FDIR, stdio: "ignore" });
        console.log(`  — flow capacity boundary at ${n.toLocaleString()} modules`);
      }
    } catch (e) {
      // a comparison checker's assert/gate failure is ITS outcome, never the bench's —
      // the subject's 1M point must survive any flow-side problem
      rec.flow = { failed: String(e?.message || e), serverLogTail: flowServerLogTail() };
      dead.flow = true;
      spawnSync(FLOW, ["stop"], { cwd: FDIR, stdio: "ignore" });
      console.log(`  flow FAILED at ${n.toLocaleString()}: ${rec.flow.failed}`);
    }
  } else rec.flow = { skipped: "flow died at a smaller scale (see that point's record)" };
  out.points[n] = rec;
  writeFileSync(
    join(REPO, "bench", "tsgo-scale-bench.partial.json"),
    JSON.stringify(out, null, 2) + "\n",
  ); // completed points survive a later kill/fail
}

// ---- write -----------------------------------------------------------------------------------------
const canonical =
  POINTS.join(" ") === CANONICAL_POINTS &&
  SAMPLES === 3 &&
  TSC_ANCHOR_MAX === 100000 &&
  LAYERS === 100 &&
  WORK === "/mnt/fcvm-btrfs/tsgo-scale-bench";
if (canonical) {
  writeFileSync(join(REPO, "bench", "tsgo-scale-bench.json"), JSON.stringify(out, null, 2) + "\n");
  rmSync(join(REPO, "bench", "tsgo-scale-bench.partial.json"), { force: true });
}
console.log(
  `\n--- bench/tsgo-scale-bench${canonical ? "" : ".partial"}.json written${canonical ? "" : " (non-canonical → partial)"} ---`,
);
const cell = (v) =>
  !v
    ? "—"
    : v.unavailable
      ? "n/a"
      : v.killed
        ? v.timedOut
          ? "timeout"
          : `killed(${v.signal})`
        : `${v.medianMs}ms`;
for (const [n, r] of Object.entries(out.points))
  console.log(
    `${Number(n).toLocaleString().padStart(11)}: tsgo cold ${cell(r.tsgo.cold)} full ${cell(r.tsgo.full)} incr ${cell(r.tsgo.incrNoChange)}/${cell(r.tsgo.incrOneEdit)} rss ${r.tsgo.full?.peakRssMB ?? "?"}MB${r.tsc && !r.tsc.skipped ? ` | tsc full ${cell(r.tsc.full)}` : " | tsc skipped"} | flow cold ${cell(r.flow.cold)} full ${cell(r.flow.full)} incr ${cell(r.flow.incrNoChange)}/${cell(r.flow.incrOneEdit)}`,
  );

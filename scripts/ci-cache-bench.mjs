#!/usr/bin/env node
// ci-cache-bench: the CENTRALIZED (remote) cache economics — does a shared cache bring the CI cold
// start down, and by how much? Every CI runner starts with an empty LOCAL cache (a fresh container),
// so without a centralized cache EVERY run pays the cold compute. A Turborepo remote cache lets the
// SECOND-and-later runner RESTORE an artifact someone already built instead of recomputing it. This
// bench measures that head-to-head, per task and per scale, as these columns:
//
//   coldNoRemote (pure compute, NO remote; the no-cache cost EVERY runner pays — the baseline) vs
//   coldSeed     (the FIRST runner: compute + upload to populate the cache; paid once)          vs
//   warmLocal    (same machine re-run; the absolute floor)                                       vs
//   remote-restore (a fresh runner restores from the shared cache)
//
// The speedup is restore vs coldNoRemote (the honest "brings cold start down" claim — cold is the pure
// no-cache compute, NOT the upload-inclusive seed). Plus the bytes a fresh runner downloads, the partial-
// invalidation reality (a remote cache only helps the tasks an edit did NOT touch — a leaf edit
// restores most, a universal-foundation edit restores ~none), and the fleet amortization arithmetic.
//
// Transport honesty: the remote cache is a real `turborepo-remote-cache` server, but on LOCALHOST, so
// the restore time is the protocol + (de)compression floor with NO network latency. bytesTransferred
// is recorded so a reader can add their own network cost (~bytes / bandwidth + RTT). The one-time seed
// upload is measured separately so the "someone still pays the cold build" caveat is quantified.
//
//   node scripts/ci-cache-bench.mjs                          # defaults below
//   CI_CACHE_SCALES="300:100 1000:200" ...                   # typecheck scale matrix
//   BUILD_SCALE=300:100  PARTIAL_SCALE=300:100 ...           # build-rung / partial-rung scales
//   CI_CACHE_COLD_SAMPLES=2 CI_CACHE_RESTORE_SAMPLES=3 ...   # samples per timing (true median)
//   CI_CACHE_BUILD_COLD_SAMPLES=1                            # cold build is slow; effect is 100x, 1 sample
//   CI_CACHE_PORT=41101  CI_CACHE_ALLOW_BUSY=1               # server port / bypass the load guard
//
// Discipline (the repo's measurement rules): cold is actually cold (stop any ambient turbo daemon,
// clear .turbo + the pinned TURBO_CACHE_DIR + node_modules/.cache/turbo + build outputs, AND wipe the
// remote store, before each cold sample); source is made visible to Turbo's hashing (enterSourceVisible,
// restored in finally); cold asserts 0 cached, warm-local and remote-restore assert all cached, so a
// degenerate run cannot read as a cache hit; the partial rung STRUCTURALLY asserts the leaf edit
// recomputes strictly fewer tasks than the universal-foundation edit (which recomputes everything);
// speedup is structurally asserted (restore < cold); true median over the sample count; any failed step
// throws. Timings are core-bound (cold compute under --concurrency=100%) and I/O-bound (restore), so the
// bench records cores/load and refuses on a loaded box unless CI_CACHE_ALLOW_BUSY=1.
//
// Self-contained to this worktree: starts and tears down its own remote-cache server, regenerates the
// tree per scale (generate --clean), pins TURBO_CACHE_DIR to this worktree, writes
// bench/ci-cache-bench.json. Run in a linked git worktree (it regenerates the gitignored apps/packages
// tree). NOT destructive to tracked files.

import { execSync, spawn } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
  openSync,
} from "node:fs";
import { join } from "node:path";
import net from "node:net";
import os from "node:os";
import { enterSourceVisible } from "./_source-visible.mjs";

const ROOT = process.cwd();

function fail(m) {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
}
// strict positive-integer env (NaN/junk would silently run 0 samples -> NaN median)
function intEnv(name, def, min) {
  const raw = process.env[name] ?? String(def);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) fail(`${name} must be an integer >= ${min} (got "${raw}")`);
  return n;
}
function parseScale(s) {
  const m = /^(\d+):(\d+)$/.exec(s.trim());
  if (!m) fail(`bad scale "${s}" (want apps:libs, e.g. 1000:200)`);
  const apps = Number(m[1]);
  const libs = Number(m[2]);
  if (apps < 1 || libs < 2) fail(`bad scale "${s}" (need apps>=1, libs>=2)`);
  return { label: `${apps}:${libs}`, apps, libs };
}

const COLD_SAMPLES = intEnv("CI_CACHE_COLD_SAMPLES", 2, 1);
const BUILD_COLD_SAMPLES = intEnv("CI_CACHE_BUILD_COLD_SAMPLES", 1, 1);
const RESTORE_SAMPLES = intEnv("CI_CACHE_RESTORE_SAMPLES", 3, 1);
const CONC = process.env.CI_CACHE_CONC || "100%";
const TC_SCALES = (process.env.CI_CACHE_SCALES || "300:100 1000:200")
  .trim()
  .split(/\s+/)
  .map(parseScale);
const BUILD_SCALE = parseScale(process.env.BUILD_SCALE || "300:100");
const PARTIAL_SCALE = parseScale(process.env.PARTIAL_SCALE || "300:100");

const PORT = intEnv("CI_CACHE_PORT", 41101, 1024);
const TOKEN = "ci-cache-bench-token";
const TEAM = "team_ci";
const SERVER_PKG = "turborepo-remote-cache@2.11.2"; // pinned; recorded in the result
const API = `http://127.0.0.1:${PORT}`;
const REMOTE = `--api=${API} --token=${TOKEN} --team=${TEAM}`;
// All bench scratch lives under .ci-cache/ (gitignored; OUTSIDE .turbo so clearLocal() — which removes
// .turbo — never wipes the remote store). cleanup() removes the whole dir on every exit path.
const SCRATCH = join(ROOT, ".ci-cache");
const STORE_ROOT = join(SCRATCH, "remote-store");
const STORE_TEAM = join(STORE_ROOT, TEAM);
const SERVER_LOG = join(SCRATCH, "server.log");

// core-bound (cold compute) + I/O-bound (restore): timings are only meaningful on an unloaded box
const CORES = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const LOAD1 = +os.loadavg()[0].toFixed(2);
if (LOAD1 > CORES / 2 && process.env.CI_CACHE_ALLOW_BUSY !== "1")
  fail(
    `1-min load ${LOAD1} > ${CORES / 2} (half of ${CORES} cores); timings would be unreliable. Set CI_CACHE_ALLOW_BUSY=1 to override.`,
  );

// Pin Turbo's LOCAL cache to THIS worktree. Turbo otherwise writes to the PRIMARY worktree's .turbo, so
// a worktree-local clear would not clear it and "cold" runs would be stale hits (the central lesson).
const CACHE_DIR = join(ROOT, ".turbo", "cache");
const ENV = { ...process.env, TURBO_CACHE_DIR: CACHE_DIR };

function sh(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeout || 1800000,
    maxBuffer: 256 * 1024 * 1024,
    env: ENV,
  });
}
function timed(cmd, opts = {}) {
  const t0 = process.hrtime.bigint();
  const out = sh(cmd, opts);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, out };
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x) => Math.round(x);

// Parse the "Cached: X cached, Y total" summary line from a real turbo run.
function cacheLine(out) {
  const m = out.match(/Cached:\s+(\d+)\s+cached,\s+(\d+)\s+total/);
  if (!m) fail(`could not parse turbo cache summary from:\n${out.slice(-600)}`);
  return { cached: Number(m[1]), total: Number(m[2]) };
}

function stopDaemon() {
  try {
    sh("pnpm exec turbo daemon stop");
  } catch {
    /* none running */
  }
}
// clear every LOCAL cache (turbo's pinned dir + .turbo + the legacy node_modules cache). NOT the remote.
function clearLocal() {
  rmSync(CACHE_DIR, { recursive: true, force: true });
  rmSync(join(ROOT, ".turbo"), { recursive: true, force: true });
  rmSync(join(ROOT, "node_modules", ".cache", "turbo"), { recursive: true, force: true });
}
// remove build outputs so a "fresh runner" restore actually re-materializes them from the cache
function clearOutputs() {
  try {
    sh(
      `find apps packages -mindepth 2 -maxdepth 2 \\( -name .next -o -name dist -o -name '*.tsbuildinfo' \\) -prune -exec rm -rf {} +`,
    );
  } catch {
    /* nothing to remove */
  }
}
// wipe the remote store (the team subtree the server writes into), then re-create the team dir.
// Pre-creating it dodges a race in the server's fs-blob-store: under concurrent uploads it mkdirs the
// team dir per-write, and simultaneous large writes collide (HTTP 412), silently dropping artifacts.
// Pre-creating the dir removes the per-write mkdir; the timing/bytes measured are unaffected.
function clearRemote() {
  rmSync(STORE_TEAM, { recursive: true, force: true });
  mkdirSync(STORE_TEAM, { recursive: true });
}
// exact bytes a fresh runner would download = total size of the primed remote store
function dirBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else if (e.isFile()) total += statSync(p).size;
  }
  return total;
}
// A --dry=json pass before a timed cold run: validates the task graph builds (catches a bad filter
// before we time anything) and warms the OS page cache for the source. (Does NOT start the turbo
// daemon — turbo 2.x neither auto-spawns one for `run` nor `--dry`.)
function graphPrime(task, filterArgs) {
  try {
    sh(`pnpm exec turbo run ${task} ${filterArgs} --dry=json`);
    return true;
  } catch (e) {
    return `graph build failed: ${String(e.message).split("\n")[0]}`;
  }
}

// ---- remote-cache server lifecycle ---------------------------------------------------------------
let server = null;
let serverStopped = false;
let serverDied = null; // {code, signal} | Error if the child exits/errors before we stop it
function stopServer() {
  if (serverStopped || !server) return;
  serverStopped = true;
  try {
    process.kill(-server.pid, "SIGKILL"); // detached -> server.pid is the group leader; -pid kills the group
  } catch {
    /* already gone */
  }
}
// Probe whether something already listens on the port. Resolves true if a connection succeeds (port
// in use), false on connection-refused/timeout (port free). Used to refuse to attach to a STALE server
// (e.g. a leftover instance on the default port, or a sibling worktree's bench) whose version/store we
// can't vouch for.
function portInUse(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = net.connect(port, "127.0.0.1");
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}
function startServer() {
  rmSync(STORE_ROOT, { recursive: true, force: true });
  mkdirSync(STORE_ROOT, { recursive: true });
  const log = openSync(SERVER_LOG, "w");
  server = spawn("npx", ["-y", SERVER_PKG], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      PORT: String(PORT),
      TURBO_TOKEN: TOKEN,
      STORAGE_PROVIDER: "local",
      STORAGE_PATH: STORE_ROOT,
      STORAGE_PATH_USE_TMP_FOLDER: "false", // use STORAGE_PATH verbatim so we control + measure bytes
      LOG_LEVEL: "error",
      ENABLE_STATUS_LOG: "false",
    },
  });
  // If our child dies before readiness (e.g. EADDRINUSE because something raced onto the port), record
  // it so waitListening fails instead of silently attaching to whatever else is on the port.
  server.on("error", (e) => {
    serverDied = e;
  });
  server.on("exit", (code, signal) => {
    if (!serverStopped) serverDied = { code, signal };
  });
  server.unref();
}
function waitListening(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const fail2 = (why) => {
      const tail = existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, "utf8").slice(-600) : "";
      reject(new Error(`${why}\n${tail}`));
    };
    const tryOnce = () => {
      if (serverDied)
        return fail2(
          `remote-cache server process died before listening: ${JSON.stringify(serverDied)}`,
        );
      const sock = net.connect(PORT, "127.0.0.1");
      const retry = () => {
        sock.destroy();
        if (serverDied)
          return fail2(
            `remote-cache server process died before listening: ${JSON.stringify(serverDied)}`,
          );
        if (Date.now() > deadline)
          fail2(`remote-cache server not listening on ${PORT} after ${timeoutMs}ms`);
        else setTimeout(tryOnce, 200);
      };
      sock.setTimeout(2000); // a hung connect (no SYN-ACK) can't stall past the deadline
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", retry);
      sock.once("timeout", retry);
    };
    tryOnce();
  });
}

function regen(apps, libs, universal = 0) {
  const uni = universal > 0 ? ` --universal ${universal}` : "";
  sh(`node scripts/generate.mjs --apps ${apps} --libs ${libs} --modules 8 --clean${uni}`);
  sh(`pnpm install --no-frozen-lockfile`, { timeout: 1800000 }); // execSync throws on non-zero
}

const pad = (n, w) => String(n).padStart(w, "0");
const libPkg = (i, libs) => `@demo/lib-${pad(i, String(libs).length)}`;
const libDir = (i, libs) => `lib-${pad(i, String(libs).length)}`;

// ---- one headline cell: cold-compute vs warm-local vs remote-restore for a (task, filter) ---------
// The columns, in measurement order:
//   coldNoRemote: wipe local+remote+outputs, COMPUTE with NO remote (--cache=local:rw) -> 0 cached.
//                 This is the honest no-centralized-cache cost EVERY runner pays. The baseline the
//                 speedup is taken against (NOT the seed run — that would contaminate cold with upload).
//   coldSeed:     one COMPUTE WITH remote write (--cache=local:rw,remote:rw) -> 0 cached, populates the
//                 remote (the only run that uploads; turbo uploads only on a miss). = first-runner cost
//                 (compute + upload). coldSeed - coldNoRemote is the one-time seed overhead (localhost:
//                 within compute noise; the real network seed cost is bytesTransferred / bandwidth).
//   warmLocal:    re-run on the now-warm local (--cache=local:rw) -> all cached. Same-machine floor.
//   restore:      wipe local+outputs (keep remote), remote-only (--cache=remote:rw) -> all cached. A
//                 FRESH runner restoring from the shared cache.
function measureCell(task, filterArgs, label, coldSamples) {
  const base = `pnpm exec turbo run ${task} ${filterArgs} --concurrency=${CONC} --output-logs=errors-only`;

  // 1. coldNoRemote — pure compute, no remote configured (the no-cache baseline)
  const coldNoRemoteMs = [];
  let totalTasks = null;
  for (let s = 0; s < coldSamples; s++) {
    stopDaemon();
    clearLocal();
    clearRemote();
    clearOutputs();
    const primed = graphPrime(task, filterArgs);
    if (primed !== true) fail(`${label}: ${primed}`);
    const r = timed(`${base} --cache=local:rw`);
    const c = cacheLine(r.out);
    if (c.cached !== 0)
      fail(`${label} coldNoRemote sample ${s}: expected 0 cached, got ${c.cached}/${c.total}`);
    coldNoRemoteMs.push(r.ms);
    totalTasks = c.total;
  }

  // 2. coldSeed — one compute that WRITES to remote, to populate it (first-runner cost)
  stopDaemon();
  clearLocal();
  clearRemote();
  clearOutputs();
  const seed = timed(`${base} --cache=local:rw,remote:rw ${REMOTE} 2>&1`);
  const seedC = cacheLine(seed.out);
  if (seedC.cached !== 0)
    fail(`${label} coldSeed: expected 0 cached, got ${seedC.cached}/${seedC.total}`);
  const bytes = dirBytes(STORE_TEAM);
  if (bytes <= 0)
    fail(
      `${label}: remote store is empty after coldSeed — nothing was uploaded.\n` +
        `--- turbo output tail ---\n${seed.out.slice(-800)}\n` +
        `--- server log tail ---\n${existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, "utf8").slice(-800) : "(no server log)"}`,
    );

  // 3. warmLocal — local was populated by coldSeed; sample the same-machine floor (median, like the rest)
  const warmLocalMs = [];
  for (let s = 0; s < RESTORE_SAMPLES; s++) {
    const r = timed(`${base} --cache=local:rw`);
    const c = cacheLine(r.out);
    if (c.cached !== c.total)
      fail(`${label} warm-local sample ${s}: expected all cached, got ${c.cached}/${c.total}`);
    warmLocalMs.push(r.ms);
  }

  // 4. restore — a fresh runner: no local cache, no outputs; remote-only
  const restoreMs = [];
  for (let s = 0; s < RESTORE_SAMPLES; s++) {
    stopDaemon();
    clearLocal();
    clearOutputs();
    const r = timed(`${base} --cache=remote:rw ${REMOTE}`);
    const c = cacheLine(r.out);
    if (c.cached !== c.total)
      fail(
        `${label} restore sample ${s}: expected all cached from remote, got ${c.cached}/${c.total}`,
      );
    restoreMs.push(r.ms);
  }

  const coldMed = median(coldNoRemoteMs);
  const restoreMed = median(restoreMs);
  // the headline claim: a fresh runner restoring from the shared cache beats the no-cache cold compute
  if (!(restoreMed < coldMed))
    fail(
      `${label}: remote-restore ${round(restoreMed)}ms not faster than no-cache cold ${round(coldMed)}ms — no cache benefit`,
    );
  const coldR = round(coldMed);
  const seedR = round(seed.ms);
  return {
    totalTasks,
    coldNoRemoteMs: coldR,
    coldSeedMs: seedR,
    seedUploadMs: seedR - coldR, // derived from the published rounded fields; localhost: within compute noise (may be <=0); see seedNote
    warmLocalMs: round(median(warmLocalMs)),
    restoreMs: round(restoreMed),
    speedupVsCold: +(coldMed / restoreMed).toFixed(1),
    bytesTransferred: bytes,
    coldNoRemoteSamples: coldNoRemoteMs.map(round),
    warmLocalSamples: warmLocalMs.map(round),
    restoreSamples: restoreMs.map(round),
  };
}

// a fresh runner runs the WHOLE repo with the remote primed; "cached" = tasks restored from remote,
// total-cached = tasks the edit forced a recompute on. local is wiped so cached can only be remote.
function partialRun(task) {
  stopDaemon();
  clearLocal();
  clearOutputs();
  const r = timed(
    `pnpm exec turbo run ${task} --cache=local:rw,remote:rw ${REMOTE} --concurrency=${CONC} --output-logs=errors-only`,
  );
  const c = cacheLine(r.out);
  return { ms: round(r.ms), total: c.total, restored: c.cached, recomputed: c.total - c.cached };
}
let activeEdit = null; // {file, orig} while a source file is temporarily edited; restored by cleanup()
function withEdit(file, fn) {
  const orig = readFileSync(file, "utf8");
  activeEdit = { file, orig };
  writeFileSync(file, orig + "\nexport const __ci_cache_bump = 1;\n");
  try {
    return fn();
  } finally {
    writeFileSync(file, orig); // revert so the tree hashes match the clean-primed remote again
    activeEdit = null;
  }
}

console.log(
  `ci-cache-bench: tc scales [${TC_SCALES.map((s) => s.label).join(", ")}], build ${BUILD_SCALE.label}, partial ${PARTIAL_SCALE.label}; ` +
    `cold ${COLD_SAMPLES}/build-cold ${BUILD_COLD_SAMPLES}/restore ${RESTORE_SAMPLES} samples; ${CORES} cores, load ${LOAD1}\n`,
);

let restore = null;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  stopServer();
  if (activeEdit) {
    // a partial-rung edit was in flight when we exited (e.g. fail() -> process.exit bypasses withEdit's
    // finally); revert it so the generated source is left clean.
    try {
      writeFileSync(activeEdit.file, activeEdit.orig);
    } catch {
      /* best-effort */
    }
    activeEdit = null;
  }
  if (restore) {
    try {
      restore(); // restore .gitignore (also has its own exit hook; idempotent)
    } catch {
      /* best-effort */
    }
  }
  rmSync(SCRATCH, { recursive: true, force: true }); // remote store + server log scratch
}
process.on("exit", cleanup); // covers normal completion, uncaught throw, AND fail()'s process.exit
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    cleanup();
    process.exit(1);
  });
}

// preflight: refuse to attach to a STALE server already on this port (wrong version/store, or a sibling
// worktree's bench) — otherwise the measurement would silently run against it. cleanup() runs on exit.
if (await portInUse(PORT))
  fail(
    `port ${PORT} already in use — a stale server or another bench? set CI_CACHE_PORT to a free port.`,
  );
startServer();
await waitListening();

restore = enterSourceVisible(ROOT); // make generated source visible to Turbo's input hashing

const result = {
  about:
    "centralized (remote) cache economics: does a shared Turborepo cache bring the CI cold start down? Every CI runner starts with an empty LOCAL cache, so without a centralized cache every run pays the cold compute; a remote cache lets the second-and-later runner RESTORE an artifact someone already built. Measured head-to-head per task and scale: coldNoRemote (pure compute, NO remote — the no-cache cost every runner pays, the baseline the speedup is taken against), coldSeed (the first runner: compute + upload to populate the cache), warmLocal (same-machine floor), remote-restore (a fresh runner restoring from the shared cache); plus the bytes a fresh runner downloads, partial invalidation (a remote cache only helps the tasks an edit did not touch: a leaf edit restores most, a universal-foundation edit restores none), and the fleet amortization. coldNoRemote/coldSeed assert 0 cached, warm-local and remote-restore assert all cached; the partial rung proves the prime fully populated the remote (clean restore = all cached) then asserts leaf-recompute < foundation-recompute (= total); speedup is asserted (restore < coldNoRemote).",
  env: { cores: CORES, preRunLoadAvg1: LOAD1, coreBound: true },
  versions: {
    node: process.version,
    turbo: (() => {
      try {
        return sh("pnpm exec turbo --version").trim();
      } catch {
        return "unknown";
      }
    })(),
    remoteCacheServer: SERVER_PKG, // pinned spec passed to npx -y; npx resolves exactly this version
  },
  remoteCache: {
    transport: "localhost HTTP (turborepo-remote-cache, STORAGE_PROVIDER=local)",
    port: PORT,
    note: "localhost: restore time is the protocol + (de)compression floor with NO network latency. bytesTransferred is recorded so network cost is estimable (~bytes / bandwidth + RTT).",
  },
  samples: { cold: COLD_SAMPLES, buildCold: BUILD_COLD_SAMPLES, restore: RESTORE_SAMPLES },
  concurrency: CONC,
  seedNote:
    "per cell, seedUploadMs = coldSeedMs - coldNoRemoteMs is the first runner's one-time upload to populate the cache. On localhost it is within run-to-run compute noise (it can be <= 0); the real seed cost over a network is bytesTransferred / bandwidth. It is paid ONCE per artifact and amortized across every later runner.",
  headline: [],
  partialInvalidation: null,
  amortization: null,
  notes: [
    "coldNoRemote is the honest no-centralized-cache cost (pure compute, no remote); it is the baseline the restore speedup is taken against. coldSeed is the first runner's cost (compute + upload), paid once.",
    "`turbo run typecheck` cold also builds dependency dists (typecheck dependsOn ^build in turbo.json), so a typecheck cell is the realistic CI job (build deps + typecheck), not typecheck in isolation; its remote artifacts are the lib dists + empty typecheck markers, while a build cell also caches the apps' .next outputs (the bytesTransferred contrast).",
    "remote-restore is measured on localhost; it is the lower bound on a real remote cache. The win is real either way: a fresh runner restores instead of recomputing.",
  ],
};

try {
  // ---- headline: cold vs warm-local vs remote-restore, whole-repo typecheck, per scale -----------
  for (const { label, apps, libs } of TC_SCALES) {
    console.log(`== typecheck @ ${label} ==`);
    regen(apps, libs);
    const cell = measureCell("typecheck", "", `typecheck ${label}`, COLD_SAMPLES);
    console.log(
      `  no-cache cold ${cell.coldNoRemoteMs}ms | seed ${cell.coldSeedMs}ms | warm-local ${cell.warmLocalMs}ms | ` +
        `remote-restore ${cell.restoreMs}ms (${cell.speedupVsCold}x vs cold), ${(cell.bytesTransferred / 1e6).toFixed(1)} MB, ${cell.totalTasks} tasks`,
    );
    result.headline.push({ task: "typecheck", scale: label, apps, libs, ...cell });
  }

  // ---- build cell: same three columns on a `build` run (big .next artifacts -> bytes contrast) ----
  {
    const { label, apps, libs } = BUILD_SCALE;
    console.log(`== build @ ${label} ==`);
    regen(apps, libs);
    const cell = measureCell("build", "", `build ${label}`, BUILD_COLD_SAMPLES);
    console.log(
      `  no-cache cold ${cell.coldNoRemoteMs}ms | seed ${cell.coldSeedMs}ms | warm-local ${cell.warmLocalMs}ms | ` +
        `remote-restore ${cell.restoreMs}ms (${cell.speedupVsCold}x vs cold), ${(cell.bytesTransferred / 1e6).toFixed(1)} MB, ${cell.totalTasks} tasks`,
    );
    result.headline.push({ task: "build", scale: label, apps, libs, ...cell });
  }

  // ---- partial invalidation: a remote cache only helps tasks an edit did NOT touch ---------------
  // Prime the remote with a clean whole-repo typecheck, then edit one source file and run a FRESH
  // runner (local wiped, remote primed). cached = restored from remote; total-cached = recomputed.
  // A LEAF lib (highest layer, fewest dependents) -> most restored; the UNIVERSAL FOUNDATION (lib-001
  // under --universal 1, depended on by every package) -> nothing restored, everything recomputed.
  {
    const { label, apps, libs } = PARTIAL_SCALE;
    console.log(`== partial invalidation @ ${label} (--universal 1) ==`);
    regen(apps, libs, 1);
    // prime remote with the clean tree
    stopDaemon();
    clearLocal();
    clearRemote();
    clearOutputs();
    graphPrime("typecheck", "");
    const prime = timed(
      `pnpm exec turbo run typecheck --cache=local:rw,remote:rw ${REMOTE} --concurrency=${CONC} --output-logs=errors-only`,
    );
    const primeC = cacheLine(prime.out);
    if (primeC.cached !== 0)
      fail(`partial prime: expected 0 cached, got ${primeC.cached}/${primeC.total}`);
    const total = primeC.total;

    // prove the prime FULLY populated the remote: a fresh runner restores ALL tasks. Without this a
    // degenerate prime (only some artifacts uploaded) would make the leaf/foundation restored counts
    // meaningless (the leaf's "restored" could be high just because little was ever in the cache).
    stopDaemon();
    clearLocal();
    clearOutputs();
    const cleanRestore = cacheLine(
      sh(
        `pnpm exec turbo run typecheck --cache=remote:rw ${REMOTE} --concurrency=${CONC} --output-logs=errors-only`,
      ),
    );
    if (cleanRestore.cached !== total || cleanRestore.total !== total)
      fail(
        `partial: clean remote restore got ${cleanRestore.cached}/${cleanRestore.total} cached (expected all ${total}) — remote prime incomplete`,
      );

    const leafFile = join(ROOT, "packages", libDir(libs, libs), "src", "index.ts");
    const foundationFile = join(ROOT, "packages", libDir(1, libs), "src", "index.ts");
    if (!existsSync(leafFile)) fail(`partial: leaf source ${leafFile} not found`);
    if (!existsSync(foundationFile)) fail(`partial: foundation source ${foundationFile} not found`);

    const leaf = withEdit(leafFile, () => partialRun("typecheck"));
    const foundation = withEdit(foundationFile, () => partialRun("typecheck"));

    // STRUCTURAL asserts: the leaf edit restores most (recomputes few); the universal foundation edit
    // restores nothing (recomputes everything). If these don't hold the contrast is degenerate.
    if (leaf.total !== total || foundation.total !== total)
      fail(
        `partial: task total drifted (leaf ${leaf.total}, foundation ${foundation.total}, prime ${total}) — graph changed mid-rung`,
      );
    if (!(leaf.recomputed < foundation.recomputed))
      fail(
        `partial: leaf recomputed ${leaf.recomputed} not < foundation recomputed ${foundation.recomputed} — blast contrast invalid`,
      );
    if (foundation.recomputed !== total)
      fail(
        `partial: universal foundation recomputed ${foundation.recomputed}, expected every task (${total}) — --universal did not take effect`,
      );
    if (!(leaf.restored > 0))
      fail(
        `partial: leaf restored ${leaf.restored} from remote, expected > 0 — remote cache not helping`,
      );
    if (!(leaf.recomputed > 0))
      fail(
        `partial: leaf recomputed ${leaf.recomputed}, expected > 0 — the edit changed nothing (edit/hashing broke)`,
      );
    console.log(
      `  total ${total} tasks | leaf edit: ${leaf.restored} restored / ${leaf.recomputed} recomputed (${leaf.ms}ms) | ` +
        `foundation edit: ${foundation.restored} restored / ${foundation.recomputed} recomputed (${foundation.ms}ms)`,
    );
    result.partialInvalidation = {
      scale: label,
      apps,
      libs,
      task: "typecheck",
      totalTasks: total,
      leaf: { lib: libPkg(libs, libs), ...leaf },
      foundation: { lib: libPkg(1, libs), ...foundation },
      note: "The restored/recomputed COUNTS are the evidence; the .ms is the fresh-runner wall-time (restore the unaffected from remote + recompute the affected + re-upload), measured on localhost, so it is a rough wall-time, not a clean compute number. leaf edit: a remote cache restores the unaffected majority and recomputes only the edited lib's closure. Universal-foundation edit: every task is affected, so the cache restores nothing — someone pays the full cold rebuild. A remote cache helps the second consumer of an UNCHANGED artifact; it cannot help when an edit changes everything.",
    };
  }

  // ---- fleet amortization (arithmetic from the largest measured tc cell's cold + restore) ---------
  // Across R CI runners (or R CI runs) building the same closure: without a cache all R pay cold; with
  // one, the first seeds (cold) and the other R-1 restore. Amortized per-runner cost -> restore.
  {
    const basis = result.headline
      .filter((h) => h.task === "typecheck")
      .reduce((a, b) => (b.coldNoRemoteMs > a.coldNoRemoteMs ? b : a));
    result.amortization = {
      basis: {
        task: basis.task,
        scale: basis.scale,
        coldNoRemoteMs: basis.coldNoRemoteMs,
        coldSeedMs: basis.coldSeedMs,
        restoreMs: basis.restoreMs,
      },
      runners: [1, 2, 5, 10, 50].map((R) => {
        // without a centralized cache, every one of R runners pays the pure no-cache cold compute.
        const withoutCacheMs = R * basis.coldNoRemoteMs;
        // with one, the first runner seeds (compute + upload), the other R-1 restore from remote.
        const withCacheMs = basis.coldSeedMs + (R - 1) * basis.restoreMs;
        return {
          R,
          withoutCacheMs,
          withCacheMs,
          amortizedPerRunnerMs: round(withCacheMs / R),
          fleetSpeedup: +(withoutCacheMs / withCacheMs).toFixed(1),
        };
      }),
      note: "ARITHMETIC from the measured primitives, not separately timed. Without a centralized cache R runners each pay coldNoRemote; with one, the first pays coldSeed (compute + upload) and the other R-1 pay restore. Per-runner cost converges to the restore time as the fleet grows. restore is the localhost floor (no network latency) — over a real network add each runner's download (~bytesTransferred / bandwidth + RTT, see remoteCache.note), so the real fleet speedup is somewhat lower than this localhost arithmetic.",
    };
  }
} finally {
  cleanup();
}

mkdirSync(join(ROOT, "bench"), { recursive: true });
writeFileSync(join(ROOT, "bench", "ci-cache-bench.json"), JSON.stringify(result, null, 2) + "\n");
console.log(`\n--- bench/ci-cache-bench.json written ---`);

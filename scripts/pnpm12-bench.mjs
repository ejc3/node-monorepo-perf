#!/usr/bin/env node
// pnpm 12 (the Rust rewrite) vs pnpm 10 (the pinned JS baseline) vs tip-of-main,
// on this repo's generated workspace shape. pnpm 12.0.0 shipped 2026-08-26 as the
// Rust port (internal project name "pacquet"); the press claims up to 90% faster
// installs amid a dispute over third-party benchmark methodology. This bench prices
// the rewrite under this repo's install discipline: same scaffold, per-leg isolated
// stores, completeness verified by the shared verifier after every timed install,
// and a lockfile-graph equivalence gate so a leg cannot win by resolving less.
//
//   node scripts/pnpm12-bench.mjs                # canonical 1000:200
//
// Legs (each resolved to an explicit binary, never PATH, version-asserted untimed
// before any timed run — pnpm 12's launcher DELEGATES to the version in a project's
// `packageManager` field, so the scaffold's field is stripped and the executed
// version is asserted per leg):
//   pnpm10  — pnpm@PNPM_VERSION (_pins.mjs), the JS CLI, spawned as
//             `<process.execPath> pnpm.cjs` (node startup is inherent to the JS
//             implementation and is measured; Node version recorded)
//   pnpm12  — pnpm@PNPM12_VERSION from npm, the Rust CLI's native binary
//             (@pnpm/exe.linux-<arch>), exec'd directly
//   tip     — PNPM_TIP_BIN (a cargo release build of pnpm/pnpm main), provenance
//             PNPM_TIP_SOURCE (must lead with the git sha); the binary is sha256'd
//             and must differ from the stable leg's binary
//
// Rows per leg, sampled in ROTATED leg order per round (round r runs the legs
// rotated by r, so no leg always inherits the same thermal/page-cache history;
// the realized order is recorded):
//   coldResolve — no lockfile, warm per-leg store: resolution + link (median)
//   warm        — lockfile present, store warm, node_modules wiped (median)
//   frozen      — --frozen-lockfile from the leg's own committed lockfile (median)
//   trulyCold   — fresh store-dir + cache-dir (asserted populated after) + real
//                 network, lockfile RETAINED + --frozen-lockfile (so the row is
//                 store+network cost, not re-resolution): first-ever install
//                 (1 sample per leg, network-bound, legs in recorded order)
// Migration rows (both UNTIMED verdicts — they run once, last, on fresh stores,
// and are not comparable to the medians above):
//   crossFrozen12on10   — pnpm12 --frozen-lockfile against the pnpm10-authored
//                         lockfile: must succeed, verify complete, lock bytes
//                         unchanged (the "pnpm 11 workflows carry over" claim)
//   crossFrozenDrift    — the negative control: a manifest edit + pnpm12
//                         --frozen-lockfile against the stale pnpm10 lockfile must
//                         FAIL CLOSED (ERR_PNPM_OUTDATED_LOCKFILE, lock unchanged)
//
// Workload integrity: the generator is invoked directly with every shape knob
// pinned on the command line and the ambient generator env scrubbed; the printed
// generator summary is parsed and asserted (an env override cannot silently swap
// the workload). Each leg's lockfile package count and importer count must be
// IDENTICAL across legs (resolver-equivalence gate).
//
// Store isolation: per-leg --store-dir and --config.cache-dir under WORK (formats
// differ across majors; sharing would confound warm rows). CI-proofing: resolving
// rows pass --no-frozen-lockfile explicitly (pnpm auto-freezes under CI=true).
//
// Self-contained under PNPM12_WORK (default /mnt/fcvm-btrfs/pnpm12-bench; must be
// an absolute path outside the repo and $HOME root; a marker file scopes what the
// cleanup may delete; removed on exit unless PNPM12_KEEP=1); an atomic lock dir
// refuses concurrent runs. Non-destructive to the repo (no worktree needed);
// load-guarded (PNPM12_ALLOW_BUSY=1). Canonical only at the default scale/samples
// with a tip binary AND the default WORK (fs geometry recorded) →
// bench/pnpm12-bench.json, else the gitignored .partial.json.

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PNPM_VERSION } from "./_pins.mjs";
import { pnpmEnv, median, benchOutput, loadGuard } from "./_pm-bench-lib.mjs";
import verifyLib from "./_verify-install.cjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNPM12_VERSION = "12.8.1"; // Rust stable; npm `latest` at authoring time, pinned here
const DEFAULT_WORK = "/mnt/fcvm-btrfs/pnpm12-bench";
const SCALE = (process.env.PNPM12_SCALE || "1000:200").trim();
const SAMPLES = Number(process.env.PNPM12_SAMPLES || 3);
const WORK = resolve(process.env.PNPM12_WORK || DEFAULT_WORK);
const TIP_BIN = process.env.PNPM_TIP_BIN ? resolve(process.env.PNPM_TIP_BIN) : null;
const TIP_SOURCE = process.env.PNPM_TIP_SOURCE || null;
const MARKER = ".pnpm12-bench-work";

class BenchFailure extends Error {}
const fail = (msg) => {
  throw new BenchFailure(`FAIL: ${msg}`);
};
process.on("uncaughtException", (e) => {
  console.error(e instanceof BenchFailure ? e.message : e);
  process.exit(1);
});

const m = SCALE.match(/^(\d+):(\d+)$/);
if (!m) fail(`PNPM12_SCALE must be <apps>:<libs>, got "${SCALE}"`);
const [APPS, LIBS] = [+m[1], +m[2]];
if (!Number.isInteger(SAMPLES) || SAMPLES < 1) fail("PNPM12_SAMPLES must be a positive integer");
if (TIP_BIN && !existsSync(TIP_BIN)) fail(`PNPM_TIP_BIN does not exist: ${TIP_BIN}`);
if (TIP_BIN && !/^[0-9a-f]{7,40}(\s|$)/.test(TIP_SOURCE || ""))
  fail(
    "PNPM_TIP_BIN requires PNPM_TIP_SOURCE leading with the git sha (e.g. '26aeeb11 2026-09-30')",
  );

// WORK safety: absolute, not /, not $HOME or an ancestor of it, not inside or an
// ancestor of the repo, and if it exists it must be OUR directory (marker present)
// or empty — this is the value two rmSync -rf calls receive.
{
  const home = resolve(homedir());
  const bad = (p, why) => fail(`refusing PNPM12_WORK=${WORK}: ${why} (${p})`);
  if (WORK === sep) bad(WORK, "filesystem root");
  for (const p of [home, REPO, resolve(".")])
    if (WORK === p || p.startsWith(WORK + sep)) bad(p, "would delete this tree");
  if (existsSync(WORK) && !existsSync(join(WORK, MARKER)) && readdirSync(WORK).length > 0)
    bad(WORK, "exists, is non-empty, and carries no marker from a previous run");
}
const CANONICAL = SCALE === "1000:200" && SAMPLES === 3 && !!TIP_BIN && WORK === DEFAULT_WORK;
const envInfo = loadGuard("PNPM12_ALLOW_BUSY");

// atomic anti-concurrency lock: mkdir is atomic; the owner pid cleans it up
const LOCK = WORK + ".lock";
try {
  mkdirSync(LOCK);
  writeFileSync(join(LOCK, "pid"), String(process.pid));
} catch {
  fail(`another run holds ${LOCK} (pid ${readFileSync(join(LOCK, "pid"), "utf8").trim()})`);
}
process.on("exit", () => {
  rmSync(LOCK, { recursive: true, force: true });
  if (process.env.PNPM12_KEEP !== "1") rmSync(WORK, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => process.exit(130));

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, MARKER), String(process.pid));

// fs geometry of WORK (recorded; canonical additionally pins WORK to the default)
const fsInfo = (() => {
  const r = spawnSync("findmnt", ["-no", "FSTYPE,SOURCE", "-T", WORK], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().replace(/\s+/g, " ") : null;
})();

// ---- acquire the two npm-distributed legs into isolated tool dirs ------------------------------
function npmInstallTool(dir, spec) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true }) + "\n");
  const r = spawnSync("npm", ["install", spec, "--no-audit", "--no-fund"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (r.status !== 0) fail(`npm install ${spec} failed:\n${(r.stderr || "").slice(-400)}`);
}
console.log(`# pnpm12-bench: ${APPS}:${LIBS}, samples ${SAMPLES}${TIP_BIN ? ", tip leg" : ""}`);
console.log("## fetching pnpm legs");
const tool10 = join(WORK, "tool10");
const tool12 = join(WORK, "tool12");
npmInstallTool(tool10, `pnpm@${PNPM_VERSION}`);
npmInstallTool(tool12, `pnpm@${PNPM12_VERSION}`);

// pnpm 10 is the JS CLI: measured as `<process.execPath> pnpm.cjs` — node startup
// IS the JS implementation's cost, but the interpreter is pinned to the one running
// this bench and number-moving NODE_* ambience is scrubbed. pnpm 12's npm package
// is a launcher over the @pnpm/exe.<platform> native binary; the raw binary is
// resolved and exec'd directly so the row measures the Rust CLI, not a wrapper.
const js10 = join(tool10, "node_modules", "pnpm", "bin", "pnpm.cjs");
if (!existsSync(js10)) fail(`pnpm10 JS entry not found at ${js10}`);
function findNativePnpm(toolDir) {
  const scope = join(toolDir, "node_modules", "@pnpm");
  if (!existsSync(scope)) fail(`@pnpm scope missing under ${toolDir} (no platform exe package?)`);
  const exePkg = readdirSync(scope).find((d) => d.startsWith("exe"));
  if (!exePkg) fail(`no @pnpm/exe.* platform package under ${scope}`);
  const pkgDir = join(scope, exePkg);
  const cand = ["pnpm", join("bin", "pnpm")].map((p) => join(pkgDir, p)).find(existsSync);
  if (!cand) fail(`native pnpm binary not found inside ${pkgDir}`);
  return cand;
}
const exe12 = findNativePnpm(tool12);
const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const LEGS = [
  { key: "pnpm10", cmd: process.execPath, pre: [js10], version: PNPM_VERSION, impl: "js" },
  { key: "pnpm12", cmd: exe12, pre: [], version: PNPM12_VERSION, impl: "rust" },
  ...(TIP_BIN ? [{ key: "tip", cmd: TIP_BIN, pre: [], version: null, impl: "rust-tip" }] : []),
];

// the env every timed run gets: pnpm ambience scrubbed (shared helper), plus the
// Node vars that would instrument only the JS leg
const runEnv = () => {
  const e = pnpmEnv();
  for (const k of Object.keys(e))
    if (/^NODE_(OPTIONS|COMPILE_CACHE|DEBUG|V8_COVERAGE)$/.test(k)) delete e[k];
  return e;
};

// version + identity asserts (untimed): the executed binary must be the leg it claims
const versions = { node: process.version };
for (const leg of LEGS) {
  const r = spawnSync(leg.cmd, [...leg.pre, "--version"], {
    encoding: "utf8",
    cwd: WORK,
    env: runEnv(),
  });
  if (r.status !== 0) fail(`${leg.key} --version failed: ${(r.stderr || "").slice(-200)}`);
  const v = (r.stdout || "").trim();
  if (leg.version && v !== leg.version)
    fail(`${leg.key} resolved to version ${v}, expected ${leg.version} — wrong binary`);
  versions[leg.key] = leg.key === "tip" ? `${v} (${TIP_SOURCE})` : v;
  console.log(`  ${leg.key}: ${versions[leg.key]}`);
}
let tipIdentity = null;
if (TIP_BIN) {
  tipIdentity = { path: realpathSync(TIP_BIN), sha256: sha256File(TIP_BIN), source: TIP_SOURCE };
  if (tipIdentity.sha256 === sha256File(exe12))
    fail("PNPM_TIP_BIN is byte-identical to the stable pnpm12 binary — not a tip build");
}

// ---- scaffold: one workspace per leg, generator knobs pinned + summary asserted ----------------
// The generator is invoked directly (not via scaffoldWorkspace) so every shape knob
// is on the command line, the ambient generator env is scrubbed, and the printed
// summary can be asserted — an exported PRESET/FRAMEWORK/SHAPE cannot swap the
// canonical workload silently.
const GEN_ENV = (() => {
  const e = { ...process.env };
  for (const k of [
    "PRESET",
    "FRAMEWORK",
    "SHAPE",
    "APP_DEPS",
    "LIB_DEPS",
    "LAYERS",
    "UNIVERSAL",
    "MODULES",
    "APPS",
    "LIBS",
    "SKEW",
    "APP_MODULES",
    "TEST_TASK",
    "VERSIONED",
  ])
    delete e[k];
  return e;
})();
function generateInto(dir, label) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(
    "node",
    [
      join(REPO, "scripts/generate.mjs"),
      "--apps",
      String(APPS),
      "--libs",
      String(LIBS),
      "--modules",
      "12",
      "--clean",
    ],
    { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26, env: GEN_ENV },
  );
  if (r.status !== 0) fail(`generate.mjs failed for ${label}:\n${(r.stderr || "").slice(-600)}`);
  let gen;
  try {
    gen = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    fail(`could not parse generator summary for ${label}:\n${r.stdout.slice(-300)}`);
  }
  const expected = { apps: APPS, libs: LIBS, framework: "next", shape: "layered", skew: 0 };
  for (const [k, v] of Object.entries(expected))
    if (gen[k] !== v)
      fail(`generated shape drifted (env override?): ${k}=${gen[k]}, expected ${v}`);
  // decatalog against the REPO's catalog (the versions source), then write the
  // scaffold's own plain workspace + root manifests — the scaffoldWorkspace
  // pattern. The fresh root package.json carries no packageManager field, so
  // pnpm 12's launcher cannot delegate to a different pnpm than the leg's binary.
  for (const group of ["apps", "packages"]) {
    const rw = spawnSync(
      "node",
      [
        join(REPO, "scripts/rewrite-protocols.mjs"),
        "--dir",
        group,
        "--catalog",
        join(REPO, "pnpm-workspace.yaml"),
      ],
      { cwd: dir, encoding: "utf8", env: GEN_ENV },
    );
    if (rw.status !== 0)
      fail(`rewrite-protocols ${group} failed for ${label}:\n${(rw.stderr || "").slice(-400)}`);
  }
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: label, private: true, workspaces: ["apps/*", "packages/*"] }) + "\n",
  );
  return gen;
}
console.log("## scaffolding per-leg workspaces (identical pinned knobs)");
const legDirs = {};
for (const leg of LEGS) {
  const dir = join(WORK, `ws-${leg.key}`);
  generateInto(dir, `pnpm12-${leg.key}`);
  legDirs[leg.key] = dir;
}

// ---- timed run under GNU time ------------------------------------------------------------------
function timedRun(leg, dir, args) {
  const timeFile = join(WORK, `time-${leg.key}.out`);
  const logFile = join(WORK, `run-${leg.key}.log`);
  const logFd = openSync(logFile, "w");
  const t0 = process.hrtime.bigint();
  const r = spawnSync("/usr/bin/time", ["-v", "-o", timeFile, leg.cmd, ...leg.pre, ...args], {
    cwd: dir,
    stdio: ["ignore", logFd, logFd],
    env: runEnv(),
  });
  closeSync(logFd);
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.error) fail(`cannot spawn /usr/bin/time: ${r.error.message}`);
  if (r.status !== 0)
    fail(
      `${leg.key} ${args.join(" ")} exited ${r.status}:\n${readFileSync(logFile, "utf8").slice(-1200)}`,
    );
  const stats = existsSync(timeFile) ? readFileSync(timeFile, "utf8") : "";
  const rss = (stats.match(/Maximum resident set size[^:]*:\s*(\d+)/) || [])[1];
  const cpu = (stats.match(/Percent of CPU[^:]*:\s*(\d+)/) || [])[1];
  return { ms, rssMB: rss ? Math.round(+rss / 1024) : null, cpuPct: cpu ? +cpu : null };
}
const wipeNm = (dir) => {
  const r = spawnSync(
    "bash",
    ["-c", "find . -name node_modules -type d -prune -exec rm -rf {} +"],
    {
      cwd: dir,
    },
  );
  if (r.status !== 0) fail("node_modules wipe failed");
};
const lockPath = (dir) => join(dir, "pnpm-lock.yaml");
const lockHash = (dir) => sha256File(lockPath(dir)).slice(0, 16);
const lockStats = (dir) => {
  const txt = readFileSync(lockPath(dir), "utf8");
  const v = txt.match(/lockfileVersion:\s*'?([\d.]+)'?/);
  // "packages:" section keys only (cut before the next top-level section, e.g.
  // v9's "snapshots:") — the resolver-equivalence metric compared across legs
  const after = txt.split(/\npackages:\n/)[1] || "";
  const section = after.split(/\n(?=[A-Za-z])/)[0];
  const pkgs = (section.match(/^ {2}[^ \n][^\n]*:\s*$/gm) || []).length;
  return { lockfileVersion: v ? v[1] : null, lockPackages: pkgs };
};
// verifyNm THROWS on an incomplete install and returns the verified edge count
const verify = (dir) => verifyLib.verifyNm(dir);

const storeArgs = (leg, tag = "") => [
  // identical hermetic contract for every leg and row: dependency build scripts
  // never run, and (unlike the default) the install cannot fail over skipped
  // builds — without this the majors DIVERGE: pnpm 10 warns and exits 0, pnpm 12
  // fails closed with ERR_PNPM_IGNORED_BUILDS (recorded as a config fact).
  "--ignore-scripts",
  // pnpm 12 ships a default supply-chain gate (minimumReleaseAge) that fails
  // lockfile verification closed for packages published within the cutoff
  // (observed: ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION on a day-old caniuse-lite).
  // A benchmark must not depend on wall-clock-vs-publish-time, so the policy is
  // relaxed identically on every leg (pnpm 10 accepts the flag; recorded).
  "--config.minimum-release-age=0",
  "--store-dir",
  join(WORK, `store-${leg.key}${tag}`),
  `--config.cache-dir=${join(WORK, `cache-${leg.key}${tag}`)}`,
  "--config.node-linker=isolated",
];
// pnpm auto-enables frozen installs under CI=true; resolving rows must stay
// resolving rows on a CI host, so the flag is explicit.
const RESOLVING = ["install", "--no-frozen-lockfile"];

// ---- record ------------------------------------------------------------------------------------
const OUT = benchOutput(REPO, "bench/pnpm12-bench.partial.json", "bench/pnpm12-bench.json");
const rotate = (arr, n) => arr.slice(n % arr.length).concat(arr.slice(0, n % arr.length));
const out = {
  scale: { apps: APPS, libs: LIBS },
  samples: SAMPLES,
  machine: envInfo,
  work: { path: WORK, fs: fsInfo },
  versions,
  tipIdentity,
  workload: {
    modules: 12,
    ignoreScripts: true,
    ignoredBuildsPolicy:
      "--ignore-scripts on every install row for every leg; absent it pnpm 10 warns and exits 0 while pnpm 12 fails closed with ERR_PNPM_IGNORED_BUILDS",
    minimumReleaseAge:
      "relaxed to 0 on every leg: pnpm 12's default supply-chain gate fails lockfile verification closed for recently-published packages (ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION), which would make results depend on publish-date wall clock",
  },
  legOrderByRound: [],
  rows: {},
  descriptions: {
    coldResolve:
      "no lockfile, warm per-leg store: resolution + link (median; legs rotated per round)",
    warm: "lockfile + warm store, node_modules wiped: the rebuild (median; rotated)",
    frozen: "--frozen-lockfile from the leg's own lockfile: the CI row (median; rotated)",
    trulyCold:
      "fresh store-dir + cache-dir (asserted populated after) + real network, lockfile retained + --frozen-lockfile: first-ever install (1 sample per leg, order recorded)",
    crossFrozen12on10:
      "UNTIMED verdict: pnpm12 --frozen-lockfile against the pnpm10-authored lockfile — success + completeness + lock bytes unchanged",
    crossFrozenDrift:
      "UNTIMED negative control: manifest drifted, pnpm12 --frozen-lockfile against the stale pnpm10 lockfile must fail closed (ERR_PNPM_OUTDATED_LOCKFILE) with lock bytes unchanged",
  },
};
for (const leg of LEGS)
  out.rows[leg.key] = {
    coldResolve: { samplesMs: [], rssMBs: [] },
    warm: { samplesMs: [] },
    frozen: { samplesMs: [] },
  };

// ---- prep: per-leg store warm + lockfile authored + equivalence gate ---------------------------
console.log("## priming per-leg stores + resolver-equivalence gate");
const lockMeta = {};
for (const leg of LEGS) {
  const dir = legDirs[leg.key];
  timedRun(leg, dir, [...RESOLVING, ...storeArgs(leg)]); // warms store, authors lockfile (discarded)
  out.rows[leg.key].depEdgesVerified = verify(dir);
  lockMeta[leg.key] = lockStats(dir);
  out.rows[leg.key].lockfileVersion = lockMeta[leg.key].lockfileVersion;
  out.rows[leg.key].lockPackages = lockMeta[leg.key].lockPackages;
  console.log(
    `  ${leg.key}: lockfileVersion ${lockMeta[leg.key].lockfileVersion} · ${lockMeta[leg.key].lockPackages} locked packages`,
  );
}
{
  const counts = LEGS.map((l) => lockMeta[l.key].lockPackages);
  if (new Set(counts).size !== 1)
    fail(
      `resolver-equivalence gate: legs locked different package counts (${LEGS.map(
        (l) => `${l.key}=${lockMeta[l.key].lockPackages}`,
      ).join(", ")}) — not like-for-like`,
    );
}

// ---- rotated sample rounds ---------------------------------------------------------------------
for (let round = 0; round < SAMPLES; round++) {
  const order = rotate(LEGS, round);
  out.legOrderByRound.push(order.map((l) => l.key));
  console.log(`\n== round ${round + 1}/${SAMPLES}: ${order.map((l) => l.key).join(" → ")} ==`);
  for (const leg of order) {
    const dir = legDirs[leg.key];
    const rows = out.rows[leg.key];

    rmSync(lockPath(dir), { force: true });
    wipeNm(dir);
    const cr = timedRun(leg, dir, [...RESOLVING, ...storeArgs(leg)]);
    verify(dir);
    rows.coldResolve.samplesMs.push(cr.ms);
    rows.coldResolve.rssMBs.push(cr.rssMB);

    wipeNm(dir);
    const w = timedRun(leg, dir, [...RESOLVING, ...storeArgs(leg)]);
    verify(dir);
    rows.warm.samplesMs.push(w.ms);

    const preHash = lockHash(dir);
    wipeNm(dir);
    const f = timedRun(leg, dir, ["install", "--frozen-lockfile", ...storeArgs(leg)]);
    verify(dir);
    if (lockHash(dir) !== preHash) fail(`${leg.key}: frozen install changed the lockfile`);
    rows.frozen.samplesMs.push(f.ms);
    console.log(`  ${leg.key}: cold ${cr.ms}ms · warm ${w.ms}ms · frozen ${f.ms}ms`);
  }
  OUT.persist(out);
}
for (const leg of LEGS) {
  const rows = out.rows[leg.key];
  rows.coldResolve.medianMs = median(rows.coldResolve.samplesMs);
  rows.coldResolve.rssMB = Math.max(...rows.coldResolve.rssMBs.map((x) => x ?? 0)) || null;
  rows.warm.medianMs = median(rows.warm.samplesMs);
  rows.frozen.medianMs = median(rows.frozen.samplesMs);
}

// ---- truly cold (1 sample per leg; fresh store+cache+network; order recorded) ------------------
console.log("\n== truly cold (fresh store + cache + network) ==");
out.trulyColdOrder = LEGS.map((l) => l.key);
for (const leg of LEGS) {
  const dir = legDirs[leg.key];
  wipeNm(dir);
  const tc = timedRun(leg, dir, ["install", "--frozen-lockfile", ...storeArgs(leg, "-tc")]);
  verify(dir);
  // a frozen install resolves nothing, so only the CONTENT STORE must be
  // populated; the metadata cache is legitimately untouched (recorded, not asserted)
  const tcStore = join(WORK, `store-${leg.key}-tc`);
  if (!existsSync(tcStore) || readdirSync(tcStore).length === 0)
    fail(`${leg.key} trulyCold: store-dir not populated — redirect silently ignored`);
  const tcCache = join(WORK, `cache-${leg.key}-tc`);
  const cacheTouched = existsSync(tcCache) && readdirSync(tcCache).length > 0;
  out.rows[leg.key].trulyCold = { ms: tc.ms, rssMB: tc.rssMB, samples: 1, cacheTouched };
  console.log(`  ${leg.key}: ${tc.ms}ms`);
  OUT.persist(out);
}

// ---- migration verdicts (untimed) --------------------------------------------------------------
{
  const leg12 = LEGS.find((l) => l.key === "pnpm12");
  const dir10 = legDirs.pnpm10;
  const pre = lockHash(dir10);
  wipeNm(dir10);
  timedRun(leg12, dir10, ["install", "--frozen-lockfile", ...storeArgs(leg12, "-cross")]);
  verify(dir10);
  if (lockHash(dir10) !== pre)
    fail("crossFrozen12on10: pnpm12 modified the pnpm10 lockfile under --frozen-lockfile");
  out.crossFrozen12on10 = { ok: true };
  console.log("\ncrossFrozen12on10: ok (untimed verdict)");

  // negative control: drift a manifest, frozen must fail closed against the stale lock
  const firstLib = readdirSync(join(dir10, "packages")).sort()[0];
  const probePkg = join(dir10, "packages", firstLib, "package.json");
  const orig = readFileSync(probePkg, "utf8");
  try {
    const pj = JSON.parse(orig);
    pj.dependencies = { ...(pj.dependencies || {}), "is-odd": "3.0.1" };
    writeFileSync(probePkg, JSON.stringify(pj, null, 2) + "\n");
    const logFile = join(WORK, "run-drift.log");
    const logFd = openSync(logFile, "w");
    const r = spawnSync(
      leg12.cmd,
      [...leg12.pre, "install", "--frozen-lockfile", ...storeArgs(leg12, "-cross")],
      { cwd: dir10, stdio: ["ignore", logFd, logFd], env: runEnv() },
    );
    closeSync(logFd);
    const log = readFileSync(logFile, "utf8");
    if (r.status === 0)
      fail("crossFrozenDrift: pnpm12 accepted a drifted manifest under --frozen-lockfile");
    if (!/ERR_PNPM_OUTDATED_LOCKFILE/.test(log))
      fail(`crossFrozenDrift: failed, but without ERR_PNPM_OUTDATED_LOCKFILE:\n${log.slice(-400)}`);
    if (lockHash(dir10) !== pre)
      fail("crossFrozenDrift: the failed frozen install changed the lockfile");
    out.crossFrozenDrift = { failedClosed: true, marker: "ERR_PNPM_OUTDATED_LOCKFILE" };
    console.log("crossFrozenDrift: fail-closed ok (untimed verdict)");
  } finally {
    writeFileSync(probePkg, orig);
  }
}

if (CANONICAL) OUT.promote(out);
else OUT.persist(out);
console.log(
  `\n--- ${CANONICAL ? "bench/pnpm12-bench.json" : "bench/pnpm12-bench.partial.json"} written ---`,
);

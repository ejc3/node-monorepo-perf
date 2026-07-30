#!/usr/bin/env node
// Flow on the fleet shape: the Flow-dialect mirror of the measured production
// workspace (FLEET.md), answering what the optimal-gate scenario costs under
// Flow instead of tsgo. Same graph by construction: the mirror is derived from
// a generated fleet TS tree's artifacts (each package's manifest deps + module
// count), so the lib graph, app fanout, and the oven-sh/bun#36386 app rename
// all carry over exactly. Dialect: each TS module re-emitted as `// @flow` .js
// (type aliases, ReadonlyArray, the same unions/functions); the app entry is a
// typed function composition instead of JSX (the measured quantity is checker
// cost over the import/type graph; neither corpus here exercises JSX). Package
// imports resolve through .flowconfig module.name_mapper — no install, no
// node_modules.
//
//   node scripts/fleet-flow-bench.mjs            # canonical 30000:460
//   FLEET_FLOW_APPS=3000 node scripts/...        # scaled (-> partial json)
//
// Rows (mechanic-matched to optimal-gate-bench's whole-program gate):
//   check      one-shot `flow check` on the clean tree after a non-breaking
//              foundation rev — wall time + flow process-tree peak RSS
//   breaking   foundation signature break -> `flow check` red; EVERY app must
//              carry the arity error (appsWithErrors === APPS, sample recorded)
// Gates (untimed, before any timed row): `flow ls` file count must equal the
// emitted count exactly; a seeded type error must turn the check red. A
// signal-killed flow is a harness fault, never a measurement. Flow wall times
// are end-to-end client round-trips through flow's own spawned server; RSS is
// the summed /proc VmHWM peak of the bench-owned flow process tree (continuous
// sampler, cwd-verified) — the tsgo-scale-bench convention.
//
// FLOW_BIN + FLOW_SOURCE select the canonical checker (a flow main build with
// the wedge fixes, provenance recorded, as in tsgo-scale-bench); without
// FLOW_BIN a released flow-bin is npm-installed into WORK and version-recorded.
// Self-contained: everything lives under FLEET_FLOW_WORK (default
// /mnt/fcvm-btrfs/fleet-flow-bench), removed on exit unless FLEET_FLOW_KEEP=1;
// the repo tree is never touched, so no worktree is needed. Core-bound: refuses
// on a loaded box unless FLEET_FLOW_ALLOW_BUSY=1.

import { execFileSync, spawnSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { availableParallelism, loadavg } from "node:os";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const APPS = +(process.env.FLEET_FLOW_APPS || 30000);
const LIBS = 460; // fleet preset lib graph is fixed (FLEET.md)
const WORK = process.env.FLEET_FLOW_WORK || "/mnt/fcvm-btrfs/fleet-flow-bench";
const KEEP = process.env.FLEET_FLOW_KEEP === "1";
const FLOW_BIN = process.env.FLOW_BIN || "";
const FLOW_SOURCE = process.env.FLOW_SOURCE || "";
const FLOW_VERSION = "0.321.0"; // released fallback, version-asserted below
const CANONICAL = APPS === 30000 && !process.env.FLEET_FLOW_WORK && !!FLOW_BIN && !!FLOW_SOURCE;

const CORES = availableParallelism();
const LOAD1 = loadavg()[0];
if (LOAD1 > CORES / 2 && process.env.FLEET_FLOW_ALLOW_BUSY !== "1") {
  console.error(
    `1-min load ${LOAD1.toFixed(1)} on ${CORES} cores — busy box; flow numbers would be contended. Set FLEET_FLOW_ALLOW_BUSY=1 to override.`,
  );
  process.exit(1);
}

const TS_TREE = join(WORK, "ts-tree");
const FLOW_TREE = join(WORK, "flow-tree");
const fail = (msg) => {
  throw new Error(msg);
};
const timed = (fn) => {
  const t0 = process.hrtime.bigint();
  const r = fn();
  return { ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), r };
};
const liveSamplers = new Set();
process.on("exit", () => {
  // kill any leaked sampler loop, stop any flow server owned by this run,
  // then drop the work dir (the lock file goes with it)
  for (const pid of liveSamplers) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  try {
    spawnSync(FLOW, ["stop"], { cwd: FLOW_TREE, stdio: "ignore", timeout: 30000 });
  } catch {}
  if (ownsLock && !KEEP) rmSync(WORK, { recursive: true, force: true });
});
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// ---- concurrency lock: two runs sharing WORK corrupt each other ----------
mkdirSync(WORK, { recursive: true });
const LOCK = join(WORK, "bench.pid");
let ownsLock = false;
if (existsSync(LOCK)) {
  const other = +readFileSync(LOCK, "utf8").trim();
  let alive = false;
  try {
    process.kill(other, 0);
    alive = true;
  } catch {}
  if (alive) fail(`another fleet-flow run (pid ${other}) owns ${WORK} — refusing to share it`);
}
writeFileSync(LOCK, String(process.pid));
ownsLock = true;

// ---- flow binary ---------------------------------------------------------
let FLOW = FLOW_BIN;
if (!FLOW) {
  const dir = join(WORK, "flow-bin");
  if (!existsSync(join(dir, "node_modules", ".bin", "flow"))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true }) + "\n");
    const i = spawnSync("npm", ["install", `flow-bin@${FLOW_VERSION}`, "--no-audit", "--no-fund"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 300000,
    });
    if (i.status !== 0) fail(`flow-bin install failed:\n${(i.stderr || "").slice(-400)}`);
  }
  FLOW = join(dir, "node_modules", ".bin", "flow");
}
const flowVersion = execFileSync(FLOW, ["version"], { encoding: "utf8" }).trim();
if (!FLOW_BIN && !flowVersion.includes(FLOW_VERSION))
  fail(`flow-bin version drift: wanted ${FLOW_VERSION}, got "${flowVersion}"`);

// ---- 1. generate the fleet TS tree (the artifact the mirror derives from) --
console.log(`# fleet-flow: ${APPS} apps / ${LIBS} libs — generating the TS fleet tree`);
mkdirSync(TS_TREE, { recursive: true });
const genOut = execFileSync(
  "node",
  [
    join(REPO, "scripts", "generate.mjs"),
    "--preset",
    "fleet",
    ...(APPS !== 30000 ? ["--apps", String(APPS)] : []),
    "--clean",
  ],
  { cwd: TS_TREE, encoding: "utf8", maxBuffer: 1 << 26 },
);
let gen;
try {
  gen = JSON.parse(genOut.trim().split("\n").pop());
} catch {
  fail(`could not parse generator summary from:\n${genOut.slice(-400)}`);
}
const expectedGen = {
  apps: APPS,
  libs: LIBS,
  preset: "fleet",
  shape: "skewed",
  modulesPerLib: 13,
  appModules: 28,
  universal: 5,
  popular: 10,
  tailPicks: 2,
  framework: "next",
  testTask: false,
  versioned: false,
  skew: 0,
};
for (const [k, v] of Object.entries(expectedGen)) {
  if (gen[k] !== v) fail(`generated shape drifted (env override?): ${k}=${gen[k]}, expected ${v}`);
}

// ---- 2. mirror it in Flow's dialect --------------------------------------
// Facts come from the artifacts: deps from each package.json (so the bun#36386
// rename and every graph edge carry over), module counts from the src listing.
console.log("## mirroring in Flow dialect");
const t0m = process.hrtime.bigint();
rmSync(FLOW_TREE, { recursive: true, force: true });
mkdirSync(FLOW_TREE, { recursive: true });

const flowModule = (tag, seed, header) => `// @flow
${header}
export type Rec_${tag} = {
  id: number,
  name: string,
  tags: ReadonlyArray<string>,
  weight: number,
};

export function make_${tag}(id: number): Rec_${tag} {
  return { id, name: "rec-${tag}-" + id, tags: ["${tag}"], weight: id * 1.5 };
}

export function fold_${tag}(xs: ReadonlyArray<number>): number {
  return xs.reduce((acc, x) => acc + x * 2 - 1, 0);
}

export function classify_${tag}(r: Rec_${tag}): "light" | "heavy" {
  return r.weight > 10 ? "heavy" : "light";
}

export function merge_${tag}(a: Rec_${tag}, b: Rec_${tag}): Rec_${tag} {
  return { id: a.id + b.id, name: a.name + "+" + b.name, tags: [...a.tags, ...b.tags], weight: a.weight + b.weight };
}

export const SEED_${tag} = ${seed};
`;

const readPkg = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const wsDeps = (pkg) =>
  Object.entries(pkg.dependencies || {})
    .filter(([, spec]) => String(spec).startsWith("workspace:"))
    .map(([name]) => name);
const libSymOf = (libName) => {
  const m = /^@demo\/lib-(\d+)$/.exec(libName);
  if (!m) fail(`unexpected lib dep name: ${libName}`);
  return `lib${m[1]}Main`;
};

let emitted = 0;
// libs: mod-NN mirrors + an index with the same re-exports, dep imports, and
// libSym function (the foundation-rev surface the gate revs)
const libDirs = readdirSync(join(TS_TREE, "packages")).sort();
if (libDirs.length !== LIBS) fail(`expected ${LIBS} lib dirs, found ${libDirs.length}`);
for (const dir of libDirs) {
  const src = join(TS_TREE, "packages", dir, "src");
  const mods = readdirSync(src).filter((f) => /^mod-\d+\.ts$/.test(f));
  const pkg = readPkg(join(TS_TREE, "packages", dir));
  const deps = wsDeps(pkg);
  const tagBase = dir.replace(/^lib-/, "");
  const out = join(FLOW_TREE, "packages", dir, "src");
  mkdirSync(out, { recursive: true });
  for (let m = 1; m <= mods.length; m++) {
    const tag = `${tagBase}_${String(m).padStart(2, "0")}`;
    writeFileSync(
      join(out, `mod-${String(m).padStart(2, "0")}.js`),
      flowModule(tag, 0, `// ${pkg.name} module ${m}`),
    );
    emitted++;
  }
  const reexports = Array.from(
    { length: mods.length },
    (_, m) => `export * from "./mod-${String(m + 1).padStart(2, "0")}";`,
  ).join("\n");
  const depImports = deps.map((d) => `import { ${libSymOf(d)} } from "${d}";`).join("\n");
  const depCalls = deps.length ? deps.map((d) => `${libSymOf(d)}(seed)`).join(" + ") : "0";
  const sym = `lib${tagBase}Main`;
  writeFileSync(
    join(out, "index.js"),
    `// @flow
${reexports}
import { fold_${tagBase}_01, SEED_${tagBase}_01 } from "./mod-01";
${depImports}

export function ${sym}(seed: number): number {
  const base = fold_${tagBase}_01([seed, SEED_${tagBase}_01, seed * 2]);
  return base + ${depCalls};
}
`,
  );
  emitted++;
}

// apps: per-app modules + an entry importing every workspace dep and calling
// its libSym with ONE argument (the call the breaking rev must turn red)
const appDirs = readdirSync(join(TS_TREE, "apps")).sort();
if (appDirs.length !== APPS) fail(`expected ${APPS} app dirs, found ${appDirs.length}`);
let appEntryFiles = [];
for (const dir of appDirs) {
  const pkg = readPkg(join(TS_TREE, "apps", dir));
  const deps = wsDeps(pkg).filter((d) => d.startsWith("@demo/lib-"));
  // generated apps keep their extra modules in lib/ (page imports "../lib/mod-NN")
  const appMods = readdirSync(join(TS_TREE, "apps", dir, "lib")).filter((f) => /\.ts$/.test(f));
  const out = join(FLOW_TREE, "apps", dir);
  mkdirSync(join(out, "modules"), { recursive: true });
  const tagBase = `a${dir.replace(/^app-/, "")}`;
  for (let m = 1; m <= appMods.length; m++) {
    const tag = `${tagBase}_${String(m).padStart(2, "0")}`;
    writeFileSync(
      join(out, "modules", `mod-${String(m).padStart(2, "0")}.js`),
      flowModule(tag, 0, `// ${pkg.name} module ${m}`),
    );
    emitted++;
  }
  const depImports = deps.map((d) => `import { ${libSymOf(d)} } from "${d}";`).join("\n");
  const modImports = Array.from(
    { length: appMods.length },
    (_, m) =>
      `import { SEED_${tagBase}_${String(m + 1).padStart(2, "0")} } from "./modules/mod-${String(m + 1).padStart(2, "0")}";`,
  ).join("\n");
  const calls = deps.map((d) => `${libSymOf(d)}(7)`).join(" + ") || "0";
  const seeds =
    Array.from(
      { length: appMods.length },
      (_, m) => `SEED_${tagBase}_${String(m + 1).padStart(2, "0")}`,
    ).join(" + ") || "0";
  writeFileSync(
    join(out, "entry.js"),
    `// @flow
${depImports}
${modImports}

export function render_${tagBase}(): number {
  return ${calls} + ${seeds};
}
`,
  );
  appEntryFiles.push(join(out, "entry.js"));
  emitted++;
}

writeFileSync(
  join(FLOW_TREE, ".flowconfig"),
  `[options]
module.name_mapper='^@demo/\\(.*\\)$' -> '<PROJECT_ROOT>/packages/\\1/src/index'
[ignore]
`,
);
const mirrorMs = Math.round(Number(process.hrtime.bigint() - t0m) / 1e6);
console.log(`  mirrored ${emitted} files in ${mirrorMs}ms`);

// ---- RSS sampler: summed VmHWM peaks of this run's flow process tree ------
function startRssSampler() {
  // spawnSync blocks the node event loop, so an in-process timer never fires.
  // Sample from a detached shell loop instead: it appends "pid kb" lines to a
  // scratch file every 500ms; stop() kills it and folds max-per-pid.
  const out = join(WORK, `rss-sample-${process.pid}.log`);
  rmSync(out, { force: true });
  let child;
  child = spawn(
    "bash",
    [
      "-c",
      // match the exact checker binary path, not substring "flow": the bench
      // driver, tee, and this loop itself all carry "flow" in their cmdlines,
      // and short-lived awk/find children would otherwise accumulate per-pid
      // peaks across polls
      `while :; do for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case "$c" in ${FLOW}*|*" ${FLOW}"*) awk -v pid=$p '/VmHWM/{print pid, $2}' $p/status 2>/dev/null;; esac; done; sleep 0.5; done >> ${JSON.stringify(out)}`,
    ],
    { stdio: "ignore", detached: true },
  );
  liveSamplers.add(child.pid);
  return {
    stop() {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      try {
        child.kill("SIGKILL");
      } catch {}
      liveSamplers.delete(child.pid);
      let sum = 0;
      try {
        const peaks = new Map();
        for (const line of readFileSync(out, "utf8").split("\n")) {
          const m = /^(\S+) (\d+)$/.exec(line.trim());
          if (m) peaks.set(m[1], Math.max(peaks.get(m[1]) || 0, +m[2]));
        }
        for (const v of peaks.values()) sum += v;
        rmSync(out, { force: true });
      } catch {}
      return sum ? Math.round(sum / 1024) : null; // MB
    },
  };
}

const flowStop = () =>
  spawnSync(FLOW, ["stop"], { cwd: FLOW_TREE, stdio: "ignore", timeout: 60000 });
function flowCheck(label) {
  flowStop(); // one-shot check spawns its own fresh server — no warm carryover
  const sampler = startRssSampler();
  const t0 = process.hrtime.bigint();
  // --json: structured errors survive output-format drift between flow builds
  // (the Rust port's text summary differs from the OCaml-era phrasing)
  const r = spawnSync(FLOW, ["check", "--json"], {
    cwd: FLOW_TREE,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout: 3600000,
  });
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const maxRssMB = sampler.stop();
  if (r.signal)
    fail(`flow check (${label}) killed by ${r.signal} — harness fault, not a measurement`);
  // server-startup progress goes to stderr; the JSON document is stdout
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    fail(
      `flow check (${label}) produced no parseable --json document (exit ${r.status}):\n` +
        `stdout tail: ${(r.stdout || "").slice(-300)}\nstderr tail: ${(r.stderr || "").slice(-300)}`,
    );
  }
  const errs = (doc.errors || []).filter((e) => (e.level ?? "error") === "error");
  const errors = errs.length;
  const ok = doc.passed === true && r.status === 0;
  if (!ok && errors === 0)
    fail(`flow check (${label}) not passed yet zero errors (exit ${r.status}) — tooling fault`);
  const paths = errs.flatMap((e) => (e.message || []).map((m) => m.path || ""));
  const appsWithErrors = new Set(paths.map((p) => /apps\/(app-\d+)\//.exec(p)?.[1]).filter(Boolean))
    .size;
  const first = errs[0]?.message?.map((m) => `${m.path}:${m.line} ${m.descr}`).join(" | ");
  return {
    ms,
    ok,
    errors,
    appsWithErrors,
    maxRssMB,
    sample: first?.slice(0, 200) || null,
  };
}

// ---- gates (untimed) ------------------------------------------------------
console.log("## gates: flow ls count + seeded-error control");
const lsOut = execFileSync(FLOW, ["ls"], { cwd: FLOW_TREE, encoding: "utf8", maxBuffer: 1 << 28 });
const lsCount = lsOut.split("\n").filter((l) => l.trim().endsWith(".js")).length;
if (lsCount !== emitted)
  fail(`flow ls sees ${lsCount} files, expected exactly ${emitted} — mirror or flowconfig hole`);
const seedTarget = appEntryFiles[appEntryFiles.length - 1];
const seedOrig = readFileSync(seedTarget, "utf8");
writeFileSync(seedTarget, seedOrig + `\nconst _bad: string = 42;\n`);
const seeded = flowCheck("seeded control");
writeFileSync(seedTarget, seedOrig);
if (seeded.ok || !seeded.errors)
  fail(`seeded type error not caught (ok=${seeded.ok} errors=${seeded.errors}) — vacuous check`);
console.log(`  ls=${lsCount} files exact; seeded control red (${seeded.errors} errors) ✓`);

// ---- timed rows -----------------------------------------------------------
// the foundation lib: the lowest lib index (fleet preset --universal 5 makes
// libs 001..005 universal for apps; rev + break lib-001 exactly like the gate)
const foundationIdx = join(FLOW_TREE, "packages", libDirs[0], "src", "index.js");
const foundationOrig = readFileSync(foundationIdx, "utf8");
const sym = /export function (lib\d+Main)\(/.exec(foundationOrig)?.[1];
if (!sym) fail("could not find foundation libSym in the mirror");

console.log("## check: one flow check over the whole mirror (non-breaking foundation rev)");
writeFileSync(foundationIdx, foundationOrig + `\nexport const _rev = 1;\n`);
const check = flowCheck("clean");
if (!check.ok) fail(`clean check must be green: ${check.errors} errors, sample ${check.sample}`);
console.log(`  ${check.ms}ms, ${check.maxRssMB ?? "?"}MB flow-tree peak RSS`);

console.log("## breaking: foundation arity break must turn every app red");
writeFileSync(
  foundationIdx,
  foundationOrig.replace(
    `export function ${sym}(seed: number)`,
    `export function ${sym}(seed: number, scale: number)`,
  ),
);
const breaking = flowCheck("breaking");
writeFileSync(foundationIdx, foundationOrig);
const caught = !breaking.ok && breaking.appsWithErrors === APPS;
if (!caught)
  fail(
    `breaking rev not caught by flow: ok=${breaking.ok} appsWithErrors=${breaking.appsWithErrors}/${APPS} sample=${breaking.sample}`,
  );
console.log(
  `  caught=true: ${breaking.appsWithErrors}/${APPS} apps red, ${breaking.errors} errors, in ${breaking.ms}ms`,
);

// ---- server rows: Flow's real mechanic, the persistent server ---------------
// The batch rows above are one-shot `flow check`; Flow's daily model is a
// resident server answering edits incrementally (tsgo-scale-bench mechanics:
// `start --wait` = serverInitMs, then `status` / `force-recheck` + `status`).
// The money row: a breaking foundation edit discovered INCREMENTALLY across
// every app — the same verdict the 90s batch row produces, priced at the
// server's edit-to-red latency.
console.log("## server rows: init, no-change, one-edit, incremental breaking rev");
const statusJson = (label) => {
  const r = spawnSync(FLOW, ["status", "--no-auto-start", "--json"], {
    cwd: FLOW_TREE,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout: 3600000,
  });
  if (r.signal) fail(`flow status (${label}) killed by ${r.signal} — harness fault`);
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    fail(
      `flow status (${label}) produced no JSON (exit ${r.status}): ${(r.stderr || "").slice(-300)}`,
    );
  }
  const errs = (doc.errors || []).filter((e) => (e.level ?? "error") === "error");
  const paths = errs.flatMap((e) => (e.message || []).map((m) => m.path || ""));
  return {
    passed: doc.passed === true,
    errors: errs.length,
    appsWithErrors: new Set(paths.map((p) => /apps\/(app-\d+)\//.exec(p)?.[1]).filter(Boolean))
      .size,
  };
};
const forceRecheck = (file) => {
  const r = spawnSync(FLOW, ["force-recheck", "--no-auto-start", file], {
    cwd: FLOW_TREE,
    encoding: "utf8",
    timeout: 600000,
  });
  if (r.status !== 0) fail(`flow force-recheck failed: ${(r.stderr || "").slice(-300)}`);
};

flowStop(); // fresh server: init cost measured from nothing
const initSampler = startRssSampler();
const init = (() => {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(FLOW, ["start", "--wait"], {
    cwd: FLOW_TREE,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    timeout: 3600000,
  });
  if (r.status !== 0) fail(`flow start --wait failed: ${(r.stderr || "").slice(-400)}`);
  return { ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6) };
})();
const initRssMB = initSampler.stop();
const s0 = statusJson("post-init");
if (!s0.passed) fail(`server not green after init (${s0.errors} errors) — tree should be clean`);
console.log(`  serverInit: ${init.ms}ms, ${initRssMB ?? "?"}MB peak RSS; status green ✓`);

const noChange = timed(() => statusJson("no-change"));
if (!noChange.r.passed) fail("no-change status went red — server state fault");
console.log(`  incrNoChange: ${noChange.ms}ms`);

// one-edit (non-breaking): append an export, recheck, must stay green
writeFileSync(foundationIdx, foundationOrig + `\nexport const _rev2 = 2;\n`);
const oneEdit = timed(() => {
  forceRecheck(foundationIdx);
  return statusJson("one-edit");
});
if (!oneEdit.r.passed) fail(`one-edit recheck went red (${oneEdit.r.errors} errors)`);
console.log(`  incrOneEdit (green): ${oneEdit.ms}ms`);
writeFileSync(foundationIdx, foundationOrig);
forceRecheck(foundationIdx);
if (!statusJson("restore").passed) fail("server not green after restore — state fault");

// incremental BREAKING rev: edit-to-red latency for the whole-fleet verdict
writeFileSync(
  foundationIdx,
  foundationOrig.replace(
    `export function ${sym}(seed: number)`,
    `export function ${sym}(seed: number, scale: number)`,
  ),
);
const incrBreak = timed(() => {
  forceRecheck(foundationIdx);
  return statusJson("incremental-breaking");
});
const incrCaught = !incrBreak.r.passed && incrBreak.r.appsWithErrors === APPS;
if (!incrCaught)
  fail(
    `incremental breaking rev not caught: passed=${incrBreak.r.passed} apps=${incrBreak.r.appsWithErrors}/${APPS}`,
  );
console.log(
  `  incrBreaking: caught=true, ${incrBreak.r.appsWithErrors}/${APPS} apps red (${incrBreak.r.errors} errors) in ${incrBreak.ms}ms`,
);
// un-break and re-green untimed, so the row above timed error DISCOVERY, not replay
writeFileSync(foundationIdx, foundationOrig);
forceRecheck(foundationIdx);
if (!statusJson("re-green").passed) fail("server not green after un-break — state fault");
const serverRows = {
  initMs: init.ms,
  initRssMB,
  noChangeMs: noChange.ms,
  oneEditGreenMs: oneEdit.ms,
  breakingIncrMs: incrBreak.ms,
  breakingIncrErrors: incrBreak.r.errors,
  breakingIncrApps: incrBreak.r.appsWithErrors,
};

// ---- record ---------------------------------------------------------------
const result = {
  apps: APPS,
  libs: LIBS,
  shape: "fleet (Flow-dialect mirror; entry = typed composition, no JSX)",
  files: emitted,
  mirrorMs,
  flow: {
    version: flowVersion,
    bin: FLOW_BIN ? "FLOW_BIN" : `flow-bin@${FLOW_VERSION}`,
    source: FLOW_SOURCE || null,
  },
  cores: CORES,
  preRunLoadAvg1: +LOAD1.toFixed(2),
  gates: { flowLs: lsCount, seededErrors: seeded.errors },
  check: { ms: check.ms, maxRssMB: check.maxRssMB },
  server: serverRows,
  breaking: {
    caught,
    ms: breaking.ms,
    errors: breaking.errors,
    appsWithErrors: breaking.appsWithErrors,
    sample: breaking.sample,
  },
};
mkdirSync(join(REPO, "bench"), { recursive: true });
const outFile = CANONICAL ? "bench/fleet-flow-bench.json" : "bench/fleet-flow-bench.partial.json";
writeFileSync(join(REPO, outFile), JSON.stringify(result, null, 2) + "\n");
console.log(`\n--- ${outFile} written ---`);

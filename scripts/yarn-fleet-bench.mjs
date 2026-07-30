#!/usr/bin/env node
// yarn 4 on the fleet shape: what the optimal stack leaves on the table.
// TOOLING.md measured the two blockers — stock tsgo and Turbopack fail under
// Plug'n'Play — and their green paths (a patched tsgo with native PnP,
// microsoft/typescript-go#1966). This bench prices the yarn-4 alternative at
// full fleet scale (30,000 apps / 460 libs): the install profile under BOTH
// linkers (PnP writes one resolution table instead of a 30k-package
// node_modules farm), and the whole-program type gate run THROUGH PnP with the
// patched tsgo — same scenario, same assertions as the fleet gate
// (bench/fleet-gate-bench.json): a breaking foundation rev must turn every
// app red. The tree and devDependency set match the fleet gate's exactly
// (--tsgo-task; turbo + typescript + native-preview + oxlint), so the install
// rows are comparable with that record's bun install against the same
// workload; the STATE differs per row and is labeled (trulyCold here = fresh
// global cache + no lockfile + network; the gate's bun number is warm-store).
//
//   TSGO_PNP_BIN=<patched tsgo> node scripts/yarn-fleet-bench.mjs fleet
//   node scripts/yarn-fleet-bench.mjs fleet:3000     # scaled -> partial json
//
// Rows:
//   install.pnp   trulyColdMs (no lockfile, fresh YARN_GLOBAL_FOLDER, network;
//                 the fresh cache is asserted populated after) + warmMs
//                 (lockfile + populated cache, install outputs wiped) — plus
//                 the .pnp.cjs byte size
//   install.nm    the same two rows under nodeLinker: node-modules, plus the
//                 full node_modules descendant count (install-bench's metric)
//   gate          under PnP, patched tsgo: untimed warmup, timed clean run
//                 (wall + peak RSS via GNU time), breaking foundation rev
//                 (appsWithErrors === APPS + TS2554, not merely a red exit)
//   stockControl  the repo's pinned stock tsgo through `yarn tsgo` on the same
//                 PnP tree — must FAIL with unresolved-module errors (the
//                 measured pnp-compat boundary); a signal/ENOBUFS death is a
//                 harness fault, never the expected failure
//
// Network-order note: the PnP rows run before the node-modules rows, so the
// two trulyCold samples hit the network in that fixed order (recorded).
// Canonical record (bench/yarn-fleet-bench.json) only at 30,000 apps with
// TSGO_PNP_BIN set; anything else lands in the gitignored partial. Patched-tsgo
// provenance (git sha of its checkout + binary sha256) is recorded so the
// dataset says exactly what ran.
//
// Destructive: overwrites the root package.json, writes .yarnrc.yml, and
// regenerates the tree — REFUSES to run outside a linked git worktree and
// restores what it mutates on exit (including the revved foundation source).
// Core-bound: refuses on a loaded box unless YARN_FLEET_ALLOW_BUSY=1.

import { execSync, execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { availableParallelism, arch, loadavg } from "node:os";
import { createHash } from "node:crypto";
import { YARN_VERSION } from "./_pins.mjs";
import { yarnEnv, fetchYarnCli, writeYarnRc, benchOutput, loadGuard } from "./_pm-bench-lib.mjs";

const spec = (process.argv[2] || "fleet").trim();
const fleetM = spec.match(/^fleet(?::(\d+))?$/);
if (!fleetM) {
  console.error(`usage: yarn-fleet-bench.mjs fleet[:<apps>]  (got "${spec}")`);
  process.exit(1);
}
const APPS = +(fleetM[1] || 30000);
const LIBS = 460;
const ROOT = process.cwd();
const PKG = join(ROOT, "package.json");
const TSGO_PNP_BIN = process.env.TSGO_PNP_BIN || "";
const CANONICAL = APPS === 30000 && !!TSGO_PNP_BIN;

// destructive -> linked worktree only (same guard as optimal-gate-bench)
const gitDir = execSync("git rev-parse --git-dir", { cwd: ROOT, encoding: "utf8" }).trim();
if (!gitDir.includes("worktrees")) {
  console.error(
    "refusing to run outside a dedicated git worktree — it overwrites package.json and the tree.",
  );
  process.exit(1);
}
loadGuard("YARN_FLEET_ALLOW_BUSY");
const preRunLoadAvg1 = +loadavg()[0].toFixed(2);

// preflight the patched binary BEFORE any expensive phase: a bad path must
// fail in seconds, not after two 30k installs
let tsgoPatchedVersion = null;
if (TSGO_PNP_BIN) {
  if (!existsSync(TSGO_PNP_BIN)) {
    console.error(`TSGO_PNP_BIN does not exist: ${TSGO_PNP_BIN}`);
    process.exit(1);
  }
  tsgoPatchedVersion = execFileSync(TSGO_PNP_BIN, ["--version"], { encoding: "utf8" }).trim();
}

const SCRATCH = join(ROOT, ".yarn-fleet-scratch");
mkdirSync(SCRATCH, { recursive: true });
const env = yarnEnv({
  CI: "false", // yarn auto-enables immutable installs under CI; a bare timed install must not fail closed here
  NEXT_TELEMETRY_DISABLED: "1",
});
const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...opts });
const timed = (fn) => {
  const t0 = process.hrtime.bigint();
  const r = fn();
  return { ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), r };
};

// (used by both the nm control and the PnP gate)
// classify a checker death honestly: signal / 128+ / ENOBUFS is a harness
// fault, never a verdict (neither the gate's green nor the control's red)
const runChecker = (argv, label) => {
  // spawnSync: stdout AND stderr on every path (GNU time reports on stderr,
  // and execFileSync returns only stdout when the child exits 0)
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (r.error?.code === "ENOBUFS")
    throw new Error(`${label}: output exceeded capture buffer — harness fault, not a verdict`);
  if (r.error) throw new Error(`${label}: spawn failed: ${r.error.message}`);
  if (r.signal || (r.status != null && r.status >= 128))
    throw new Error(
      `${label}: checker killed (${r.signal ?? r.status}) — harness fault, not a verdict`,
    );
  return { out: (r.stdout || "") + (r.stderr || ""), code: r.status ?? 1 };
};
function wholeProgram(label) {
  const t0 = process.hrtime.bigint();
  const { out, code } = runChecker(
    ["/usr/bin/time", "-v", TSGO_PNP_BIN, "--noEmit", "-p", "tsconfig.whole.json"],
    label,
  );
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const sig = out.match(/Command terminated by signal\s+(\d+)/);
  if (sig) throw new Error(`${label}: checker killed by signal ${sig[1]} — harness fault`);
  const rssKb = +(out.match(/Maximum resident set size \(kbytes\): (\d+)/) || [])[1] || null;
  return {
    ms,
    ok: code === 0,
    maxRssMB: rssKb ? Math.round(rssKb / 1024) : null,
    errors: (out.match(/error TS\d+/g) || []).length,
    ts2554: (out.match(/error TS2554/g) || []).length,
    appsWithErrors: new Set(out.match(/apps\/app-\d+\//g) || []).size,
    sample: (out.match(/error TS\d+[^\n]*/) || [])[0] || null,
  };
}

// ---- restore-on-exit (registered before anything mutates) -------------------
const origPkg = readFileSync(PKG, "utf8");
const RC = join(ROOT, ".yarnrc.yml");
const WHOLE = join(ROOT, "tsconfig.whole.json");
const foundationFile = join(ROOT, "packages", "lib-001", "src", "index.ts");
let origFoundation = null; // captured after generation
let restored = false;
function restoreAll() {
  if (restored) return;
  restored = true;
  writeFileSync(PKG, origPkg);
  if (origFoundation != null && existsSync(foundationFile))
    writeFileSync(foundationFile, origFoundation);
  for (const f of [
    RC,
    WHOLE,
    join(ROOT, "yarn.lock"),
    join(ROOT, ".pnp.cjs"),
    join(ROOT, ".pnp.loader.mjs"),
  ])
    rmSync(f, { force: true });
  rmSync(join(ROOT, ".yarn"), { recursive: true, force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
}
process.on("exit", restoreAll);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// ---- generate the fleet tree (workload-matched to the fleet gate) -----------
console.log(`# yarn-fleet: ${APPS} apps / ${LIBS} libs (yarn ${YARN_VERSION}, PnP + node-modules)`);
const genOut = sh(
  `node scripts/generate.mjs --preset fleet${APPS !== 30000 ? ` --apps ${APPS}` : ""} --tsgo-task --clean`,
  { encoding: "utf8" },
);
let gen;
try {
  gen = JSON.parse(genOut.trim().split("\n").pop());
} catch {
  throw new Error(`could not parse generator summary:\n${genOut.slice(-300)}`);
}
// generate.mjs honors env overrides; assert every knob this record claims, so
// an ambient MODULES/APP_MODULES/SHAPE/FRAMEWORK can't fake a fleet record
const expected = {
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
  tsgoTask: true,
  testTask: false,
  versioned: false,
  skew: 0,
};
for (const [k, v] of Object.entries(expected)) {
  if (gen[k] !== v)
    throw new Error(`generated shape drifted (env override?): ${k}=${gen[k]}, expected ${v}`);
}
origFoundation = readFileSync(foundationFile, "utf8");
// yarn reads neither pnpm-workspace.yaml catalogs nor bun package.json catalogs
sh(`node scripts/rewrite-protocols.mjs --dir apps --catalog ${join(ROOT, "pnpm-workspace.yaml")}`);
sh(
  `node scripts/rewrite-protocols.mjs --dir packages --catalog ${join(ROOT, "pnpm-workspace.yaml")}`,
);

// ---- yarn workspace root ------------------------------------------------------
const toolchain = JSON.parse(origPkg).devDependencies;
const YARN = fetchYarnCli(SCRATCH, YARN_VERSION);
const yarnVer = execFileSync("node", [YARN, "--version"], { encoding: "utf8" }).trim();
if (yarnVer !== YARN_VERSION)
  throw new Error(`yarn pin drift: wanted ${YARN_VERSION}, got ${yarnVer}`);

writeFileSync(
  PKG,
  JSON.stringify(
    {
      name: "yarn-fleet-bench",
      private: true,
      packageManager: `yarn@${YARN_VERSION}`,
      workspaces: ["apps/*", "packages/*"],
      // the fleet gate's exact devDependency set, so the install workload is
      // comparable with bench/fleet-gate-bench.json's bun install; stock tsgo
      // riding the workspace is also what `yarn tsgo` resolves THROUGH PnP for
      // the control row
      devDependencies: {
        turbo: toolchain.turbo,
        typescript: toolchain.typescript,
        "@typescript/native-preview": toolchain["@typescript/native-preview"],
        oxlint: toolchain.oxlint ?? "latest",
      },
    },
    null,
    2,
  ) + "\n",
);

const OUT = benchOutput(ROOT, "bench/yarn-fleet-bench.partial.json", "bench/yarn-fleet-bench.json");
const result = {
  apps: APPS,
  libs: LIBS,
  shape: "fleet",
  machine: { cores: availableParallelism(), arch: arch() },
  preRunLoadAvg1,
  versions: { yarn: yarnVer, node: process.version },
  netOrder: ["pnp", "node-modules"],
  install: {},
};

// ---- install rows, per linker ------------------------------------------------
// cleanup is fail-closed: a leftover node_modules would make the warm row a
// partial no-op and could let the PnP gate resolve through it
const wipeInstallOutputs = () => {
  execFileSync(
    "find",
    [".", "-name", "node_modules", "-type", "d", "-prune", "-exec", "rm", "-rf", "{}", "+"],
    { cwd: ROOT },
  );
  for (const f of [".pnp.cjs", ".pnp.loader.mjs"]) rmSync(join(ROOT, f), { force: true });
  rmSync(join(ROOT, ".yarn", "install-state.gz"), { force: true });
};
// writeYarnRc semantics (see _pm-bench-lib): pinImmutable TRUE emits
// `enableImmutableInstalls: false` — pinned OFF so an ancestor/home yarn
// config can't flip a timed no-lockfile install into a fail-closed error
const globalCacheFor = (linker) => join(SCRATCH, `yarn-global-${linker}`);
function installRows(linker) {
  console.log(`\n## install: yarn ${YARN_VERSION}, nodeLinker=${linker}`);
  writeYarnRc(ROOT, linker, { pinImmutable: true });
  const cache = globalCacheFor(linker);
  rmSync(cache, { recursive: true, force: true });
  rmSync(join(ROOT, "yarn.lock"), { force: true });
  wipeInstallOutputs();
  const rowEnv = { ...env, YARN_GLOBAL_FOLDER: cache };
  const trulyCold = timed(() =>
    execFileSync("node", [YARN, "install"], { cwd: ROOT, env: rowEnv, maxBuffer: 1 << 28 }),
  );
  // trulyCold is only truly cold if the fresh global folder took the download
  const populated =
    existsSync(join(cache, "cache")) &&
    execSync(`find ${JSON.stringify(join(cache, "cache"))} -type f | head -1 | wc -l`, {
      encoding: "utf8",
    }).trim() === "1";
  if (!populated)
    throw new Error(`trulyCold ${linker} install did not populate its fresh global cache`);
  wipeInstallOutputs();
  const warm = timed(() =>
    execFileSync("node", [YARN, "install"], { cwd: ROOT, env: rowEnv, maxBuffer: 1 << 28 }),
  );
  // completeness AFTER the timed installs (untimed): an exit-0 install can be
  // partial; the shared verifier walks every workspace package's deps (nm walk
  // or PnP resolver — it handles both linkers)
  const v = spawnSync("node", [join(ROOT, "scripts", "_verify-install.cjs"), ROOT], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (v.status !== 0)
    throw new Error(
      `${linker} install incomplete per _verify-install: ${(v.stdout || v.stderr || "").slice(-400)}`,
    );
  const rows = { trulyColdMs: trulyCold.ms, warmMs: warm.ms };
  if (linker === "pnp") {
    rows.pnpCjsBytes = statSync(join(ROOT, ".pnp.cjs")).size;
    if (existsSync(join(ROOT, "node_modules")))
      throw new Error("PnP install produced a node_modules");
  } else {
    // install-bench's exact metric: every path under any node_modules,
    // fail-closed on find errors (a failed count must not read as 0)
    const r = spawnSync(
      "bash",
      ["-c", "set -o pipefail; find . -path '*/node_modules/*' -printf '.' | wc -c"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 },
    );
    if (r.error || r.status !== 0)
      throw new Error(`nm entry count failed: ${r.error?.message || r.stderr || r.status}`);
    rows.nmEntries = parseInt((r.stdout || "").trim(), 10);
    if (!Number.isFinite(rows.nmEntries)) throw new Error("nm entry count non-numeric");
  }
  console.log(
    `  trulyCold ${trulyCold.ms}ms · warm ${warm.ms}ms${rows.pnpCjsBytes ? ` · .pnp.cjs ${rows.pnpCjsBytes}B` : ""}${rows.nmEntries ? ` · nm descendants ${rows.nmEntries}` : ""}`,
  );
  return rows;
}

result.install.pnp = installRows("pnp");
OUT.persist(result);
result.install.nodeModules = installRows("node-modules");
OUT.persist(result);

// the same-binary linker control: the patched tsgo over the yarn NODE-MODULES
// tree it just installed — same binary, same tree, only the linker differs.
// This is what isolates PnP's cost from build differences at fleet scale.
if (TSGO_PNP_BIN) {
  console.log("\n## control: patched tsgo over the node-modules tree (same binary, same tree)");
  writeFileSync(
    WHOLE,
    JSON.stringify(
      {
        extends: "./tsconfig.base.json",
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          jsx: "preserve",
          noEmit: true,
          declaration: false,
          allowJs: true,
          paths: { "@demo/*": ["./packages/*/src/index.ts"] },
        },
        include: ["apps/*/**/*.ts", "apps/*/**/*.tsx", "packages/*/src/**/*.ts"],
        exclude: ["node_modules", "**/.next"],
      },
      null,
      2,
    ) + "\n",
  );
  wholeProgram("warmup-nm"); // untimed
  const nmGate = wholeProgram("clean-nm");
  if (!nmGate.ok)
    throw new Error(
      `patched tsgo not green over node-modules: ${nmGate.errors} errors, ${nmGate.sample}`,
    );
  result.gateNodeModules = {
    tool: "tsgo patched, node-modules linker",
    ms: nmGate.ms,
    maxRssMB: nmGate.maxRssMB,
  };
  console.log(`  clean (nm): ${nmGate.ms}ms, ${nmGate.maxRssMB}MB peak RSS`);
  OUT.persist(result);
}

// return to the PnP state for the gate rows — reuse the populated PnP cache
// and the same env (no late network surprises), wiping only install outputs
console.log("\n## restore PnP state for the gate");
writeYarnRc(ROOT, "pnp", { pinImmutable: true });
wipeInstallOutputs();
rmSync(join(ROOT, "yarn.lock"), { force: true });
execFileSync("node", [YARN, "install"], {
  cwd: ROOT,
  env: { ...env, YARN_GLOBAL_FOLDER: globalCacheFor("pnp") },
  maxBuffer: 1 << 28,
});

// ---- the whole-program gate under PnP ----------------------------------------
// Same program shape as the fleet gate: workspace libs resolve via `paths`
// (source), EXTERNAL packages (react, next types) resolve through .pnp.cjs —
// exactly the resolution stock tsgo cannot do and the patched tsgo can.
writeFileSync(
  WHOLE,
  JSON.stringify(
    {
      extends: "./tsconfig.base.json",
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "preserve",
        noEmit: true,
        declaration: false,
        allowJs: true,
        paths: { "@demo/*": ["./packages/*/src/index.ts"] },
      },
      include: ["apps/*/**/*.ts", "apps/*/**/*.tsx", "packages/*/src/**/*.ts"],
      exclude: ["node_modules", "**/.next"],
    },
    null,
    2,
  ) + "\n",
);

// stock control first: the pinned stock tsgo THROUGH PnP must fail unresolved
console.log("\n## stock control: pinned stock tsgo through PnP (must fail unresolved)");
const stockRun = runChecker(
  ["node", YARN, "tsgo", "--noEmit", "-p", "tsconfig.whole.json"],
  "stock control",
);
const stock = {
  exit: stockRun.code,
  // per-code histogram, so the doc claim about the error mix is provable
  ts2307: (stockRun.out.match(/error TS2307/g) || []).length,
  ts2503: (stockRun.out.match(/error TS2503/g) || []).length,
  ts2688: (stockRun.out.match(/error TS2688/g) || []).length,
  sample: (stockRun.out.match(/error TS\d+[^\n]*/) || [])[0] || null,
};
stock.unresolved = stock.ts2307 + stock.ts2503 + stock.ts2688;
if (stock.exit === 0)
  throw new Error(
    "stock tsgo PASSED under PnP — the upstream gap closed; retire the boundary claim and rework this control",
  );
if (stock.unresolved === 0)
  throw new Error(
    `stock control failed WITHOUT unresolved-class errors (exit ${stock.exit}, sample ${stock.sample}) — unexpected failure mode, not the measured boundary`,
  );
result.stockControl = stock;
console.log(
  `  stock fails as measured: exit ${stock.exit}, ${stock.unresolved} unresolved-module errors`,
);
OUT.persist(result);

if (!TSGO_PNP_BIN) {
  console.log("\nno TSGO_PNP_BIN — install + stock-control rows only (partial)");
  OUT.persist(result);
  process.exit(0);
}

// patched-tsgo provenance: the dataset must say exactly what ran
const provenance = {
  version: tsgoPatchedVersion,
  sha256: createHash("sha256").update(readFileSync(TSGO_PNP_BIN)).digest("hex"),
};
try {
  provenance.gitSha = execFileSync("git", ["-C", dirname(TSGO_PNP_BIN), "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  provenance.gitBranch = execFileSync(
    "git",
    ["-C", dirname(TSGO_PNP_BIN), "rev-parse", "--abbrev-ref", "HEAD"],
    { encoding: "utf8" },
  ).trim();
} catch {}
result.versions.tsgoPatched = provenance;

console.log("\n## gate: patched tsgo (native PnP), one program over the whole workspace");
try {
  writeFileSync(foundationFile, origFoundation + `\nexport const _rev = 1;\n`);
  wholeProgram("warmup"); // untimed: binary load + first-touch fs
  const clean = wholeProgram("clean");
  if (!clean.ok)
    throw new Error(
      `clean gate must be green under PnP: ${clean.errors} errors, sample ${clean.sample}`,
    );
  if (clean.maxRssMB == null) throw new Error("peak RSS not captured — GNU time missing?");
  result.gate = {
    tool: "tsgo patched (native PnP), one program from src",
    ms: clean.ms,
    maxRssMB: clean.maxRssMB,
  };
  console.log(`  clean: ${clean.ms}ms, ${clean.maxRssMB}MB peak RSS`);

  console.log("\n## breaking rev: every app must go red through PnP");
  const sig = "lib001Main(seed: number)";
  const broken = origFoundation.replace(sig, "lib001Main(seed: number, scale: number)");
  if (broken === origFoundation) throw new Error(`foundation signature "${sig}" not found`);
  writeFileSync(foundationFile, broken);
  const brk = wholeProgram("breaking");
  const caught = !brk.ok && brk.appsWithErrors === APPS && brk.ts2554 > 0;
  if (!caught)
    throw new Error(
      `breaking rev not caught: ok=${brk.ok} apps=${brk.appsWithErrors}/${APPS} ts2554=${brk.ts2554} sample=${brk.sample}`,
    );
  result.breaking = {
    caught,
    ms: brk.ms,
    ts2554: brk.ts2554,
    appsWithErrors: brk.appsWithErrors,
    sample: brk.sample,
  };
  console.log(
    `  caught=true: ${brk.appsWithErrors}/${APPS} apps red, ${brk.ts2554}× TS2554, in ${brk.ms}ms`,
  );
} finally {
  writeFileSync(foundationFile, origFoundation);
}

result.summary = {
  pnpTrulyColdMs: result.install.pnp.trulyColdMs,
  pnpWarmMs: result.install.pnp.warmMs,
  nmTrulyColdMs: result.install.nodeModules.trulyColdMs,
  nmWarmMs: result.install.nodeModules.warmMs,
  gateMs: result.gate.ms,
  gateRssMB: result.gate.maxRssMB,
  breakingCaught: result.breaking.caught,
  breakingMs: result.breaking.ms,
  stockUnresolved: result.stockControl.unresolved,
};
if (CANONICAL) OUT.promote(result);
else OUT.persist(result);
console.log(
  `\n--- ${CANONICAL ? "bench/yarn-fleet-bench.json" : "bench/yarn-fleet-bench.partial.json"} written ---`,
);

#!/usr/bin/env node
// Prices Next builds under Yarn PnP, per builder and per node version. Two
// separate things fail there. (a) Turbopack (Vercel's Rust bundler, the Next 16
// default) has no PnP resolver — its maintainers declined PnP
// (vercel/next.js#42651, closed + locked) — so it cannot resolve
// `next/package.json`; rspack (the Rust webpack-compatible bundler) added PnP
// resolution (web-infra-dev/rspack#13047, #13382) and Next's `next-rspack`
// (`withRspack(config)`) carries it through. (b) On current node 22, `next build`
// under PnP crashes while loading next.config, before a bundler is selected, so
// (a) is not even reached. The bench measures both by building the SAME installed
// PnP trees twice — on the node running the bench and on a pinned older control
// node (CONTROL_NODE, _pins.mjs) — next to a node-modules control:
//
//   PnP, bench node (22.23.3):     turbopack · webpack · rspack all fail at config load
//   PnP, control node (22.22.0):   turbopack (fail: no PnP resolver) · webpack (ok) · rspack (ok)
//   node-modules, bench node:      turbopack (ok) · webpack (ok) · rspack (ok)
//
// Every cell's side is asserted; a cell changing sides (a node or next release
// that fixes or moves the crash) fails the bench, forcing a deliberate update.
//
// Each builder is invoked the one way it works — turbopack/webpack with a plain
// next.config, rspack with a `withRspack(...)` config and no builder flag (the
// plugin only engages when `next build` runs at its TURBOPACK=auto default) —
// and the bench asserts WHICH bundler actually ran (turbopack banner / rspack
// experimental banner) so a misconfigured cell can never read as a false
// success. A build counted "ok" is verified by a populated `.next` output, not
// exit code alone. Build ms are single-sample, diagnostic only: rspack-under-PnP
// vs turbopack-under-node-modules is not like-for-like (different linker AND
// bundler), so no speed ratio is headlined — the pass/fail matrix is the finding.
//
// Self-contained and non-destructive: scaffolds under a btrfs work dir
// (RSPACK_PNP_WORK, default /mnt/fcvm-btrfs/rspack-pnp-bench), removed on exit
// unless RSPACK_PNP_KEEP=1; needs no worktree. Core-bound (rspack is
// multithreaded) — refuses on a loaded box unless RSPACK_PNP_ALLOW_BUSY=1.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { YARN_VERSION } from "./_pins.mjs";
import { fetchYarnCli, loadGuard } from "./_pm-bench-lib.mjs";
import {
  bundlerSignatures,
  ranJsWebpackCompiler,
  outputComplete,
  scrubBundlerEnv,
  duApparentBytes,
  guardWorkDir,
  nextConfigFor,
  cellBanner,
  isPnpConfigLoadCrash,
  isTurbopackPnpResolveFailure,
  turbopackPnpResolveFailureLine,
  CONTROL_NODE_VERSION,
  fetchControlNode,
  envForNode,
  nodeBinDirFor,
  treeInventory,
  inventoryDiff,
} from "./_next-bundler-lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = process.env.RSPACK_PNP_WORK || "/mnt/fcvm-btrfs/rspack-pnp-bench";
const KEEP = process.env.RSPACK_PNP_KEEP === "1";
const NEXT_VERSION = "16.0.1";
const RSPACK_VERSION = "16.0.1"; // next-rspack, versioned in lockstep with next
const REACT_VERSION = "^18.3.1";

const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};

const envInfo = loadGuard("RSPACK_PNP_ALLOW_BUSY");

// The work dir is wiped recursively — refuse a value that would delete the repo,
// $HOME, or a filesystem root by accident.
let WORK_RESOLVED;
try {
  WORK_RESOLVED = guardWorkDir(WORK, REPO);
} catch (e) {
  fail(e.message);
}

rmSync(WORK_RESOLVED, { recursive: true, force: true });
mkdirSync(WORK_RESOLVED, { recursive: true });
process.on("exit", () => {
  if (!KEEP) rmSync(WORK_RESOLVED, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const YARNJS = fetchYarnCli(WORK_RESOLVED, YARN_VERSION);

// Scrub bundler-selection env so a stray host setting can't flip which bundler a
// cell runs (see _next-bundler-lib).
const yarnEnvClean = scrubBundlerEnv(process.env);

function run(cmd, args, cwd, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 27,
    env: { ...yarnEnvClean, ...extraEnv },
  });
  return {
    status: r.status,
    signal: r.signal,
    out: ((r.stdout || "") + (r.stderr || "")).trim(),
  };
}
// Every child runs under an explicit node binary with that binary's dir leading
// PATH: the bench's own node (process.execPath — the node `versions.node` records)
// or the control node. A bare `node` from PATH could be a different release than
// the one recorded.
// `nodeExe` is the executable itself (process.execPath, or the verified control
// binary) — never `<dir>/node` by assumption; nodeBinDirFor asserts the dir that
// leads PATH holds that same release.
const BENCH_NODE = process.execPath;
try {
  nodeBinDirFor(BENCH_NODE, process.version);
} catch (e) {
  fail(e.message);
}
const runUnder = (nodeExe, args, cwd) =>
  run(nodeExe, args, cwd, envForNode(yarnEnvClean, dirname(nodeExe)));
const yarn = (args, cwd) => runUnder(BENCH_NODE, [YARNJS, ...args], cwd);

// --- scaffold ----------------------------------------------------------------
// A plain Next App Router app depending on next + react + react-dom. Under PnP
// these live in cache zips and react-dom is virtualized under .yarn/__virtual__,
// so a successful build proves the bundler resolved zip and virtual paths.
function writeNextScaffold(dir, builder) {
  mkdirSync(join(dir, "app"), { recursive: true });
  const deps = { next: NEXT_VERSION, react: REACT_VERSION, "react-dom": REACT_VERSION };
  if (builder === "rspack") deps["next-rspack"] = RSPACK_VERSION;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "next-rspack-pnp-app",
        private: true,
        packageManager: `yarn@${YARN_VERSION}`,
        dependencies: deps,
        devDependencies: { "@types/react": "^18.3.12", "@types/node": "^20", typescript: "^5.6.0" },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "next.config.js"), nextConfigFor(builder));
  writeFileSync(
    join(dir, "app/layout.tsx"),
    `import type { ReactNode } from "react";\nexport default function RootLayout({ children }: { children: ReactNode }) {\n  return (<html><body>{children}</body></html>);\n}\n`,
  );
  writeFileSync(
    join(dir, "app/page.tsx"),
    `export default function Page() {\n  return <main>hello pnp</main>;\n}\n`,
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "dom.iterable", "esnext"],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: "esnext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "react-jsx",
        },
        include: ["**/*.ts", "**/*.tsx"],
        exclude: ["node_modules"],
      },
      null,
      2,
    ),
  );
}

function writeYarnrc(dir, linker) {
  // enableImmutableInstalls:false so a CI host (where yarn auto-enables immutable)
  // can still create the lockfile on the first install.
  const lines =
    linker === "pnp"
      ? ["nodeLinker: pnp", "enableGlobalCache: false", "compressionLevel: 0"]
      : ["nodeLinker: node-modules", "enableGlobalCache: false"];
  lines.push("enableImmutableInstalls: false");
  writeFileSync(join(dir, ".yarnrc.yml"), lines.join("\n") + "\n");
}

// Scaffold + install one (linker, builder) cell; returns its directory.
function prepareCell(base, linker, builder) {
  const dir = join(base, `${linker}-${builder}`);
  mkdirSync(dir, { recursive: true });
  writeNextScaffold(dir, builder);
  writeYarnrc(dir, linker);
  cpSync(YARNJS, join(dir, "yarn.js"));
  const inst = yarn(["install"], dir);
  if (inst.status !== 0) fail(`install (${linker}/${builder}) failed:\n${inst.out.slice(-800)}`);
  const inlined = existsSync(join(dir, ".pnp.cjs"));
  const nodeModules = existsSync(join(dir, "node_modules"));
  if (linker === "pnp" && !inlined) fail(`pnp install (${builder}) produced no .pnp.cjs`);
  // A PnP install must materialize NO node_modules — otherwise a build could
  // resolve by filesystem walk and the cell would not prove PnP resolution.
  if (linker === "pnp" && nodeModules)
    fail(`pnp install (${builder}) unexpectedly materialized node_modules`);
  if (linker === "nm" && !nodeModules)
    fail(`node-modules install (${builder}) produced no node_modules`);
  return dir;
}

// Build one prepared cell under `nodeExe` (the bench's node, or the control node
// re-running the SAME installed tree). For a PnP tree the bench-node cell runs
// first, on the pristine install; group (1) asserts it left no `.next` behind and
// the tree's file inventory unchanged BEFORE the control node builds it, so the
// control-node build starts from the same tree state.
function buildCell(dir, linker, builder, flag, nodeExe = BENCH_NODE) {
  rmSync(join(dir, ".next"), { recursive: true, force: true });
  const args = [YARNJS, "next", "build", ...(flag ? [flag] : [])];
  const t0 = process.hrtime.bigint();
  const r = runUnder(nodeExe, args, dir);
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const label = `${linker}/${builder}${nodeExe === BENCH_NODE ? "" : ` @ node v${CONTROL_NODE_VERSION}`}`;
  // a killed or unspawnable build has no exit code and is a harness fault — it
  // must never be classified as one of the expected failures
  if (r.signal || typeof r.status !== "number")
    fail(`next build (${label}) did not run to an exit code (signal ${r.signal}) — harness fault`);

  const dotNext = join(dir, ".next");
  // `.next` existing at all (a failing build can leave partial output) is recorded
  // separately from a COMPLETE build
  const dotNextPresent = existsSync(dotNext);
  const outputPresent = outputComplete(dotNext);
  let outputBytes = 0;
  if (dotNextPresent) {
    try {
      outputBytes = duApparentBytes(dotNext);
    } catch (e) {
      fail(`${label}: ${e.message} — harness fault`);
    }
  }
  const sig = bundlerSignatures(r.out);
  const webpackCompilationSpan = ranJsWebpackCompiler(dir);
  const cell = {
    linker,
    builder,
    exit: r.status,
    ok: r.status === 0 && outputPresent,
    ms,
    dotNextPresent,
    outputPresent,
    outputBytes,
    turbopackBanner: sig.turbopackBanner,
    rspackBanner: sig.rspackBanner,
    webpackCompilationSpan,
    // Turbopack's own PnP failure: it cannot resolve next/package.json by fs walk
    pnpResolveFailure: isTurbopackPnpResolveFailure(r.out),
    pnpResolveFailureLine: turbopackPnpResolveFailureLine(r.out),
    // the config-load crash that precedes bundler selection (see _next-bundler-lib)
    configLoadCrash: isPnpConfigLoadCrash(r.out),
  };
  console.log(
    `  ${label}: exit=${cell.exit} ok=${cell.ok} ${cell.ms}ms ` +
      cellBanner(sig, webpackCompilationSpan) +
      (cell.pnpResolveFailure ? " pnp-fail" : "") +
      (cell.configLoadCrash ? " config-crash" : ""),
  );
  // a failed build's output tail goes to the log, so an assert that rejects its
  // classification below is diagnosable from this one run
  if (cell.exit !== 0)
    console.log(
      r.out
        .split("\n")
        .slice(-15)
        .map((l) => `    | ${l.slice(0, 240)}`)
        .join("\n"),
    );
  return cell;
}

// ============================================================================
console.log(
  `rspack PnP bench — yarn ${YARN_VERSION}, next ${NEXT_VERSION}, next-rspack ${RSPACK_VERSION}`,
);
const base = join(WORK, "matrix");
mkdirSync(base, { recursive: true });

const BUILDERS = [
  ["turbopack", null],
  ["webpack", "--webpack"],
  ["rspack", null],
];
let controlBin;
try {
  controlBin = fetchControlNode(WORK_RESOLVED);
} catch (e) {
  fail(e.message);
}
const dirs = { pnp: {}, nm: {} };
for (const linker of ["pnp", "nm"])
  for (const [builder] of BUILDERS) dirs[linker][builder] = prepareCell(base, linker, builder);
const cells = (linker, nodeExe = BENCH_NODE) =>
  Object.fromEntries(
    BUILDERS.map(([builder, flag]) => [
      builder,
      buildCell(dirs[linker][builder], linker, builder, flag, nodeExe),
    ]),
  );
// (1) PnP on this node, built AND asserted before the control node touches the
// trees: every builder fails at config load, before a bundler is selected —
// non-zero exit, the config-load-crash signature, NOT Turbopack's own resolution
// failure, no evidence that any bundler started (no `.next` directory at all, no
// bundler banner, no JS-webpack compilation span), and the installed tree's file
// inventory (path, size, mtime) identical before and after the build.
const pnpBefore = Object.fromEntries(
  BUILDERS.map(([builder]) => [builder, treeInventory(dirs.pnp[builder])]),
);
const pnpCells = cells("pnp");
for (const [builder] of BUILDERS) {
  const c = pnpCells[builder];
  const bundlerStarted =
    c.dotNextPresent ||
    c.outputPresent ||
    c.turbopackBanner ||
    c.rspackBanner ||
    c.webpackCompilationSpan;
  if (c.exit === 0 || c.ok || !c.configLoadCrash || c.pnpResolveFailure || bundlerStarted)
    fail(
      `expected pnp/${builder} on node ${process.version} to fail at config load before any ` +
        `bundler ran — got exit=${c.exit}, configLoadCrash=${c.configLoadCrash}, ` +
        `pnpResolveFailure=${c.pnpResolveFailure}, bundlerStarted=${Boolean(bundlerStarted)}`,
    );
  const changed = inventoryDiff(pnpBefore[builder], treeInventory(dirs.pnp[builder]));
  c.treeUnchanged = changed.length === 0;
  if (!c.treeUnchanged)
    fail(
      `pnp/${builder}: the crashed build changed ${changed.length} path(s) in the installed tree ` +
        `(${changed.slice(0, 10).join(", ")}) — the control node would not build the same tree`,
    );
}

const matrix = {
  // the PnP trees on the node running this bench
  pnp: pnpCells,
  // the SAME installed PnP trees under the pinned older node
  pnpControlNode: { node: `v${CONTROL_NODE_VERSION}`, ...cells("pnp", join(controlBin, "node")) },
  // the node-modules control on the node running this bench
  nm: cells("nm"),
};

// --- assertions --------------------------------------------------------------
// Each successful cell must prove WHICH compiler ran: rspack = the next-rspack
// banner AND no JS webpack-compilation span AND no Turbopack banner; webpack = a
// JS webpack-compilation span AND neither other banner; turbopack = the Turbopack
// banner AND no rspack banner AND no JS webpack-compilation span. The proofs are
// mutually exclusive. The compilation-span check is the load-bearing one:
// it defeats a silent webpack fallback that would still print the rspack banner.
function assertRspack(cell, label) {
  if (!cell.ok) fail(`expected rspack to build (${label})`);
  if (!cell.rspackBanner) fail(`expected the next-rspack banner (${label})`);
  if (cell.turbopackBanner) fail(`unexpected Turbopack banner in an rspack cell (${label})`);
  if (cell.webpackCompilationSpan)
    fail(`rspack cell ran the JS webpack compiler, not rspack (${label})`);
}
function assertWebpack(cell, label) {
  if (!cell.ok) fail(`expected webpack to build (${label})`);
  if (!cell.webpackCompilationSpan)
    fail(`expected a JS webpack-compilation span (${label}) — webpack did not run`);
  if (cell.rspackBanner || cell.turbopackBanner)
    fail(`webpack cell ran the wrong bundler (${label})`);
}
function assertTurbopack(cell, label) {
  if (!cell.ok) fail(`expected Turbopack to build (${label})`);
  if (!cell.turbopackBanner) fail(`expected the Turbopack banner (${label})`);
  if (cell.rspackBanner) fail(`unexpected rspack banner in a Turbopack cell (${label})`);
  if (cell.webpackCompilationSpan) fail(`Turbopack cell ran the JS webpack compiler (${label})`);
}

// Three two-sided groups; any cell changing sides turns the bench red, forcing a
// deliberate record update. Group (1) is asserted above, before the control builds.
//
// (2) The same PnP trees on the control node: Turbopack fails with ITS failure
// (the next/package.json resolution error, and it really was Turbopack that
// ran), while webpack and rspack build — proving the crash in (1) is scoped to
// the node version, and that rspack is the Rust bundler that resolves PnP.
{
  const c = matrix.pnpControlNode;
  const ctl = `pnp @ node ${c.node}`;
  if (c.turbopack.exit === 0 || c.turbopack.ok)
    fail(`expected Turbopack to fail (non-zero exit, no output) under ${ctl}`);
  if (!c.turbopack.pnpResolveFailure || c.turbopack.configLoadCrash)
    fail(`expected Turbopack's failure under ${ctl} to be the next/package.json resolution error`);
  if (!c.turbopack.turbopackBanner)
    fail(`expected the Turbopack banner in the ${ctl} turbopack cell (bundler-identity guard)`);
  if (c.turbopack.rspackBanner || c.turbopack.webpackCompilationSpan || c.turbopack.outputPresent)
    fail(`the ${ctl} turbopack cell shows another compiler or a complete build`);
  assertWebpack(c.webpack, `${ctl} webpack`);
  assertRspack(c.rspack, `${ctl} rspack`);
}

// (3) node-modules controls on this node: all three build, so the failures in
// (1) are PnP-specific.
assertTurbopack(matrix.nm.turbopack, "nm/turbopack");
assertWebpack(matrix.nm.webpack, "nm/webpack");
assertRspack(matrix.nm.rspack, "nm/rspack");

// --- installed versions ------------------------------------------------------
function installedVersion(cellDir, pkg) {
  // Read the version from the resolved package.json inside the PnP cache zip is
  // awkward; read it from node-modules where available, else the requested pin.
  const p = join(cellDir, "node_modules", pkg, "package.json");
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8")).version;
    } catch {
      /* fall through */
    }
  }
  return null;
}
const nmRspackDir = join(base, "nm-rspack");
const rspackCoreVersion = installedVersion(nmRspackDir, "@next/rspack-core");

// ============================================================================
const output = {
  generatedAt: new Date().toISOString(),
  canonical: true,
  env: envInfo,
  versions: {
    yarn: YARN_VERSION,
    next: NEXT_VERSION,
    nextRspack: RSPACK_VERSION,
    rspackCore: rspackCoreVersion,
    node: process.version,
    controlNode: `v${CONTROL_NODE_VERSION}`,
  },
  matrix,
  finding:
    `On node ${process.version}, next build under the Yarn PnP linker fails on every builder ` +
    "(Turbopack, webpack, rspack): the build crashes while loading next.config, in next's " +
    "config transpile hook, before a bundler is selected. The same installed PnP trees on " +
    `node v${CONTROL_NODE_VERSION} separate the bundlers: Turbopack has no PnP resolver ` +
    "(vercel/next.js#42651, declined + locked) and aborts on next/package.json resolution, " +
    "while rspack (PnP resolution added in web-infra-dev/rspack#13047, carried through " +
    "next-rspack) and webpack build. Under the node-modules linker all three build on " +
    `node ${process.version}.`,
};

writeFileSync(join(REPO, "bench/rspack-pnp-bench.json"), JSON.stringify(output, null, 2));
console.log("\n--- bench/rspack-pnp-bench.json written ---");

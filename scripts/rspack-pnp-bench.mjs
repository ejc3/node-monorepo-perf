#!/usr/bin/env node
// Prices the fast-Next-bundler-under-Yarn-PnP question. Turbopack (Vercel's Rust
// bundler, the Next 16 default) has no PnP resolver — its maintainers declined
// PnP (vercel/next.js#42651, closed + locked) — so a Next build under Yarn's PnP
// linker fails to resolve `next/package.json` and aborts. Rspack (the Rust
// webpack-compatible bundler) DID add PnP resolution
// (web-infra-dev/rspack#13047, #13382), and Next ships an experimental rspack
// integration (`next-rspack`, `withRspack(config)`). This bench measures the
// full builder matrix on one Next app under both Yarn linkers:
//
//   PnP linker:          turbopack (fail) · webpack (ok) · rspack (ok)
//   node-modules linker: turbopack (ok)   · rspack (ok)   — controls
//
// The finding: under PnP, rspack builds a Next app that Turbopack cannot, and
// rspack is the fast (Rust, webpack-compatible) bundler that carries PnP support
// through Next's integration — the answer for a PnP shop that wants Next builds
// off webpack without moving to Turbopack.
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
const yarn = (args, cwd) => run("node", [YARNJS, ...args], cwd);

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

function buildCell(base, linker, builder, flag) {
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

  rmSync(join(dir, ".next"), { recursive: true, force: true });
  const t0 = process.hrtime.bigint();
  const r = yarn(["next", "build", ...(flag ? [flag] : [])], dir);
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.signal) fail(`next build (${linker}/${builder}) killed by ${r.signal} (harness fault)`);

  const dotNext = join(dir, ".next");
  const outputPresent = outputComplete(dotNext);
  const outputBytes = existsSync(dotNext) ? duApparentBytes(dotNext) : 0;
  const sig = bundlerSignatures(r.out);
  const webpackCompilationSpan = ranJsWebpackCompiler(dir);
  // Turbopack under PnP aborts because it can't resolve next/package.json.
  const pnpResolveFailure = /next\/package\.json|couldn't find the Next\.js package/i.test(r.out);
  const cell = {
    linker,
    builder,
    exit: r.status,
    ok: r.status === 0 && outputPresent,
    ms,
    outputPresent,
    outputBytes,
    turbopackBanner: sig.turbopackBanner,
    rspackBanner: sig.rspackBanner,
    webpackCompilationSpan,
    pnpResolveFailure,
  };
  console.log(
    `  ${linker}/${builder}: exit=${cell.exit} ok=${cell.ok} ${cell.ms}ms ` +
      cellBanner(sig, webpackCompilationSpan) +
      (cell.pnpResolveFailure ? " pnp-fail" : ""),
  );
  return cell;
}

// ============================================================================
console.log(
  `rspack PnP bench — yarn ${YARN_VERSION}, next ${NEXT_VERSION}, next-rspack ${RSPACK_VERSION}`,
);
const base = join(WORK, "matrix");
mkdirSync(base, { recursive: true });

const matrix = {
  pnp: {
    turbopack: buildCell(base, "pnp", "turbopack", null),
    webpack: buildCell(base, "pnp", "webpack", "--webpack"),
    rspack: buildCell(base, "pnp", "rspack", null),
  },
  nm: {
    turbopack: buildCell(base, "nm", "turbopack", null),
    webpack: buildCell(base, "nm", "webpack", "--webpack"),
    rspack: buildCell(base, "nm", "rspack", null),
  },
};

// --- assertions --------------------------------------------------------------
// Each successful cell must prove WHICH compiler ran: rspack = the next-rspack
// banner AND no JS webpack-compilation span AND no Turbopack banner; webpack = a
// JS webpack-compilation span AND neither other banner; turbopack = the Turbopack
// banner AND no rspack banner. The compilation-span check is the load-bearing one:
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
}

// Under PnP: Turbopack FAILS (non-zero exit) with the next/package.json resolution
// error, and it really was Turbopack that ran.
const tp = matrix.pnp.turbopack;
if (tp.exit === 0 || tp.ok) fail("expected Turbopack to fail (non-zero exit, no output) under PnP");
if (!tp.pnpResolveFailure)
  fail("expected Turbopack's PnP failure to be the next/package.json resolution error");
if (!tp.turbopackBanner)
  fail("expected the Turbopack banner in the PnP/turbopack cell (bundler-identity guard)");

// Under PnP: webpack and rspack both build; the headline is rspack.
assertWebpack(matrix.pnp.webpack, "pnp/webpack");
assertRspack(matrix.pnp.rspack, "pnp/rspack");

// node-modules controls: all three build.
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
  },
  matrix,
  finding:
    "Turbopack has no Yarn PnP resolver (vercel/next.js#42651, declined + locked), so a " +
    "Next build under the PnP linker aborts on next/package.json resolution. Rspack added PnP " +
    "resolution (web-infra-dev/rspack#13047), and Next's next-rspack integration carries it " +
    "through: under PnP, rspack and webpack build the same app Turbopack cannot. Under the " +
    "node-modules linker all three build. For a PnP shop wanting a fast (Rust, webpack-" +
    "compatible) Next bundler, rspack is the answer; Turbopack still requires node-modules (or pnpm).",
};

writeFileSync(join(REPO, "bench/rspack-pnp-bench.json"), JSON.stringify(output, null, 2));
console.log("\n--- bench/rspack-pnp-bench.json written ---");

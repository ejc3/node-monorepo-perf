#!/usr/bin/env node
// Prices tsgo's Yarn Plug'n'Play (PnP) support: the native type-checker cannot be
// patched by Yarn's runtime the way `tsc` is (Yarn injects a require() shim that a
// Go binary never loads), so stock tsgo fails to resolve any dependency in a PnP
// project (TS2307). This bench measures the gap and the fix — a native PnP
// resolver added to tsgo (upstream microsoft/typescript-go#460) — on a small but
// real workspace (an app importing React, react-dom — which Yarn virtualizes — and
// a local lib that imports lodash).
//
//   TSGO_PNP_BIN=~/src/typescript-go/tsgo node scripts/tsgo-pnp-bench.mjs
//
// TSGO_PNP_BIN is the patched tsgo built from the PR branch; without it only the
// stock column runs, and the result goes to the gitignored partial (never the
// canonical file). The stock tsgo is the native tsc of the typescript@7 version
// this repo pins. Two install modes per scaffold: Yarn PnP at its defaults (the
// manifest inlined in .pnp.cjs, no sidecar) and Yarn's node-modules linker (the
// CONTROL — a real node_modules tree). The finding: stock tsgo fails under PnP
// and works under node-modules; patched tsgo works under both.
//
// `next build` under PnP is measured by rspack-pnp-bench.mjs (all three builders,
// with its node-version control) — one bench owns that matrix.
//
// Self-contained and non-destructive: scaffolds under a btrfs work dir
// (TSGO_PNP_WORK, default /mnt/fcvm-btrfs/tsgo-pnp-bench), removed on exit unless
// TSGO_PNP_KEEP=1; needs no worktree.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { YARN_VERSION } from "./_pins.mjs";
import { fetchYarnCli, loadGuard } from "./_pm-bench-lib.mjs";
import { tsNativeShim, assertTs7 } from "./_ts.mjs";
import { envForNode, nodeBinDirFor } from "./_next-bundler-lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = process.env.TSGO_PNP_WORK || "/mnt/fcvm-btrfs/tsgo-pnp-bench";
const KEEP = process.env.TSGO_PNP_KEEP === "1";
const REACT_VERSION = "^18.3.1";
// packages/app/src/index.ts imports exactly three module specifiers (react,
// react-dom/client, @t/util); a checker with no PnP resolver reports each as one
// TS2307, and nothing else.
const APP_IMPORTS = 3;

const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};

// Every Node-based measured child (yarn, the stock checker's node shim) runs under
// the node running this bench — the node `versions.node`
// records — with its bin dir leading PATH (asserted to hold that same release), so
// a `#!/usr/bin/env node` shim or a tool yarn spawns by name cannot pick another.
let NODE_BIN_DIR;
try {
  NODE_BIN_DIR = nodeBinDirFor(process.execPath, process.version);
} catch (e) {
  fail(e.message);
}
const benchEnv = envForNode({ ...process.env, YARN_IGNORE_PATH: "1", CI: "false" }, NODE_BIN_DIR);
// An untimed probe must run to completion and exit 0 before its output is read: a
// process that printed the expected text and then died is not a passed check.
function probe(cmd, args, what) {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: benchEnv, timeout: 120_000 });
  if (r.error || r.signal || r.status !== 0)
    fail(`${what} did not exit 0 (status ${r.status}, signal ${r.signal}) — harness fault`);
  return (r.stdout || "").trim();
}

// --- tsgo binaries -----------------------------------------------------------
const repoDevDeps = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).devDependencies;
const STOCK_TSGO_VERSION = repoDevDeps.typescript;
if (!STOCK_TSGO_VERSION) fail("root package.json no longer pins typescript (the native checker)");
// the stock native checker: typescript@7's node shim, by direct path (never .bin/PATH —
// `.bin/tsc` is a ts7/ts6 collision at the repo root); executable, spawns the native binary
const STOCK_TSGO = tsNativeShim(REPO);
if (!existsSync(STOCK_TSGO))
  fail(`stock native tsc not found at ${STOCK_TSGO} — run \`pnpm install\``);
// A checker is {cmd, pre}: the stock one is typescript@7's NODE shim, run as
// `<this node> <shim>` (never through its shebang); the patched one is a native binary.
const STOCK = { cmd: process.execPath, pre: [STOCK_TSGO] };
const tsgoVersion = (c) => probe(c.cmd, [...c.pre, "--version"], `${c.pre[0] ?? c.cmd} --version`);
try {
  assertTs7(tsgoVersion(STOCK));
} catch (e) {
  fail(e.message);
}

const PATCHED_TSGO = process.env.TSGO_PNP_BIN ? resolve(process.env.TSGO_PNP_BIN) : null;
if (PATCHED_TSGO && !existsSync(PATCHED_TSGO)) fail(`TSGO_PNP_BIN not found: ${PATCHED_TSGO}`);
const canonical = Boolean(PATCHED_TSGO);
const PATCHED = PATCHED_TSGO ? { cmd: PATCHED_TSGO, pre: [] } : null;
function patchedProvenance() {
  if (!PATCHED_TSGO) return null;
  const gitDir = resolve(dirname(PATCHED_TSGO));
  const sha = spawnSync("git", ["-C", gitDir, "rev-parse", "HEAD"], { encoding: "utf8" });
  const branch = spawnSync("git", ["-C", gitDir, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  });
  const gitSha = sha.status === 0 ? sha.stdout.trim() : null;
  const gitBranch = branch.status === 0 ? branch.stdout.trim() : null;
  // a canonical record names the build it measured: no sha, no canonical run
  if (!gitSha || !gitBranch)
    fail(`TSGO_PNP_BIN provenance unreadable: ${gitDir} is not a git checkout with a HEAD`);
  // the record names the build by version + git provenance, not by its local path
  return { version: tsgoVersion(PATCHED), gitSha, gitBranch };
}
// resolved up front: an unreadable checkout must fail before any install or timing
const PATCHED_PROVENANCE = patchedProvenance();

const envInfo = loadGuard("TSGO_PNP_ALLOW_BUSY");

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
process.on("exit", () => {
  if (!KEEP) rmSync(WORK, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const YARNJS = fetchYarnCli(WORK, YARN_VERSION);
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 27, env: benchEnv });
  return {
    status: r.status,
    signal: r.signal,
    out: ((r.stdout || "") + (r.stderr || "")).trim(),
  };
}
const yarn = (args, cwd) => run(process.execPath, [YARNJS, ...args], cwd);

// --- scaffolds ---------------------------------------------------------------
function writeWorkspaceScaffold(dir) {
  mkdirSync(join(dir, "packages/util/src"), { recursive: true });
  mkdirSync(join(dir, "packages/app/src"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "tsgo-pnp-root",
        private: true,
        packageManager: `yarn@${YARN_VERSION}`,
        workspaces: ["packages/*"],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "packages/util/package.json"),
    JSON.stringify(
      {
        name: "@t/util",
        version: "1.0.0",
        main: "src/index.ts",
        dependencies: { lodash: "^4.17.21", "@types/lodash": "^4.17.13" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "packages/util/src/index.ts"),
    `import { camelCase } from "lodash";\nexport function slug(s: string): string {\n  return camelCase(s);\n}\nexport const VERSION = "1.0.0";\n`,
  );
  writeFileSync(
    join(dir, "packages/app/package.json"),
    JSON.stringify(
      {
        name: "@t/app",
        version: "1.0.0",
        dependencies: {
          "@t/util": "workspace:^",
          react: REACT_VERSION,
          "react-dom": REACT_VERSION,
          "@types/react": "^18.3.12",
          "@types/react-dom": "^18.3.1",
        },
      },
      null,
      2,
    ),
  );
  // Imports a workspace lib, a leaf npm package (react, a plain cache zip), and a
  // package with a peer dependency (react-dom, which Yarn virtualizes under
  // .yarn/__virtual__) — so the checker exercises workspace, zip, and virtual-path
  // resolution together.
  writeFileSync(
    join(dir, "packages/app/src/index.ts"),
    `import * as React from "react";\nimport { createRoot } from "react-dom/client";\nimport { slug, VERSION } from "@t/util";\nexport function greet(name: string): React.ReactElement {\n  return React.createElement("div", null, slug(name) + VERSION);\n}\nexport function mount(el: HTMLElement) {\n  return createRoot(el);\n}\n`,
  );
  writeFileSync(
    join(dir, "packages/app/tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          module: "preserve",
          moduleResolution: "bundler",
          target: "ES2022",
          jsx: "react-jsx",
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["src"],
      },
      null,
      2,
    ),
  );
}

function writeYarnrc(dir, linker) {
  // PnP uses Yarn's defaults, including pnpEnableInlining (so the manifest is the
  // inlined .pnp.cjs, the real-world default — no .pnp.data.json sidecar), to
  // exercise the .pnp.cjs extraction path the way real projects hit it.
  const lines =
    linker === "pnp"
      ? ["nodeLinker: pnp", "enableGlobalCache: false", "compressionLevel: 0"]
      : ["nodeLinker: node-modules", "enableGlobalCache: false"];
  writeFileSync(join(dir, ".yarnrc.yml"), lines.join("\n") + "\n");
}

function installTree(base, linker) {
  const dir = join(base, linker);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- tsgo measurement --------------------------------------------------------
function countCodes(out) {
  const codes = {};
  for (const m of out.matchAll(/error (TS\d+):/g)) codes[m[1]] = (codes[m[1]] || 0) + 1;
  const total = Object.values(codes).reduce((a, b) => a + b, 0);
  return { total, codes };
}

// --listFiles prints one path per program file on the same stream as the
// diagnostics (`rel/path.ts(l,c): error TSxxxx: ...`). Only path-only lines are
// program files; a diagnostic line is skipped, and a line that is neither fails
// the bench — an unparsed line must not be silently counted or dropped. A path is
// absolute on disk, or `bundled:///libs/…` for the default libs the native
// compiler embeds in its binary (lib.es5.d.ts and friends have no on-disk path).
// The line is NOT trimmed: an indented line (a diagnostic continuation) is never a
// program file. Extensions cover every file kind a program can hold.
const LISTED_FILE = /^(?:\/|[A-Za-z]:[\\/]|bundled:\/\/\/).*\.(?:d\.[cm]?ts|[cm]?[jt]sx?|json)$/;
const DIAGNOSTIC = /error TS\d+:/;
function countListedFiles(out, what) {
  const files = new Set();
  // a diagnostic's message chain continues on indented lines directly under it;
  // an indented line anywhere else, or an unknown unindented line, is fatal
  let inDiagnostic = false;
  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    if (DIAGNOSTIC.test(line) && !/^\s/.test(line)) {
      inDiagnostic = true;
      continue;
    }
    if (inDiagnostic && /^\s/.test(line)) continue;
    inDiagnostic = false;
    if (!LISTED_FILE.test(line))
      fail(`${what}: unclassifiable --listFiles line: ${line.slice(0, 200)}`);
    files.add(line);
  }
  return files.size;
}

const sameCodes = (a, b) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
// a Go runtime crash prints one of these; it is never a diagnostic outcome
const RUNTIME_CRASH = /^(?:panic:|fatal error:|goroutine \d+ \[)/m;

function measureTsgo(checker, dir) {
  // --pretty false: one line per diagnostic, no colors or summary, on any stream
  const base = [...checker.pre, "--noEmit", "--pretty", "false", "-p", "packages/app"];
  const t0 = process.hrtime.bigint();
  const r = run(checker.cmd, base, dir);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.signal || typeof r.status !== "number")
    fail(
      `tsgo did not run to an exit code (signal ${r.signal}) — harness fault, not a measurement`,
    );
  if (RUNTIME_CRASH.test(r.out))
    fail(`tsgo crashed (exit ${r.status}) — harness fault:\n${r.out.slice(-600)}`);
  const { total, codes } = countCodes(r.out);
  // program size via an untimed --listFiles pass over the same program: it must
  // run to the same exit code and report the same diagnostics as the timed pass
  const lf = run(checker.cmd, [...base, "--listFiles"], dir);
  if (lf.signal || lf.status !== r.status || !sameCodes(countCodes(lf.out).codes, codes))
    fail(
      `--listFiles pass diverged from the timed pass (exit ${lf.status} vs ${r.status}, ` +
        `signal ${lf.signal}) — not the same program`,
    );
  const fileCount = countListedFiles(lf.out, "tsgo --listFiles");
  if (fileCount === 0) fail("tsgo --listFiles reported no program files");
  return { exit: r.status, errorCount: total, codes, ms: Math.round(ms), fileCount };
}

// ============================================================================
console.log(`tsgo PnP bench — yarn ${YARN_VERSION}, stock tsgo ${STOCK_TSGO_VERSION}`);
console.log(canonical ? `patched: ${PATCHED_TSGO}` : "patched: (absent — partial run)");

const wsBase = join(WORK, "workspace");
mkdirSync(wsBase, { recursive: true });

const tsgoMatrix = {};
for (const linker of ["pnp", "nm"]) {
  const dir = installTree(wsBase, linker);
  writeWorkspaceScaffold(dir);
  writeYarnrc(dir, linker);
  cpSync(YARNJS, join(dir, "yarn.js"));
  const inst = yarn(["install"], dir);
  if (inst.status !== 0) fail(`yarn install (${linker}) failed:\n${inst.out.slice(-800)}`);
  const inlinedManifest = existsSync(join(dir, ".pnp.cjs"));
  const sidecarManifest = existsSync(join(dir, ".pnp.data.json"));
  const pnpPresent = inlinedManifest || sidecarManifest;
  const nmPresent = existsSync(join(dir, "node_modules"));
  if (linker === "pnp" && !pnpPresent) fail("pnp install produced no .pnp.cjs manifest");
  if (linker === "nm" && !nmPresent) fail("node-modules install produced no node_modules");

  const cell = {
    install: {
      pnpManifest: pnpPresent,
      inlined: inlinedManifest,
      sidecar: sidecarManifest,
      nodeModules: nmPresent,
    },
  };
  cell.stock = measureTsgo(STOCK, dir);
  if (PATCHED) cell.patched = measureTsgo(PATCHED, dir);
  tsgoMatrix[linker] = cell;
  console.log(
    `  ${linker}: stock exit=${cell.stock.exit} errors=${cell.stock.errorCount}` +
      (cell.patched
        ? ` | patched exit=${cell.patched.exit} errors=${cell.patched.errorCount}`
        : ""),
  );
}

// positive control: patched tsgo under PnP must go RED on a seeded type error
let redControl = null;
if (PATCHED) {
  const dir = join(wsBase, "pnp");
  const src = join(dir, "packages/app/src/index.ts");
  const original = readFileSync(src, "utf8");
  try {
    writeFileSync(src, original + '\nconst bad: number = slug("x"); // string -> number\n');
    const red = measureTsgo(PATCHED, dir);
    redControl = { exit: red.exit, errorCount: red.errorCount, codes: red.codes };
    if (!(red.exit === 1 && sameCodes(red.codes, { TS2322: 1 })))
      fail(
        `patched tsgo did not go red with exactly the seeded TS2322 (exit ${red.exit}, ` +
          `codes ${JSON.stringify(red.codes)})`,
      );
  } finally {
    writeFileSync(src, original);
  }
}

// --- assertions on the tsgo matrix ------------------------------------------
// green = exit 0 AND zero diagnostics (a panic or config error exits non-zero with
// no `error TSxxxx` line and must not read as a pass); red = the diagnostics exit
// (1) AND exactly the expected code histogram — another exit status or any extra
// code is a different failure. Signals, missing exit codes and runtime crashes
// already failed in measureTsgo.
const green = (c) => c.exit === 0 && c.errorCount === 0;
const sp = tsgoMatrix.pnp.stock;
if (!(sp.exit === 1 && sameCodes(sp.codes, { TS2307: APP_IMPORTS })))
  fail(
    `expected stock tsgo to fail under PnP with exactly ${APP_IMPORTS}× TS2307 ` +
      `(exit ${sp.exit}, codes ${JSON.stringify(sp.codes)})`,
  );
if (!green(tsgoMatrix.nm.stock)) fail("expected stock tsgo to pass under node-modules");
if (PATCHED) {
  if (!green(tsgoMatrix.pnp.patched)) fail("expected patched tsgo to pass under PnP");
  if (!green(tsgoMatrix.nm.patched)) fail("expected patched tsgo to pass under node-modules");
}

// ============================================================================
const output = {
  generatedAt: new Date().toISOString(),
  canonical,
  env: envInfo,
  versions: {
    yarn: YARN_VERSION,
    node: process.version,
    stockTsgo: STOCK_TSGO_VERSION,
    stockTsgoReported: tsgoVersion(STOCK),
  },
  patchedTsgo: PATCHED_PROVENANCE,
  redControl,
  tsgoMatrix,
  finding:
    "Stock tsgo cannot resolve dependencies under Yarn PnP (TS2307); the native PnP " +
    "resolver (microsoft/typescript-go#460) fixes it, matching the node-modules control.",
};

const outRel = canonical ? "bench/tsgo-pnp-bench.json" : "bench/tsgo-pnp-bench.partial.json";
writeFileSync(join(REPO, outRel), JSON.stringify(output, null, 2));
console.log(`\n--- ${outRel} written ---`);

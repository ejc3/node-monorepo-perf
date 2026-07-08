#!/usr/bin/env node
// Prices tsgo's Yarn Plug'n'Play (PnP) support: the native type-checker cannot be
// patched by Yarn's runtime the way `tsc` is (Yarn injects a require() shim that a
// Go binary never loads), so stock tsgo fails to resolve any dependency in a PnP
// project (TS2307). This bench measures the gap and the fix — a native PnP
// resolver added to tsgo (upstream microsoft/typescript-go#460) — on a small but
// real workspace (an app importing React, react-dom — which Yarn virtualizes — and
// a local lib that imports lodash), and the whole Next.js build matrix on top.
//
//   TSGO_PNP_BIN=~/src/typescript-go/tsgo node scripts/tsgo-pnp-bench.mjs
//
// TSGO_PNP_BIN is the patched tsgo built from the PR branch; without it only the
// stock column + the Next matrix run, and the result goes to the gitignored
// partial (never the canonical file). The stock tsgo is the version this repo
// pins (@typescript/native-preview). Two install modes per scaffold: Yarn PnP at
// its defaults (the manifest inlined in .pnp.cjs, no sidecar) and Yarn's
// node-modules linker (the CONTROL — a real node_modules tree). The finding:
// stock tsgo fails under PnP and
// works under node-modules; patched tsgo works under both; and Next builds under
// PnP on the webpack builder but not Turbopack (which has no PnP resolver), while
// the node-modules linker lets Turbopack build.
//
// Self-contained and non-destructive: scaffolds under a btrfs work dir
// (TSGO_PNP_WORK, default /mnt/fcvm-btrfs/tsgo-pnp-bench), removed on exit unless
// TSGO_PNP_KEEP=1; needs no worktree.

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  cpSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { YARN_VERSION } from "./_pins.mjs";
import { fetchYarnCli, loadGuard } from "./_pm-bench-lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = process.env.TSGO_PNP_WORK || "/mnt/fcvm-btrfs/tsgo-pnp-bench";
const KEEP = process.env.TSGO_PNP_KEEP === "1";
const NEXT_VERSION = "16.0.1";
const REACT_VERSION = "^18.3.1";

const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};

// --- tsgo binaries -----------------------------------------------------------
const repoDevDeps = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).devDependencies;
const STOCK_TSGO_VERSION = repoDevDeps["@typescript/native-preview"];
if (!STOCK_TSGO_VERSION) fail("root package.json no longer pins @typescript/native-preview");
const STOCK_TSGO = join(REPO, "node_modules", ".bin", "tsgo");
if (!existsSync(STOCK_TSGO)) fail(`stock tsgo not found at ${STOCK_TSGO} — run \`pnpm install\``);

const PATCHED_TSGO = process.env.TSGO_PNP_BIN ? resolve(process.env.TSGO_PNP_BIN) : null;
if (PATCHED_TSGO && !existsSync(PATCHED_TSGO)) fail(`TSGO_PNP_BIN not found: ${PATCHED_TSGO}`);
const canonical = Boolean(PATCHED_TSGO);

function tsgoVersion(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
  return (r.stdout || r.stderr || "").trim();
}
function patchedProvenance() {
  if (!PATCHED_TSGO) return null;
  const gitDir = resolve(dirname(PATCHED_TSGO));
  const sha = spawnSync("git", ["-C", gitDir, "rev-parse", "HEAD"], { encoding: "utf8" });
  const branch = spawnSync("git", ["-C", gitDir, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  });
  return {
    bin: PATCHED_TSGO,
    version: tsgoVersion(PATCHED_TSGO),
    gitSha: sha.status === 0 ? sha.stdout.trim() : null,
    gitBranch: branch.status === 0 ? branch.stdout.trim() : null,
  };
}

const envInfo = loadGuard("TSGO_PNP_ALLOW_BUSY");

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
process.on("exit", () => {
  if (!KEEP) rmSync(WORK, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const YARNJS = fetchYarnCli(WORK, YARN_VERSION);
const yarnEnvClean = { ...process.env, YARN_IGNORE_PATH: "1", CI: "false" };

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

function measureTsgo(bin, dir) {
  const t0 = process.hrtime.bigint();
  const r = run(bin, ["--noEmit", "-p", "packages/app"], dir);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.signal) fail(`tsgo killed by ${r.signal} (harness fault, not a measurement)`);
  const { total, codes } = countCodes(r.out);
  // program size via an untimed --listFiles pass
  const lf = run(bin, ["--noEmit", "-p", "packages/app", "--listFiles"], dir);
  const fileCount = (lf.out.match(/\.d\.ts|\.ts|\.tsx/g) || []).length;
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
  cell.stock = measureTsgo(STOCK_TSGO, dir);
  if (PATCHED_TSGO) cell.patched = measureTsgo(PATCHED_TSGO, dir);
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
if (PATCHED_TSGO) {
  const dir = join(wsBase, "pnp");
  const src = join(dir, "packages/app/src/index.ts");
  const original = readFileSync(src, "utf8");
  try {
    writeFileSync(src, original + '\nconst bad: number = slug("x"); // string -> number\n');
    const red = measureTsgo(PATCHED_TSGO, dir);
    redControl = { exit: red.exit, errorCount: red.errorCount, codes: red.codes };
    if (!(red.errorCount > 0 && red.codes.TS2322))
      fail("patched tsgo did not go red on a seeded TS2322");
  } finally {
    writeFileSync(src, original);
  }
}

// --- assertions on the tsgo matrix ------------------------------------------
if (!(tsgoMatrix.pnp.stock.errorCount > 0 && tsgoMatrix.pnp.stock.codes.TS2307))
  fail("expected stock tsgo to fail under PnP with TS2307");
if (tsgoMatrix.nm.stock.errorCount !== 0) fail("expected stock tsgo to pass under node-modules");
if (PATCHED_TSGO) {
  if (tsgoMatrix.pnp.patched.errorCount !== 0) fail("expected patched tsgo to pass under PnP");
  if (tsgoMatrix.nm.patched.errorCount !== 0)
    fail("expected patched tsgo to pass under node-modules");
}

// ============================================================================
// Next.js build matrix
function writeNextScaffold(dir) {
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "next-pnp-app",
        private: true,
        packageManager: `yarn@${YARN_VERSION}`,
        dependencies: { next: NEXT_VERSION, react: REACT_VERSION, "react-dom": REACT_VERSION },
        devDependencies: { "@types/react": "^18.3.12", "@types/node": "^20", typescript: "^5.6.0" },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "next.config.js"),
    "module.exports = { turbopack: { root: __dirname } };\n",
  );
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

function nextBuild(dir, builderArgs) {
  rmSync(join(dir, ".next"), { recursive: true, force: true });
  const t0 = process.hrtime.bigint();
  const r = yarn(["next", "build", ...builderArgs], dir);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { exit: r.status, ms: Math.round(ms), out: r.out };
}

console.log("Next.js build matrix...");
const nextBase = join(WORK, "next");
mkdirSync(nextBase, { recursive: true });
const nextMatrix = {};

// PnP tree: webpack (expect ok) + turbopack (expect fail)
{
  const dir = join(nextBase, "pnp");
  mkdirSync(dir, { recursive: true });
  writeNextScaffold(dir);
  writeYarnrc(dir, "pnp");
  cpSync(YARNJS, join(dir, "yarn.js"));
  const inst = yarn(["install"], dir);
  if (inst.status !== 0) fail(`next PnP install failed:\n${inst.out.slice(-800)}`);
  const wp = nextBuild(dir, ["--webpack"]);
  const tp = nextBuild(dir, []);
  const tpSignature = /next\/package\.json|couldn't find the Next\.js package/i.test(tp.out);
  nextMatrix.pnp = {
    webpack: { exit: wp.exit, ms: wp.ms, ok: wp.exit === 0 },
    turbopack: { exit: tp.exit, ms: tp.ms, ok: tp.exit === 0, pnpResolveFailure: tpSignature },
  };
  console.log(
    `  pnp: webpack exit=${wp.exit} | turbopack exit=${tp.exit} (pnp-fail=${tpSignature})`,
  );
}

// node-modules tree: turbopack (expect ok)
{
  const dir = join(nextBase, "nm");
  mkdirSync(dir, { recursive: true });
  writeNextScaffold(dir);
  writeYarnrc(dir, "nm");
  cpSync(YARNJS, join(dir, "yarn.js"));
  const inst = yarn(["install"], dir);
  if (inst.status !== 0) fail(`next node-modules install failed:\n${inst.out.slice(-800)}`);
  const tp = nextBuild(dir, []);
  nextMatrix.nm = { turbopack: { exit: tp.exit, ms: tp.ms, ok: tp.exit === 0 } };
  console.log(`  nm: turbopack exit=${tp.exit}`);
}

// assertions on the Next matrix
if (!nextMatrix.pnp.webpack.ok) fail("expected `next build --webpack` to succeed under PnP");
if (nextMatrix.pnp.turbopack.ok || !nextMatrix.pnp.turbopack.pnpResolveFailure)
  fail("expected Turbopack to fail under PnP with the next/package.json resolution error");
if (!nextMatrix.nm.turbopack.ok)
  fail("expected Turbopack to succeed under the node-modules linker");

// ============================================================================
const output = {
  generatedAt: new Date().toISOString(),
  canonical,
  env: envInfo,
  versions: {
    yarn: YARN_VERSION,
    next: NEXT_VERSION,
    stockTsgo: STOCK_TSGO_VERSION,
    stockTsgoReported: tsgoVersion(STOCK_TSGO),
  },
  patchedTsgo: patchedProvenance(),
  redControl,
  tsgoMatrix,
  nextMatrix,
  finding:
    "Stock tsgo cannot resolve dependencies under Yarn PnP (TS2307); the native PnP " +
    "resolver (microsoft/typescript-go#460) fixes it, matching the node-modules control. " +
    "Next.js builds under PnP on the webpack builder; Turbopack has no PnP resolver, so " +
    "Turbopack projects need Yarn's node-modules (or pnpm) linker.",
};

const outRel = canonical ? "bench/tsgo-pnp-bench.json" : "bench/tsgo-pnp-bench.partial.json";
writeFileSync(join(REPO, outRel), JSON.stringify(output, null, 2));
console.log(`\n--- ${outRel} written ---`);

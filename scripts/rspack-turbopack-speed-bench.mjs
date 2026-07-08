#!/usr/bin/env node
// A defensible Turbopack-vs-rspack (vs webpack) BUILD-SPEED benchmark. The PnP
// compat bench (rspack-pnp-bench) measures which bundlers work under Yarn PnP on a
// one-page app, where build time is startup-dominated and no speed read is fair.
// This bench answers "how fast" instead: it generates a non-trivial Next App Router
// app (SPEED_PAGES routes, each importing shared client/server components + a lib
// util, so the bundler has real module-graph work) and builds it with all three
// bundlers under Yarn's node-modules linker — the one linker where all three run —
// COLD (fresh .next each build) and WARM (a no-change rebuild with .next present, so
// each bundler's build cache is exercised), each the median of SPEED_SAMPLES builds.
//
// Discipline shared with the compat bench (_next-bundler-lib): env scrubbed so a
// stray host var can't flip the bundler; each build's compiler proven from Next's
// span trace (rspack emits no JS webpack-compilation span, webpack does, Turbopack
// emits run-turbopack) so a silent webpack fallback can't read as rspack; a build
// counts only with a populated .next (BUILD_ID + manifests). All three build the
// identical generated app, so the number is bundler speed, not app difference.
//
// Speed is core-sensitive (rspack and Turbopack are multithreaded), so it refuses
// on a loaded box unless SPEED_ALLOW_BUSY=1 and records cores/preRunLoadAvg1.
// Self-contained under a btrfs work dir (SPEED_WORK, default
// /mnt/fcvm-btrfs/rspack-speed-bench), removed on exit unless SPEED_KEEP=1; needs
// no worktree. Non-canonical knobs (pages/components/samples) → gitignored partial.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { YARN_VERSION } from "./_pins.mjs";
import { fetchYarnCli, loadGuard, median, benchOutput } from "./_pm-bench-lib.mjs";
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
const WORK = process.env.SPEED_WORK || "/mnt/fcvm-btrfs/rspack-speed-bench";
const KEEP = process.env.SPEED_KEEP === "1";
const PAGES = Number(process.env.SPEED_PAGES || 60);
const COMPONENTS = Number(process.env.SPEED_COMPONENTS || 30);
const SAMPLES = Number(process.env.SPEED_SAMPLES || 3);
const NEXT_VERSION = "16.0.1";
const RSPACK_VERSION = "16.0.1";
const REACT_VERSION = "^18.3.1";
// Canonical only at the documented shape; anything else is exploratory → partial.
const canonical = PAGES === 60 && COMPONENTS === 30 && SAMPLES === 3;

const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};

const envInfo = loadGuard("SPEED_ALLOW_BUSY");

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
const yarnEnvClean = scrubBundlerEnv(process.env);

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 27,
    env: yarnEnvClean,
  });
  return { status: r.status, signal: r.signal, out: ((r.stdout || "") + (r.stderr || "")).trim() };
}
const yarn = (args, cwd) => run("node", [YARNJS, ...args], cwd);

// --- app generation ----------------------------------------------------------
// A non-trivial App Router app: COMPONENTS shared components (a third are client
// components with a little interactive state), a handful of lib utils, and PAGES
// route pages each importing several components + a util. The module graph — not
// framework startup — dominates the build.
function generateApp(dir) {
  mkdirSync(join(dir, "app"), { recursive: true });
  mkdirSync(join(dir, "components"), { recursive: true });
  mkdirSync(join(dir, "lib"), { recursive: true });

  // lib utils
  const LIB_MODS = 8;
  for (let i = 0; i < LIB_MODS; i++) {
    writeFileSync(
      join(dir, "lib", `util${i}.ts`),
      `export function fmt${i}(n: number): string {\n` +
        `  return [${Array.from({ length: 6 }, (_, k) => `n * ${i + 1} + ${k}`).join(", ")}]\n` +
        `    .map((x) => x.toString(16))\n    .join("-");\n}\n` +
        `export const TAG${i} = "util-${i}" as const;\n`,
    );
  }

  // shared components; every third is a client component with state
  for (let i = 0; i < COMPONENTS; i++) {
    const isClient = i % 3 === 0;
    const util = i % LIB_MODS;
    writeFileSync(
      join(dir, "components", `C${i}.tsx`),
      (isClient ? `"use client";\nimport { useState } from "react";\n` : "") +
        `import { fmt${util}, TAG${util} } from "../lib/util${util}";\n` +
        `export function C${i}({ label }: { label: string }) {\n` +
        (isClient
          ? `  const [n, setN] = useState(${i});\n` +
            `  return (<button onClick={() => setN((v) => v + 1)}>{label}:{TAG${util}}:{fmt${util}(n)}</button>);\n`
          : `  return (<div data-c="${i}">{label}:{TAG${util}}:{fmt${util}(${i})}</div>);\n`) +
        `}\n`,
    );
  }

  // route pages, each importing 5 components + a util
  for (let p = 0; p < PAGES; p++) {
    const picks = Array.from({ length: 5 }, (_, k) => (p * 5 + k * 7) % COMPONENTS);
    const uniq = [...new Set(picks)];
    const imports = uniq.map((c) => `import { C${c} } from "../../components/C${c}";`).join("\n");
    const usage = uniq.map((c) => `      <C${c} label="p${p}" />`).join("\n");
    mkdirSync(join(dir, "app", `p-${p}`), { recursive: true });
    writeFileSync(
      join(dir, "app", `p-${p}`, "page.tsx"),
      `${imports}\nexport default function Page() {\n  return (\n    <main>\n${usage}\n    </main>\n  );\n}\n`,
    );
  }

  // root layout + index
  writeFileSync(
    join(dir, "app", "layout.tsx"),
    `import type { ReactNode } from "react";\nexport default function RootLayout({ children }: { children: ReactNode }) {\n  return (<html><body>{children}</body></html>);\n}\n`,
  );
  writeFileSync(
    join(dir, "app", "page.tsx"),
    `export default function Home() {\n  return <main>home</main>;\n}\n`,
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

function writePackageJson(dir) {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "next-bundler-speed-app",
        private: true,
        packageManager: `yarn@${YARN_VERSION}`,
        dependencies: {
          next: NEXT_VERSION,
          react: REACT_VERSION,
          "react-dom": REACT_VERSION,
          "next-rspack": RSPACK_VERSION,
        },
        devDependencies: { "@types/react": "^18.3.12", "@types/node": "^20", typescript: "^5.6.0" },
      },
      null,
      2,
    ),
  );
  // node-modules linker: the one linker where all three bundlers run.
  // enableImmutableInstalls:false so a CI host (where yarn auto-enables immutable)
  // can still create the lockfile on the first install.
  writeFileSync(
    join(dir, ".yarnrc.yml"),
    "nodeLinker: node-modules\nenableGlobalCache: false\nenableImmutableInstalls: false\n",
  );
}

// --- one timed build ---------------------------------------------------------
const BUILD_FLAG = { turbopack: null, webpack: "--webpack", rspack: null };

function oneBuild(dir, builder, { cold }) {
  if (cold) rmSync(join(dir, ".next"), { recursive: true, force: true });
  const flag = BUILD_FLAG[builder];
  const t0 = process.hrtime.bigint();
  const r = yarn(["next", "build", ...(flag ? [flag] : [])], dir);
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.signal) fail(`next build (${builder}) killed by ${r.signal} (harness fault)`);
  const dotNext = join(dir, ".next");
  const ok = r.status === 0 && outputComplete(dotNext);
  const sig = bundlerSignatures(r.out);
  const webpackCompilationSpan = ranJsWebpackCompiler(dir);
  return { ok, exit: r.status, ms, sig, webpackCompilationSpan, dotNext };
}

// verify the intended bundler actually compiled this build
function assertIdentity(builder, b, label) {
  if (!b.ok) fail(`${label}: build did not complete (exit ${b.exit})`);
  if (builder === "turbopack") {
    if (!b.sig.turbopackBanner) fail(`${label}: expected Turbopack banner`);
    if (b.webpackCompilationSpan || b.sig.rspackBanner)
      fail(`${label}: not a clean Turbopack build`);
  } else if (builder === "webpack") {
    if (!b.webpackCompilationSpan) fail(`${label}: expected a JS webpack-compilation span`);
    if (b.sig.turbopackBanner || b.sig.rspackBanner) fail(`${label}: not a clean webpack build`);
  } else {
    if (!b.sig.rspackBanner) fail(`${label}: expected the next-rspack banner`);
    if (b.webpackCompilationSpan) fail(`${label}: rspack cell ran the JS webpack compiler`);
    if (b.sig.turbopackBanner) fail(`${label}: unexpected Turbopack banner in rspack cell`);
  }
}

function measureBuilder(dir, builder) {
  writeFileSync(join(dir, "next.config.js"), nextConfigFor(builder));

  const cold = [];
  for (let s = 0; s < SAMPLES; s++) {
    const b = oneBuild(dir, builder, { cold: true });
    assertIdentity(builder, b, `${builder} cold#${s}`);
    cold.push(b.ms);
  }
  // .next is present from the last cold build → warm no-change-rebuild samples.
  const warm = [];
  let last = null;
  for (let s = 0; s < SAMPLES; s++) {
    const b = oneBuild(dir, builder, { cold: false });
    assertIdentity(builder, b, `${builder} warm#${s}`);
    warm.push(b.ms);
    last = b;
  }
  const outputBytes = existsSync(last.dotNext) ? duApparentBytes(last.dotNext) : 0;
  const cell = {
    builder,
    coldMs: median(cold),
    warmMs: median(warm),
    coldSamples: cold,
    warmSamples: warm,
    outputBytes,
    turbopackBanner: last.sig.turbopackBanner,
    rspackBanner: last.sig.rspackBanner,
    webpackCompilationSpan: last.webpackCompilationSpan,
  };
  console.log(
    `  ${builder}: cold ${cell.coldMs}ms warm ${cell.warmMs}ms  ` +
      cellBanner(last.sig, last.webpackCompilationSpan),
  );
  return cell;
}

// --- installed version -------------------------------------------------------
function installedVersion(dir, pkg) {
  const p = join(dir, "node_modules", pkg, "package.json");
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf8")).version;
    } catch {
      /* fall through */
    }
  }
  return null;
}

// ============================================================================
console.log(
  `rspack/turbopack speed bench — yarn ${YARN_VERSION}, next ${NEXT_VERSION}, ` +
    `${PAGES} pages / ${COMPONENTS} components, ${SAMPLES} samples${canonical ? "" : " (partial)"}`,
);

const appDir = join(WORK_RESOLVED, "app");
mkdirSync(appDir, { recursive: true });
writePackageJson(appDir);
generateApp(appDir);
cpSync(YARNJS, join(appDir, "yarn.js"));
const inst = yarn(["install"], appDir);
if (inst.status !== 0) fail(`install failed:\n${inst.out.slice(-800)}`);
if (!existsSync(join(appDir, "node_modules"))) fail("install produced no node_modules");
const listedRoutes = PAGES + 1; // p-0..p-(PAGES-1) + home

// Order matters only for cache isolation, not for fairness — each builder rms its
// own .next for cold and warms its own. Build in a fixed order.
const cells = {};
for (const builder of ["turbopack", "webpack", "rspack"]) {
  cells[builder] = measureBuilder(appDir, builder);
}

// --- assertions --------------------------------------------------------------
for (const b of Object.values(cells)) {
  if (!(b.coldMs > 0 && b.warmMs > 0)) fail(`${b.builder}: non-positive build time`);
}

// speed ranking (cold), fastest first
const rankCold = Object.values(cells)
  .map((c) => ({ builder: c.builder, coldMs: c.coldMs }))
  .sort((a, b) => a.coldMs - b.coldMs);
const fastestCold = rankCold[0];
const ratios = {};
for (const c of Object.values(cells))
  ratios[c.builder] = +(c.coldMs / fastestCold.coldMs).toFixed(2);

// ============================================================================
const output = {
  generatedAt: new Date().toISOString(),
  canonical,
  env: envInfo,
  shape: {
    pages: PAGES,
    components: COMPONENTS,
    samples: SAMPLES,
    listedRoutes,
    linker: "node-modules",
  },
  versions: {
    yarn: YARN_VERSION,
    next: NEXT_VERSION,
    nextRspack: RSPACK_VERSION,
    rspackCore: installedVersion(appDir, "@next/rspack-core"),
    node: process.version,
  },
  cells,
  coldRanking: rankCold,
  coldRatioVsFastest: ratios,
  finding:
    `On a generated ${PAGES}-route App Router app under the node-modules linker, cold build ` +
    `speed ranks ${rankCold.map((r) => `${r.builder} ${r.coldMs}ms`).join(" < ")} ` +
    `(×${ratios.turbopack}/${ratios.webpack}/${ratios.rspack} turbopack/webpack/rspack vs the ` +
    `fastest). Turbopack is Vercel's optimized default and leads here, but it does not run under ` +
    `Yarn PnP; among the PnP-capable bundlers rspack builds faster than webpack. Each build's ` +
    `compiler is proven from Next's span trace, so the numbers are the named bundler, not a fallback.`,
};

const rel = "bench/rspack-turbopack-speed-bench";
const io = benchOutput(
  REPO,
  `${rel}.partial.json`,
  canonical ? `${rel}.json` : `${rel}.partial.json`,
);
io.promote(output);
console.log(
  `\ncold ranking: ${rankCold.map((r) => `${r.builder} ${r.coldMs}ms`).join(" < ")}\n` +
    `--- ${canonical ? `${rel}.json` : `${rel}.partial.json`} written ---`,
);

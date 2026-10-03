#!/usr/bin/env node
// Prices yarn PnP's toolchain-compatibility cost on THIS repo's stack — the cost the docs
// state qualitatively ("a tool that reads node_modules directly needs PnP support or
// unplugging") wherever yarn-PnP's install wins are reported. The same generated
// workspace is installed twice by the same pinned yarn: once under PnP, once under the
// node-modules linker as the CONTROL — a tool that fails on BOTH is a scaffold problem
// (hard fail, measurement invalid); a tool that passes the control and fails under PnP is
// the finding. Behaviors are MEASURED and recorded (exit codes, error samples, wall
// times); only measurement validity is asserted.
//
//   node scripts/pnp-compat-bench.mjs        # 20 apps / 10 libs
//
// Tools probed, each in both trees, invoked the way a PnP project runs them (through
// yarn, so the PnP runtime is active):
//   oxlint            — whole-tree lint (reads files, no module resolution)
//   tsc (lib build)   — `yarn workspace <lowest-lib> run build` (tsc -p; yarn ships a
//                       builtin typescript patch for PnP)
//   turbo (focused)   — `turbo run typecheck --filter=<app>...` (builds the app's lib
//                       closure with tsc, then typechecks the app — the repo's real
//                       O(closure) pipeline)
//   tsgo              — typescript@7's native tsc, `yarn node <ts7 shim> --noEmit -p
//                       <app>` after the closure is built (a native binary with its
//                       own module resolver, which yarn's typescript patch never
//                       loads); explicit path because each tree holds TWO tsc majors
//                       (root typescript@7 + the per-package catalog typescript)
//   next build        — one app's production build after the closure is built
//
// Self-contained: scaffolds under the OS temp dir, removed on exit; needs no worktree;
// touches no turbo state (TURBO_CACHE_DIR pinned inside the scaffold).

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { YARN_VERSION, YARN_PRE_TS7_PATCH_VERSION } from "./_pins.mjs";
import { isPnpConfigLoadCrash, envForNode, nodeBinDirFor } from "./_next-bundler-lib.mjs";
import {
  yarnEnv,
  fetchYarnCli,
  scaffoldWorkspace,
  writeYarnRc,
  loadGuard,
} from "./_pm-bench-lib.mjs";
import verifyLib from "./_verify-install.cjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// turbo and tsgo are probed at the versions the repo actually pins (root package.json),
// so a pin bump cannot leave this bench pricing a stack the repo no longer runs; oxlint
// has no root pin (lint-bench installs its own) and stays a const
const repoDevDeps = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).devDependencies;
const TURBO_VERSION = repoDevDeps.turbo;
const OXLINT_VERSION = "1.71.0";
const TSGO_VERSION = repoDevDeps.typescript; // typescript@7 IS the native checker (formerly tsgo)
if (!TURBO_VERSION || !TSGO_VERSION)
  throw new Error("root package.json no longer pins turbo / typescript");
// The per-package tsc: scaffoldWorkspace rewrites each generated package's
// `typescript: catalog:` to the workspace catalog's concrete version, so the
// tsc-lib-build and turbo-typecheck rows run THIS major, not the root's ts7.
const PKG_TSC_VERSION = (/^\s*typescript:\s*(\S+)/m.exec(
  readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8"),
) || [])[1];
// next comes from the same catalog (the generated apps' `next: catalog:`)
const NEXT_CATALOG_VERSION = (/^\s*next:\s*(\S+)/m.exec(
  readFileSync(join(REPO, "pnpm-workspace.yaml"), "utf8"),
) || [])[1];
if (!PKG_TSC_VERSION)
  throw new Error("pnpm-workspace.yaml no longer carries a typescript catalog entry");
const APPS = 20;
const LIBS = 10;
// pass/fail probes, but wall times are recorded — refuse a loaded box
const envInfo = loadGuard("PNP_COMPAT_ALLOW_BUSY");

const ROOT = mkdtempSync(join(tmpdir(), "pnp-compat-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};
const YARNJS = fetchYarnCli(ROOT, YARN_VERSION);
// Every yarn child runs under the node running this bench — the node `versions.node`
// records — with that binary's dir leading PATH so tools yarn spawns by name follow
// it. A bare `node` from PATH could be a different release than the one recorded.
// The dir is asserted to hold that same release (nodeBinDirFor), not assumed to.
let NODE_BIN_DIR;
try {
  NODE_BIN_DIR = nodeBinDirFor(process.execPath, process.version);
} catch (e) {
  fail(e.message);
}
const benchEnv = (overrides) => envForNode(yarnEnv(overrides), NODE_BIN_DIR);

function buildTree(linker) {
  const dir = join(ROOT, linker);
  mkdirSync(dir, { recursive: true });
  scaffoldWorkspace(REPO, dir, { apps: APPS, libs: LIBS, name: `pnp-compat-${linker}` });
  // the probed toolchain rides as root devDependencies, pinned to the repo's stack
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.devDependencies = {
    turbo: TURBO_VERSION,
    oxlint: OXLINT_VERSION,
    // the native checker: typescript@7's only bin is `tsc` (the tsgo name is
    // retired). This is the tree's SECOND tsc major — every generated package
    // pins the catalog typescript for its own build — so the native probe never
    // runs a bare `tsc`; it resolves this package's shim by explicit path.
    typescript: TSGO_VERSION,
  };
  // turbo detects the workspace manager from packageManager, and the generated
  // package tsconfigs extend the repo's tsconfig.base.json
  pkg.packageManager = `yarn@${YARN_VERSION}`;
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(join(dir, "turbo.json"), readFileSync(join(REPO, "turbo.json")));
  writeFileSync(join(dir, "tsconfig.base.json"), readFileSync(join(REPO, "tsconfig.base.json")));
  writeYarnRc(dir, linker === "pnp" ? "pnp" : "node-modules");
  // pin Turbopack's workspace root in the probed app's next.config (BOTH trees, so the
  // treatment is like-for-like): a PnP tree has no node_modules for Next's root inference
  // to anchor on, and an inference error would mask the real PnP answer
  const app = readdirSync(join(dir, "apps")).sort()[0];
  writeFileSync(
    join(dir, "apps", app, "next.config.mjs"),
    `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typescript: { ignoreBuildErrors: true },
  turbopack: { root: ${JSON.stringify(dir)} }
};
export default nextConfig;
`,
  );
  const r = spawnSync(process.execPath, [YARNJS, "install"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    timeout: 600000,
    env: benchEnv(),
  });
  if (r.status !== 0)
    fail(`${linker} install failed:\n${((r.stdout || "") + (r.stderr || "")).slice(-600)}`);
  const edges = (linker === "pnp" ? verifyLib.verifyPnp : verifyLib.verifyNm)(dir);
  console.log(`  ${linker}: installed + verified (${edges} edges)`);
  return dir;
}

// run one tool probe through yarn (PnP runtime active when the tree is PnP); behaviors
// recorded, never asserted — except that a probe must at least SPAWN
function probe(dir, cwd, args, extraEnv) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [YARNJS, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    timeout: 900000,
    env: benchEnv({ TURBO_TELEMETRY_DISABLED: "1", NEXT_TELEMETRY_DISABLED: "1", ...extraEnv }),
  });
  if (r.error) fail(`probe spawn failed (${args.join(" ")}): ${r.error.code || r.error.message}`);
  // a signal-killed tool (segfault/OOM, status null) is a harness fault, not a compat
  // finding — it must never be published as "fails under PnP"
  if (r.signal || r.status === null)
    fail(`probe ${args.join(" ")} killed by ${r.signal || "unknown signal"} — not a measurement`);
  const out = (r.stdout || "") + (r.stderr || "");
  // matched error lines identify the failure class; the last non-empty lines carry the
  // causal error body (Turbopack prints its actual error after generic wrapper lines)
  const errorSample =
    r.status === 0
      ? null
      : [
          ...out
            .split("\n")
            .filter((l) => /error|Error|ERR|cannot|Cannot|not found|Failed/.test(l))
            .slice(0, 4),
          "--- tail ---",
          ...out.split("\n").filter(Boolean).slice(-8),
        ]
          .join("\n")
          .slice(0, 1200);
  return {
    ok: r.status === 0,
    exit: r.status,
    ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
    errorSample,
    out,
  };
}

const out = {
  yarn: YARN_VERSION,
  // two tsc majors per tree: `tsgo` is the root typescript@7 behind the tsgo-app
  // row; `packageTsc` is the per-package catalog typescript behind the
  // tsc-lib-build and turbo-focused-typecheck rows
  versions: {
    turbo: TURBO_VERSION,
    oxlint: OXLINT_VERSION,
    tsgo: TSGO_VERSION,
    packageTsc: PKG_TSC_VERSION,
    next: NEXT_CATALOG_VERSION,
    // the next-build row's PnP outcome is node-version-scoped (rspack-pnp-bench
    // measures the split against a control node)
    node: process.version,
  },
  scale: { apps: APPS, libs: LIBS },
  ...envInfo,
  method:
    "one generated workspace installed twice by the same pinned yarn — PnP and node-modules (the control); each tool runs through yarn in both trees; a tool failing BOTH trees invalidates the run (scaffold problem), a tool passing the control and failing PnP is the finding; ms fields are single samples through yarn (`yarn exec` / `yarn node`, yarn boot + PnP runtime init included) — diagnostic only, the ok booleans are the finding",
  tools: {},
};

// yarn's builtin TypeScript PnP patch vs the native compiler, measured first so a
// failure costs seconds: a minimal PnP project depending only on the pinned
// typescript, installed by the pinned yarn and by YARN_PRE_TS7_PATCH_VERSION.
//   pinned yarn: must exit 0, write .pnp.cjs, and resolve typescript at the pin.
//   old yarn:    must fail in its builtin compat/typescript patch with ENOENT on
//                typescript/lib/_tsc.js — a file the native typescript@7 does not
//                ship. The signature requires the builtin-patch locator, ENOENT,
//                AND that path, so another fetch/patch-stage failure (network,
//                cache) cannot be recorded as this finding.
// Either side flipping fails the bench: this record is why the yarn pin sits
// where it does.
function measureYarnTypescriptPatch() {
  let oldYarnJs;
  try {
    oldYarnJs = fetchYarnCli(ROOT, YARN_PRE_TS7_PATCH_VERSION);
  } catch (e) {
    fail(`ts7-patch: cannot fetch yarn ${YARN_PRE_TS7_PATCH_VERSION}: ${e.message}`);
  }
  const tryInstall = (label, yarnJs) => {
    const dir = join(ROOT, `ts7-patch-${label}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: `ts7-patch-${label}`,
        private: true,
        devDependencies: { typescript: TSGO_VERSION },
      }) + "\n",
    );
    writeFileSync(
      join(dir, ".yarnrc.yml"),
      "nodeLinker: pnp\nenableGlobalCache: false\nenableImmutableInstalls: false\n",
    );
    const r = spawnSync(process.execPath, [yarnJs, "install"], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 1 << 26,
      timeout: 600000,
      env: benchEnv(),
    });
    if (r.error || r.signal || typeof r.status !== "number")
      fail(`ts7-patch ${label}: yarn install did not run to an exit code — not a measurement`);
    const log = (r.stdout || "") + (r.stderr || "");
    const errorLine = log.split("\n").find((l) => /YN0001/.test(l)) ?? null;
    return {
      dir,
      yarnJs,
      rec: {
        exit: r.status,
        ok: r.status === 0,
        pnpManifest: existsSync(join(dir, ".pnp.cjs")),
        builtinPatchEnoent:
          /builtin<compat\/typescript>/.test(log) &&
          /ENOENT/.test(log) &&
          /typescript\/lib\/_tsc\.js/.test(log),
        errorLine: errorLine ? errorLine.slice(0, 300) : null,
      },
    };
  };
  const pinned = tryInstall("pinned", YARNJS);
  const old = tryInstall("old", oldYarnJs);
  // the pinned side must be a REAL PnP install of the pinned typescript
  const resolved = pinned.rec.ok
    ? spawnSync(
        process.execPath,
        [pinned.yarnJs, "node", "-p", "require('typescript/package.json').version"],
        { cwd: pinned.dir, encoding: "utf8", env: benchEnv() },
      )
    : null;
  pinned.rec.resolvedTypescript = resolved
    ? (resolved.stdout || "").trim().split("\n").pop()
    : null;
  // the resolve probe must itself have run to completion: printed text from a
  // process that then died or exited non-zero is not a resolution
  if (resolved && (resolved.error || resolved.signal || resolved.status !== 0))
    fail(
      `ts7-patch: the typescript resolve probe did not exit 0 (status ${resolved.status}, ` +
        `signal ${resolved.signal}) — harness fault`,
    );
  if (!pinned.rec.ok || !pinned.rec.pnpManifest || pinned.rec.resolvedTypescript !== TSGO_VERSION)
    fail(
      `ts7-patch: yarn ${YARN_VERSION} did not produce a PnP install resolving typescript@${TSGO_VERSION} ` +
        `(exit=${pinned.rec.exit}, .pnp.cjs=${pinned.rec.pnpManifest}, resolved=${pinned.rec.resolvedTypescript})`,
    );
  if (old.rec.ok || !old.rec.builtinPatchEnoent)
    fail(
      `ts7-patch: expected yarn ${YARN_PRE_TS7_PATCH_VERSION} to fail in its builtin typescript patch ` +
        `(ENOENT lib/_tsc.js) on typescript@${TSGO_VERSION} — got exit=${old.rec.exit}, ` +
        `builtinPatchEnoent=${old.rec.builtinPatchEnoent}: ${old.rec.errorLine}`,
    );
  console.log(
    `ts7-patch: yarn ${YARN_VERSION} installs typescript@${TSGO_VERSION} under PnP; ` +
      `yarn ${YARN_PRE_TS7_PATCH_VERSION} fails in its builtin typescript patch`,
  );
  return {
    typescript: TSGO_VERSION,
    pinnedYarn: { version: YARN_VERSION, ...pinned.rec },
    oldYarn: { version: YARN_PRE_TS7_PATCH_VERSION, ...old.rec },
  };
}
out.yarnTypescriptPatch = measureYarnTypescriptPatch();

const trees = { pnp: buildTree("pnp"), nm: buildTree("nm") };
// pick the lowest lib (no internal deps — the pure tsc probe) and one app
const libName = (dir) => readdirSync(join(dir, "packages")).sort()[0];
const appName = (dir) => readdirSync(join(dir, "apps")).sort()[0];

for (const [linker, dir] of Object.entries(trees)) {
  const lib = libName(dir);
  const app = appName(dir);
  const appPkg = JSON.parse(readFileSync(join(dir, "apps", app, "package.json"), "utf8")).name;
  const turboEnv = { TURBO_CACHE_DIR: join(dir, ".turbo-cache") };
  const rec = (tool, res) => {
    const { out: rawOut, ...persisted } = res;
    out.tools[tool] = out.tools[tool] || {};
    out.tools[tool][linker] = persisted;
    console.log(
      `  ${linker} ${tool}: ${res.skipped ? "SKIPPED" : res.ok ? "ok" : `FAILED exit=${res.exit}`}${res.ms ? ` ${res.ms}ms` : ""}${res.ok || res.skipped ? "" : `\n    ${String(res.errorSample).split("\n")[0]}`}`,
    );
    return res;
  };
  console.log(`== probing tools under ${linker} ==`);
  // --format=json (same traversal + exit semantics as the default reporter) because the
  // human reporter's file-count summary line is TTY-only; number_of_files is the
  // completeness evidence an exit-0 pass needs
  const ox = rec(
    "oxlint",
    // node_modules excluded explicitly: with root typescript@7 and the packages'
    // catalog typescript 6, the node-modules linker nests a typescript copy under
    // every workspace (apps/*/node_modules), which oxlint would otherwise traverse —
    // 3,780 files instead of the 210 workspace sources PnP (no node_modules) exposes
    probe(dir, dir, [
      "exec",
      "oxlint",
      "--format=json",
      "--ignore-pattern",
      "**/node_modules/**",
      "apps",
      "packages",
    ]),
  );
  out.tools.oxlint[linker].filesLinted = Number(
    (/"number_of_files":\s*(\d+)/.exec(ox.out || "") || [])[1] ?? NaN,
  );
  rec("tsc-lib-build", probe(dir, dir, ["workspace", `@demo/${lib}`, "run", "build"]));
  // turbo 2.9 spawns no daemon for `turbo run`, so nothing outlives the probe to race
  // the exit-handler rmSync
  const turbo = rec(
    "turbo-focused-typecheck",
    probe(dir, dir, ["exec", "turbo", "run", "typecheck", `--filter=${appPkg}...`], turboEnv),
  );
  // tsgo and next probe the app AFTER its lib closure is built by the turbo probe; if
  // that build failed, their failures would be missing-dist cascades, not PnP findings
  if (turbo.ok) {
    // Resolve the ROOT typescript@7 shim by explicit path through this tree's own
    // resolver (PnP-aware) — never `yarn exec tsc`: the tree holds two tsc majors
    // (root ts7 + the per-package catalog tsc) and a bare bin name is ambiguous.
    // Resolved via package.json + join, not require.resolve('typescript/bin/tsc'):
    // typescript@7's `exports` map exposes no ./bin/* subpath, so that resolve
    // throws ERR_PACKAGE_PATH_NOT_EXPORTED under BOTH linkers.
    const shimR = spawnSync(
      process.execPath,
      [
        YARNJS,
        "node",
        "-p",
        "require('node:path').join(require('node:path').dirname(require.resolve('typescript/package.json')),'bin','tsc')",
      ],
      { cwd: dir, encoding: "utf8", env: benchEnv() },
    );
    const ts7Shim = (shimR.stdout || "").trim().split("\n").pop();
    if (shimR.status !== 0 || !ts7Shim)
      fail(
        `${linker}: cannot resolve the root typescript@7 shim:\n${((shimR.stdout || "") + (shimR.stderr || "")).slice(-400)}`,
      );
    rec("tsgo-app", probe(dir, dir, ["node", ts7Shim, "--noEmit", "-p", join("apps", app)]));
    const nb = rec("next-build-app", probe(dir, join(dir, "apps", app), ["exec", "next", "build"]));
    // evidence about the turbopack.root pin, recorded per tree: Next warns on an
    // unrecognized config key, so a clean control run proves the key is valid config;
    // whether the PnP failure still prints the root-inference message is data
    out.tools["next-build-app"][linker].configKeyRejected =
      /invalid next\.config|unrecognized key/i.test(nb.out || "");
    out.tools["next-build-app"][linker].rootInferenceMessagePresent =
      /inferred your workspace root/i.test(nb.out || "");
    // which failure a failing build is: the config-load crash that precedes
    // bundler selection (shared signature; rspack-pnp-bench measures its
    // node-version split against a control node)
    out.tools["next-build-app"][linker].configLoadCrash = isPnpConfigLoadCrash(nb.out || "");
  } else {
    const skip = {
      skipped: true,
      reason: "closure build (turbo probe) failed in this tree — a result would be unattributable",
    };
    rec("tsgo-app", { ...skip });
    rec("next-build-app", { ...skip });
  }
}

// oxlint completeness: when BOTH runs exit 0, they must have linted the same file
// count — an exit-0 pass that traversed a different tree is vacuous. A failed run is
// the compat finding itself and is judged by the control gate, not by parity.
{
  const { pnp, nm } = out.tools.oxlint;
  if (
    pnp.ok &&
    nm.ok &&
    (!Number.isFinite(pnp.filesLinted) ||
      pnp.filesLinted <= 0 ||
      pnp.filesLinted !== nm.filesLinted)
  )
    fail(
      `oxlint file-count check failed (pnp=${pnp.filesLinted}, nm=${nm.filesLinted}; both must be equal and positive) — an exit-0 run that linted nothing, or a different tree, is not a compat data point`,
    );
}

// validity: the turbopack.root key must not be rejected as unknown config in the
// passing control — otherwise the pin is a no-op and the PnP probe ran unpinned
if (out.tools["next-build-app"].nm?.configKeyRejected)
  fail(
    "next rejected the turbopack.root config key in the control tree — the pin is invalid config",
  );

// validity: the control tree must pass every probe, or PnP failures are unattributable
// (an nm-tree skip only happens when nm turbo failed, which is itself a control failure)
const controlFailures = Object.entries(out.tools)
  .filter(([, v]) => !v.nm.ok)
  .map(([k]) => k);
if (controlFailures.length)
  fail(
    `node-modules CONTROL failed for: ${controlFailures.join(", ")} — the scaffold is broken, PnP results are unattributable`,
  );

out.summary = Object.fromEntries(
  Object.entries(out.tools).map(([k, v]) => [
    k,
    v.pnp.skipped
      ? "not probed under PnP (closure build failed upstream)"
      : v.pnp.ok
        ? "works under PnP"
        : `fails under PnP (control passes): exit ${v.pnp.exit}`,
  ]),
);
writeFileSync(join(REPO, "bench", "pnp-compat-bench.json"), JSON.stringify(out, null, 2) + "\n");
console.log("\n--- bench/pnp-compat-bench.json written ---");
for (const [k, s] of Object.entries(out.summary)) console.log(`${k.padEnd(24)} ${s}`);

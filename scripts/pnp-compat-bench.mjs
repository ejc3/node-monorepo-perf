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
//   tsgo              — `tsgo --noEmit -p <app>` after the closure is built (native
//                       binary with its own module resolver)
//   next build        — one app's production build after the closure is built
//
// Self-contained: scaffolds under the OS temp dir, removed on exit; needs no worktree;
// touches no turbo state (TURBO_CACHE_DIR pinned inside the scaffold).

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { YARN_VERSION } from "./_pins.mjs";
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
const TSGO_VERSION = repoDevDeps["@typescript/native-preview"];
if (!TURBO_VERSION || !TSGO_VERSION)
  throw new Error("root package.json no longer pins turbo / @typescript/native-preview");
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

function buildTree(linker) {
  const dir = join(ROOT, linker);
  mkdirSync(dir, { recursive: true });
  scaffoldWorkspace(REPO, dir, { apps: APPS, libs: LIBS, name: `pnp-compat-${linker}` });
  // the probed toolchain rides as root devDependencies, pinned to the repo's stack
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.devDependencies = {
    turbo: TURBO_VERSION,
    oxlint: OXLINT_VERSION,
    "@typescript/native-preview": TSGO_VERSION,
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
  const r = spawnSync("node", [YARNJS, "install"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    timeout: 600000,
    env: yarnEnv(),
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
  const r = spawnSync("node", [YARNJS, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    timeout: 900000,
    env: yarnEnv({ TURBO_TELEMETRY_DISABLED: "1", NEXT_TELEMETRY_DISABLED: "1", ...extraEnv }),
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
  versions: { turbo: TURBO_VERSION, oxlint: OXLINT_VERSION, tsgo: TSGO_VERSION },
  scale: { apps: APPS, libs: LIBS },
  ...envInfo,
  method:
    "one generated workspace installed twice by the same pinned yarn — PnP and node-modules (the control); each tool runs through yarn in both trees; a tool failing BOTH trees invalidates the run (scaffold problem), a tool passing the control and failing PnP is the finding; ms fields are single samples through `yarn exec` (yarn boot + PnP runtime init included) — diagnostic only, the ok booleans are the finding",
  tools: {},
};

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
    probe(dir, dir, ["exec", "oxlint", "--format=json", "apps", "packages"]),
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
    rec("tsgo-app", probe(dir, dir, ["exec", "tsgo", "--noEmit", "-p", join("apps", app)]));
    const nb = rec("next-build-app", probe(dir, join(dir, "apps", app), ["exec", "next", "build"]));
    // evidence about the turbopack.root pin, recorded per tree: Next warns on an
    // unrecognized config key, so a clean control run proves the key is valid config;
    // whether the PnP failure still prints the root-inference message is data
    out.tools["next-build-app"][linker].configKeyRejected =
      /invalid next\.config|unrecognized key/i.test(nb.out || "");
    out.tools["next-build-app"][linker].rootInferenceMessagePresent =
      /inferred your workspace root/i.test(nb.out || "");
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
  if (pnp.ok && nm.ok && (!Number.isFinite(pnp.filesLinted) || pnp.filesLinted !== nm.filesLinted))
    fail(
      `oxlint file-count parity failed (pnp=${pnp.filesLinted}, nm=${nm.filesLinted}) — an exit-0 run that traversed a different tree is not a compat data point`,
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

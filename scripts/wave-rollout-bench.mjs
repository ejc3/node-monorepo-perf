#!/usr/bin/env node
// The mechanics of advancing an internal core lib through a hermetic, wave-based rollout, measured as a
// bun-vs-pnpm head-to-head on self-contained repros. This is the empirical backing for ROLLOUT.md. bun
// is the recommended driver: it does everything the rollout needs natively and cold-installs 58-440x
// faster than pnpm in the clean-env case (fresh node_modules, through the 2,000-app measured ceiling;
// bench/install-bench.json) — warm-cached runners narrow the gap and pnpm-hoisted can win fully-warm at
// 2,000 apps. Each rung HARD-ASSERTS a stable fact; setup failures (a seed
// install that did not run, a missing lockfile, a network/registry error) HARD-FAIL, so a failed
// measurement never reads as a clean result. The running bun is pinned to 1.3.14 (the version the source
// line refs in the recorded note were read against).
//
//   1. Determinism boundary. The lockfile, not the range, makes a build reproducible: a committed
//      lockfile + a frozen install pins the exact version, so a `^`/`*` range is inert.
//        - bun: `bunfig.toml [install] frozenLockfile = true` makes a bare `bun install` fail closed on
//          drift (one committed line; bun does not auto-enable frozen in CI, so this is how you get it).
//        - pnpm: `--frozen-lockfile` is byte-identical across runs and fails closed on drift
//          (ERR_PNPM_OUTDATED_LOCKFILE); pnpm flips its frozen default to true in CI.
//   2. Lane mechanism (named catalogs). Two cohorts route to two versions in ONE lockfile, and a wave's
//      repoint edits ZERO consumer manifests — natively on both, bun in package.json, pnpm in
//      pnpm-workspace.yaml.
//   3. workspace: as a catalog value. bun ACCEPTS it and links the local package; pnpm REJECTS it
//      (ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC) for every form. bun is the more capable driver.
//   4. Publish bakes a CONCRETE range. `bun pm pack` / `pnpm pack` rewrite a lib's internal
//      `workspace:^` -> `^x.y.z` (and `catalog:` -> a version) in the tarball, so advancing a lib every
//      other lib re-exports is a republish-fanout, not a one-line catalog flip — identical on both.
//   5. The one cross-tool gotcha: bun does not read catalogs from pnpm-workspace.yaml (only package.json),
//      so author the catalog where the driver reads it; do not mix.
//
//   node scripts/wave-rollout-bench.mjs
//
// Self-contained and non-destructive: scaffolds throwaway workspaces under the OS temp dir (never the
// repo tree, so no worktree needed) and removes them on exit. Pins each scaffold to the public npm
// registry for one tiny real dep (is-odd) so resolution is deterministic and auth-free — the registry
// IDENTITY is immaterial to the pnpm/bun mechanics shown here. HARD-FAILS if any asserted mechanic stops
// reproducing -> bench/wave-rollout-bench.json.

import { execSync } from "node:child_process";
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  mkdtempSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// is-odd has long-stable ancient versions; 1.0.0 = "stable" channel, 3.0.0 = "next" channel.
const DEP = "is-odd";
const STABLE = "1.0.0";
const NEXT = "3.0.0";
const FROZEN_SPEC = "^3.0.0"; // the floating range whose lockfile-pinned resolution must stay constant
const REGISTRY = "https://registry.npmjs.org/";
const BUN_SOURCE_TAG = "bun-v1.3.14"; // the tag the recorded source line refs were verified against
const BUN_PINNED = "1.3.14";

const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};

// A kill (OOM/panic/segfault) exits 128+signo through the shell; treat any such exit as a crash so a
// killed tool never reads as a clean pass/fail. A package manager exiting non-zero on drift/invalid
// config is data (the whole point), not a crash.
const isSignalExit = (code) => code > 128 && code <= 192;
const CRASH =
  /Command terminated by signal|panic:|Segmentation fault|out of memory|\(core dumped\)/i;

function run(cmd, cwd, env) {
  let out = "";
  let code = 0;
  try {
    out = execSync(cmd, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
      maxBuffer: 32 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    });
  } catch (e) {
    if (e.signal) throw new Error(`\`${cmd}\` killed by ${e.signal} (timeout?)`);
    code = e.status ?? -1;
    out = (e.stdout || "") + (e.stderr || "");
  }
  if (CRASH.test(out) || isSignalExit(code))
    throw new Error(`crash in \`${cmd}\` (exit ${code}):\n${out.slice(-800)}`);
  return { code, out };
}
const ver = (tool) => execSync(`${tool} --version`, { encoding: "utf8" }).trim();
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
const readJSON = (p) => JSON.parse(readFileSync(p, "utf8"));
// The version a consumer actually resolves, via node's own module resolution from that dir — robust
// across pnpm's symlinked layout and bun's hoisted one (what the build would compile against).
function resolveVer(dir, dep) {
  const r = run(`node -p "require('${dep}/package.json').version"`, dir);
  if (r.code !== 0) fail(`could not resolve ${dep} from ${dir}\n${r.out.slice(-300)}`);
  return r.out.trim();
}

const PNPM_VER = (() => {
  try {
    return ver("pnpm");
  } catch {
    return fail("missing pnpm on PATH");
  }
})();
const BUN_VER = (() => {
  try {
    return ver("bun");
  } catch {
    return fail("missing bun on PATH");
  }
})();
// The recorded note cites bun source at BUN_SOURCE_TAG; refuse to record those citations against a
// different bun, so the JSON never pairs a measured version with stale line refs.
if (BUN_VER !== BUN_PINNED)
  fail(
    `bun ${BUN_VER} != ${BUN_PINNED}: the recorded source line refs are pinned to ${BUN_SOURCE_TAG}; re-verify them before recording another version.`,
  );

const ROOT = mkdtempSync(join(tmpdir(), "wave-rollout-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// Scaffold helper: write files under a named scaffold dir, always with a public-registry .npmrc.
function scaffold(name, files) {
  const base = join(ROOT, name);
  const all = { ".npmrc": `registry=${REGISTRY}\n`, ...files };
  for (const [rel, content] of Object.entries(all)) {
    const p = join(base, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return base;
}
const writeJSON = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2));
// One package.json shape for a consumer/leaf.
const mf = (name, deps) => ({ name, version: "0.0.0", private: true, dependencies: deps });

// =================================================================================================
// 1. DETERMINISM — the lockfile is the boundary; both drivers fail closed on drift.
// =================================================================================================
console.log("== 1. Determinism: frozen install fails closed on drift ==");

// 1a. bun: bunfig frozenLockfile=true. Seed the lock first (no bunfig), then freeze, then drift.
const bunDet = scaffold("1a-bun-frozen", {
  "package.json": mf("wave-bun-frozen", { [DEP]: FROZEN_SPEC }),
});
const bunSeed = run("bun install", bunDet);
const bunLock = join(bunDet, "bun.lock");
if (bunSeed.code !== 0 || !existsSync(bunLock))
  fail(
    `1a: bun seed install failed / no bun.lock (network?) exit ${bunSeed.code}\n${bunSeed.out.slice(-600)}`,
  );
writeFileSync(join(bunDet, "bunfig.toml"), "[install]\nfrozenLockfile = true\n");
const bunLockBefore = sha(bunLock);
writeJSON(
  join(bunDet, "package.json"),
  mf("wave-bun-frozen", { [DEP]: FROZEN_SPEC, "is-even": "^1.0.0" }),
);
const bunFrozen = run("bun install", bunDet); // bare install; bunfig makes it frozen
const bunFrozenDiag = /lockfile had changes, but lockfile is frozen/i.test(bunFrozen.out);
const bunLockChanged = !existsSync(bunLock) || sha(bunLock) !== bunLockBefore;
const bunFailsClosed = bunFrozen.code !== 0 && !bunLockChanged && bunFrozenDiag;
if (!bunFailsClosed)
  fail(
    `1a: bunfig frozen should fail closed on drift; exit ${bunFrozen.code}, lockChanged ${bunLockChanged}\n${bunFrozen.out.slice(-600)}`,
  );

// 1a (context): a bare `bun install` with CI=1 and NO bunfig does NOT auto-freeze — it re-resolves.
// This is why the bunfig line is required (source: bun does not flip frozen in CI).
const bunCi = scaffold("1a-bun-ci", { "package.json": mf("wave-bun-ci", { [DEP]: FROZEN_SPEC }) });
const bunCiSeed = run("bun install", bunCi);
const bunCiLock = join(bunCi, "bun.lock");
if (bunCiSeed.code !== 0 || !existsSync(bunCiLock))
  fail(`1a-ci: bun seed failed / no lock exit ${bunCiSeed.code}\n${bunCiSeed.out.slice(-600)}`);
const bunCiBefore = sha(bunCiLock);
writeJSON(
  join(bunCi, "package.json"),
  mf("wave-bun-ci", { [DEP]: FROZEN_SPEC, "is-even": "^1.0.0" }),
);
const bunCiRun = run("bun install", bunCi, { CI: "1" });
const bunCiRewrote = existsSync(bunCiLock) && sha(bunCiLock) !== bunCiBefore;
const bunCiAutoFroze =
  bunCiRun.code !== 0 && /lockfile had changes, but lockfile is frozen/i.test(bunCiRun.out);
if (!(bunCiRun.code === 0 && bunCiRewrote) && !bunCiAutoFroze)
  fail(
    `1a-ci: could not classify CI=1 bare install (exit ${bunCiRun.code}, rewrote ${bunCiRewrote})\n${bunCiRun.out.slice(-600)}`,
  );
if (bunCiAutoFroze)
  fail(
    `1a-ci: bun auto-froze under CI=1 (contradicts ${BUN_SOURCE_TAG} source)\n${bunCiRun.out.slice(-600)}`,
  );

// 1b. pnpm: --frozen-lockfile byte-identical across runs + fail closed on drift.
const pnpmDet = scaffold("1b-pnpm-frozen", {
  "package.json": mf("wave-pnpm-frozen", { [DEP]: FROZEN_SPEC }),
});
const pnpmSeed = run("pnpm install --no-frozen-lockfile", pnpmDet);
if (pnpmSeed.code !== 0 || !existsSync(join(pnpmDet, "node_modules", DEP)))
  fail(`1b: pnpm seed install failed exit ${pnpmSeed.code}\n${pnpmSeed.out.slice(-600)}`);
const pnpmLock = join(pnpmDet, "pnpm-lock.yaml");
const pnpmV1 = resolveVer(pnpmDet, DEP);
const pnpmHash1 = sha(pnpmLock);
const PNPM_FROZEN_RUNS = 2;
let pnpmByteIdentical = true;
for (let i = 0; i < PNPM_FROZEN_RUNS; i++) {
  rmSync(join(pnpmDet, "node_modules"), { recursive: true, force: true });
  const r = run("pnpm install --frozen-lockfile", pnpmDet);
  if (r.code !== 0 || !existsSync(join(pnpmDet, "node_modules", DEP)))
    fail(`1b: pnpm frozen #${i + 1} failed exit ${r.code}\n${r.out.slice(-600)}`);
  if (resolveVer(pnpmDet, DEP) !== pnpmV1 || sha(pnpmLock) !== pnpmHash1) pnpmByteIdentical = false;
}
if (!pnpmByteIdentical) fail(`1b: pnpm frozen not byte-identical`);
writeJSON(
  join(pnpmDet, "package.json"),
  mf("wave-pnpm-frozen", { [DEP]: FROZEN_SPEC, "is-even": "^1.0.0" }),
);
// Fail-closed means BOTH: non-zero exit with the outdated-lockfile error AND the lockfile left
// untouched (symmetric with the bun path, which also checks the lock did not change).
const pnpmLockBeforeDrift = sha(pnpmLock);
const pnpmDrift = run("pnpm install --frozen-lockfile", pnpmDet);
const pnpmDriftErr = (pnpmDrift.out.match(/ERR_PNPM_OUTDATED_LOCKFILE/) || [])[0] || null;
const pnpmFailsClosedOnDrift =
  pnpmDrift.code !== 0 && !!pnpmDriftErr && sha(pnpmLock) === pnpmLockBeforeDrift;
if (!pnpmFailsClosedOnDrift)
  fail(
    `1b: pnpm frozen should fail closed (ERR_PNPM_OUTDATED_LOCKFILE, lock unchanged) exit ${pnpmDrift.code}\n${pnpmDrift.out.slice(-600)}`,
  );
// pnpm auto-enables frozen in CI: a BARE `pnpm install` (no --frozen-lockfile flag) with CI set must
// also fail closed on the same drift (non-zero + outdated-lockfile error + lock untouched) — MEASURED,
// not assumed (symmetric with bun's 1a-ci, where bare CI=1 re-resolves). The manifest is still drifted
// and the lockfile unchanged from the run above.
const pnpmCiRun = run("pnpm install", pnpmDet, { CI: "true" });
const pnpmCiFrozenErr = (pnpmCiRun.out.match(/ERR_PNPM_OUTDATED_LOCKFILE/) || [])[0] || null;
const pnpmAutoFreezesInCi =
  pnpmCiRun.code !== 0 && !!pnpmCiFrozenErr && sha(pnpmLock) === pnpmLockBeforeDrift;
if (!pnpmAutoFreezesInCi)
  fail(
    `1b-ci: pnpm should auto-enable frozen in CI (bare install fails closed, lock unchanged) exit ${pnpmCiRun.code}\n${pnpmCiRun.out.slice(-600)}`,
  );
console.log(
  `  bun (bunfig frozen): exit ${bunFrozen.code} fail-closed; CI=1 without bunfig re-resolves (exit ${bunCiRun.code})  |  ` +
    `pnpm (--frozen): ${DEP}@${pnpmV1} byte-identical x${PNPM_FROZEN_RUNS}, drift -> ${pnpmDriftErr}; bare CI install -> ${pnpmCiFrozenErr}`,
);

// =================================================================================================
// 2. LANE MECHANISM — named catalogs route cohorts + repoint with zero consumer-manifest edits.
// =================================================================================================
console.log("== 2. Named-catalog lanes: route two cohorts + zero-manifest repoint ==");

// 2a. bun native: catalogs live in the root package.json workspaces object.
const bunLane = scaffold("2a-bun-catalog", {
  "package.json": {
    name: "wave-bun-catalog-root",
    version: "0.0.0",
    private: true,
    workspaces: {
      packages: ["consumers/*"],
      catalogs: { stable: { [DEP]: STABLE }, next: { [DEP]: NEXT } },
    },
  },
  "consumers/cs/package.json": mf("@wave/cs", { [DEP]: "catalog:stable" }),
  "consumers/cn/package.json": mf("@wave/cn", { [DEP]: "catalog:next" }),
});
if (run("bun install", bunLane).code !== 0) fail(`2a: bun catalog install failed`);
const bunCs = resolveVer(join(bunLane, "consumers/cs"), DEP);
const bunCn = resolveVer(join(bunLane, "consumers/cn"), DEP);
if (bunCs !== STABLE || bunCn !== NEXT) fail(`2a: bun routing wrong: cs->${bunCs}, cn->${bunCn}`);
// Hash BOTH consumer manifests before/after so "no consumer manifest edited" covers every consumer.
const bunLaneManifests = ["cs", "cn"].map((c) => join(bunLane, `consumers/${c}/package.json`));
const bunManifestsBefore = bunLaneManifests.map(sha);
const bunRoot = readJSON(join(bunLane, "package.json"));
bunRoot.workspaces.catalogs.stable[DEP] = NEXT;
writeJSON(join(bunLane, "package.json"), bunRoot);
if (run("bun install", bunLane).code !== 0) fail(`2a: bun repoint install failed`);
const bunCsAfter = resolveVer(join(bunLane, "consumers/cs"), DEP);
const bunManifestsEdited = bunLaneManifests.filter(
  (p, i) => sha(p) !== bunManifestsBefore[i],
).length;
if (bunCsAfter !== NEXT || bunManifestsEdited !== 0)
  fail(`2a: bun repoint failed: cs->${bunCsAfter}, manifests edited ${bunManifestsEdited}`);

// 2b. pnpm: named catalogs in pnpm-workspace.yaml.
const pnpmLane = scaffold("2b-pnpm-catalog", {
  "package.json": { name: "wave-pnpm-catalog-root", version: "0.0.0", private: true },
  "pnpm-workspace.yaml": `packages:\n  - "consumers/*"\ncatalogs:\n  stable:\n    ${DEP}: ${STABLE}\n  next:\n    ${DEP}: ${NEXT}\n`,
  "consumers/cs/package.json": mf("@wave/cs", { [DEP]: "catalog:stable" }),
  "consumers/cn/package.json": mf("@wave/cn", { [DEP]: "catalog:next" }),
});
if (run("pnpm install --no-frozen-lockfile", pnpmLane).code !== 0)
  fail(`2b: pnpm catalog install failed`);
const pnpmCs = resolveVer(join(pnpmLane, "consumers/cs"), DEP);
const pnpmCn = resolveVer(join(pnpmLane, "consumers/cn"), DEP);
if (pnpmCs !== STABLE || pnpmCn !== NEXT)
  fail(`2b: pnpm routing wrong: cs->${pnpmCs}, cn->${pnpmCn}`);
// One lockfile holds both majors: a single root pnpm-lock.yaml, no per-consumer lockfile.
const pnpmLaneLock = readFileSync(join(pnpmLane, "pnpm-lock.yaml"), "utf8");
const pnpmOneLockfile =
  !existsSync(join(pnpmLane, "consumers/cs/pnpm-lock.yaml")) &&
  !existsSync(join(pnpmLane, "consumers/cn/pnpm-lock.yaml")) &&
  pnpmLaneLock.includes(`${DEP}@${STABLE}`) &&
  pnpmLaneLock.includes(`${DEP}@${NEXT}`);
if (!pnpmOneLockfile) fail(`2b: expected one lockfile holding both ${DEP} majors`);
const pnpmLaneManifests = ["cs", "cn"].map((c) => join(pnpmLane, `consumers/${c}/package.json`));
const pnpmManifestsBefore = pnpmLaneManifests.map(sha);
writeFileSync(
  join(pnpmLane, "pnpm-workspace.yaml"),
  `packages:\n  - "consumers/*"\ncatalogs:\n  stable:\n    ${DEP}: ${NEXT}\n  next:\n    ${DEP}: ${NEXT}\n`,
);
if (run("pnpm install --no-frozen-lockfile", pnpmLane).code !== 0)
  fail(`2b: pnpm repoint install failed`);
const pnpmCsAfter = resolveVer(join(pnpmLane, "consumers/cs"), DEP);
const pnpmManifestsEdited = pnpmLaneManifests.filter(
  (p, i) => sha(p) !== pnpmManifestsBefore[i],
).length;
if (pnpmCsAfter !== NEXT || pnpmManifestsEdited !== 0)
  fail(`2b: pnpm repoint failed: cs->${pnpmCsAfter}, manifests edited ${pnpmManifestsEdited}`);
console.log(
  `  bun: cs->${bunCs} cn->${bunCn}, repoint cs->${bunCsAfter} (manifests edited ${bunManifestsEdited}/2)  |  ` +
    `pnpm: cs->${pnpmCs} cn->${pnpmCn}, repoint cs->${pnpmCsAfter} (manifests edited ${pnpmManifestsEdited}/2)`,
);

// =================================================================================================
// 3. workspace: AS A CATALOG VALUE — bun accepts + links local; pnpm rejects every form.
// =================================================================================================
console.log("== 3. workspace: as a catalog value: bun accepts (links local), pnpm rejects ==");

// 3a. bun: catalog value workspace:* resolves the LOCAL workspace package (sentinel proves it).
const bunWs = scaffold("3a-bun-ws-catalog", {
  "package.json": {
    name: "wave-bun-ws-root",
    version: "0.0.0",
    private: true,
    workspaces: {
      packages: ["packages/*", "consumers/*"],
      catalog: { "@wave/util": "workspace:*" },
    },
  },
  "packages/util/package.json": { name: "@wave/util", version: "1.0.0", main: "index.js" },
  "packages/util/index.js": 'module.exports = "LOCAL-UTIL";\n',
  "consumers/app/package.json": mf("@wave/ws-app", { "@wave/util": "catalog:" }),
});
const bunWsInstall = run("bun install", bunWs);
if (bunWsInstall.code !== 0)
  fail(
    `3a: bun should accept workspace:* in a catalog; exit ${bunWsInstall.code}\n${bunWsInstall.out.slice(-600)}`,
  );
const bunWsResolved = run(`node -p "require('@wave/util')"`, join(bunWs, "consumers/app"));
if (bunWsResolved.code !== 0 || bunWsResolved.out.trim() !== "LOCAL-UTIL")
  fail(
    `3a: bun catalog workspace:* did not link the local package; got "${bunWsResolved.out.trim()}"`,
  );

// 3b. pnpm: every workspace: form is rejected. Record per-form rejections so "every form rejected" is
// a measured count, not a hardcoded boolean.
const PNPM_WS_FORMS = ["workspace:*", "workspace:^", "workspace:~", "workspace:^1.0.0"];
let pnpmWsFormsRejected = 0;
for (const form of PNPM_WS_FORMS) {
  const d = scaffold(`3b-pnpm-ws-${form.replace(/[^a-z0-9]/gi, "_")}`, {
    "package.json": { name: "wave-pnpm-ws-root", version: "0.0.0", private: true },
    "pnpm-workspace.yaml": `packages:\n  - "packages/*"\n  - "consumers/*"\ncatalog:\n  "@wave/util": "${form}"\n`,
    "packages/util/package.json": { name: "@wave/util", version: "1.0.0", private: true },
    "consumers/app/package.json": mf("@wave/ws-app", { "@wave/util": "catalog:" }),
  });
  const r = run("pnpm install --no-frozen-lockfile", d);
  if (r.code === 0 || !/ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC/.test(r.out))
    fail(`3b: pnpm should reject catalog "${form}"; exit ${r.code}\n${r.out.slice(-600)}`);
  pnpmWsFormsRejected++;
}
console.log(
  `  bun: workspace:* catalog -> linked LOCAL-UTIL  |  pnpm: every form rejected (${PNPM_WS_FORMS.join(", ")})`,
);

// =================================================================================================
// 4. PUBLISH BAKES A CONCRETE RANGE — the universal collapse, identical on both.
// =================================================================================================
console.log("== 4. Publish bakes a concrete range (universal collapse) ==");
// mid re-exports core via workspace:^ and pulls is-odd via catalog:; BOTH must bake to concrete in the
// tarball while the on-disk source manifest stays untouched. extraFiles lets the pnpm case add its
// pnpm-workspace.yaml catalog (pnpm reads catalogs there, not in package.json).
function packMid(name, rootPkg, packCmd, extraFiles = {}) {
  const dir = scaffold(name, {
    "package.json": rootPkg,
    ...extraFiles,
    "packages/core/package.json": { name: "@wave/core", version: "2.5.0", main: "index.js" },
    "packages/core/index.js": "module.exports = { v: 2 };\n",
    "packages/mid/package.json": {
      name: "@wave/mid",
      version: "1.0.0",
      main: "index.js",
      dependencies: { "@wave/core": "workspace:^", [DEP]: "catalog:" },
    },
    "packages/mid/index.js": "module.exports = require('@wave/core');\n",
  });
  const inst = packCmd.install(dir);
  if (inst.code !== 0)
    fail(`4 (${name}): install failed exit ${inst.code}\n${inst.out.slice(-600)}`);
  const midDir = join(dir, "packages/mid");
  const pack = run(packCmd.pack, midDir);
  if (pack.code !== 0) fail(`4 (${name}): pack failed exit ${pack.code}\n${pack.out.slice(-600)}`);
  const tgz = readdirSync(midDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) fail(`4 (${name}): no tarball produced`);
  const tar = run(`tar -xzOf ${tgz} package/package.json`, midDir);
  if (tar.code !== 0 || !tar.out.trim())
    fail(`4 (${name}): tar could not read tarball package.json`);
  const tarballDeps = JSON.parse(tar.out).dependencies;
  // The on-disk source manifest must be UNCHANGED by pack — the rewrite is tarball-only. Read it back
  // so sourceCore/sourceDep are MEASURED, not assumed.
  const sourceDeps = readJSON(join(midDir, "package.json")).dependencies;
  return {
    core: tarballDeps["@wave/core"],
    dep: tarballDeps[DEP],
    sourceCore: sourceDeps["@wave/core"],
    sourceDep: sourceDeps[DEP],
  };
}
const bunBake = packMid(
  "4a-bun-pack",
  {
    name: "wave-bun-bake-root",
    version: "0.0.0",
    private: true,
    workspaces: { packages: ["packages/*"], catalog: { [DEP]: STABLE } },
  },
  { install: (d) => run("bun install", d), pack: "bun pm pack" },
);
const pnpmBake = packMid(
  "4b-pnpm-pack",
  { name: "wave-pnpm-bake-root", version: "0.0.0", private: true },
  {
    install: (d) => run("pnpm install --no-frozen-lockfile", d),
    pack: "pnpm pack --pack-destination .",
  },
  { "pnpm-workspace.yaml": `packages:\n  - "packages/*"\ncatalog:\n  ${DEP}: ${STABLE}\n` },
);
// Assert BOTH baked edges (workspace:^ -> ^2.5.0 AND catalog: -> the concrete version) AND that pack
// left the source manifest untouched — every recorded field is then a measured, hard-asserted fact.
for (const [tool, b] of [
  ["bun", bunBake],
  ["pnpm", pnpmBake],
]) {
  if (b.core !== "^2.5.0")
    fail(`4 (${tool}): expected workspace:^ baked to ^2.5.0 in the tarball, got "${b.core}"`);
  if (b.dep !== STABLE)
    fail(`4 (${tool}): expected catalog: baked to ${STABLE} in the tarball, got "${b.dep}"`);
  if (b.sourceCore !== "workspace:^" || b.sourceDep !== "catalog:")
    fail(
      `4 (${tool}): pack mutated the source manifest (core "${b.sourceCore}", dep "${b.sourceDep}")`,
    );
}
console.log(
  `  bun: @wave/core "${bunBake.sourceCore}" -> "${bunBake.core}", ${DEP} "${bunBake.sourceDep}" -> "${bunBake.dep}"  |  ` +
    `pnpm: @wave/core -> "${pnpmBake.core}", ${DEP} -> "${pnpmBake.dep}" (source unchanged)`,
);

// =================================================================================================
// 5. CROSS-TOOL GOTCHA — bun does not read catalogs from pnpm-workspace.yaml (only package.json).
// =================================================================================================
console.log("== 5. bun does not read pnpm-workspace.yaml catalogs ==");
const bunPnpmCat = scaffold("5-bun-pnpm-catalog", {
  "package.json": mf("wave-bun-pnpmcat", { [DEP]: "catalog:" }),
  "pnpm-workspace.yaml": `catalog:\n  ${DEP}: ${STABLE}\n`,
});
const bunPnpmCatRun = run("bun install", bunPnpmCat);
const bunPnpmCatResolved =
  bunPnpmCatRun.code === 0 && existsSync(join(bunPnpmCat, "node_modules", DEP));
const bunPnpmCatDiag = new RegExp(`${DEP}@catalog:.*failed to resolve`, "i").test(
  bunPnpmCatRun.out,
);
if (bunPnpmCatResolved)
  fail(
    `5: bun resolved a pnpm-workspace.yaml catalog (contradicts ${BUN_SOURCE_TAG} source)\n${bunPnpmCatRun.out.slice(-600)}`,
  );
if (!bunPnpmCatDiag)
  fail(`5: bun failed for a non-catalog reason (network?)\n${bunPnpmCatRun.out.slice(-600)}`);
console.log(
  `  bun install -> "${DEP}@catalog: failed to resolve" (author bun catalogs in package.json)`,
);

// --- record ----------------------------------------------------------------------------------------
const result = {
  claim:
    "Core-lib wave-rollout mechanics, measured as a bun-vs-pnpm head-to-head. bun is the recommended " +
    "driver: it does all of it natively and cold-installs 58-440x faster than pnpm in the clean-env case " +
    "that recurs in practice (bench/install-bench.json; warm-cached runners narrow the gap and pnpm-hoisted " +
    "can win fully-warm at 2,000 apps). " +
    "Determinism is the lockfile + a frozen install (the range is inert): bun fails closed on drift with " +
    "one committed bunfig line (frozenLockfile=true); pnpm fails closed with --frozen-lockfile and " +
    "auto-enables frozen in CI. Named catalogs route two cohorts to two versions in one lockfile and a " +
    "repoint edits zero consumer manifests on both (bun in package.json, pnpm in pnpm-workspace.yaml). " +
    "bun ACCEPTS workspace:* as a catalog value and links the local package; pnpm rejects every form. " +
    "Both bake a CONCRETE range on publish (workspace:^ -> ^2.5.0), so advancing a universal lib is a " +
    "republish-fanout. bun does not read pnpm-workspace.yaml catalogs, so author them in package.json.",
  versions: { pnpm: PNPM_VER, bun: BUN_VER, node: process.version },
  registry: REGISTRY,
  speedContext: {
    source: "bench/install-bench.json",
    note: "Regime matters and both are recorded. COLD install (fresh node_modules, warm store) bun vs pnpm-isolated: ~440x at 200 apps, ~100x at 1,000, ~58x at 2,000 (measured ceiling 2,000 apps). TRULY-COLD (cold store too, fresh container): bun 1.2s vs pnpm-hoisted 48.9s at 200 apps (~41x). WARM (store + node_modules cached): single-digit seconds through 1,000 apps, but at 2,000 apps bun warm 10.1s while pnpm-hoisted warm 4.7s is ~2x faster than bun. bun wins the clean-env/cold case; pnpm-hoisted can win the fully-warm case.",
  },
  determinism: {
    bun: {
      config: "bunfig.toml [install] frozenLockfile=true; bare bun install on drift",
      failsClosedOnDrift: bunFailsClosed,
      exitCode: bunFrozen.code,
      diagnostic: bunFrozenDiag ? "lockfile had changes, but lockfile is frozen" : null,
      ciAutoEnablesFrozen: bunCiAutoFroze, // measured: CI=1 without bunfig re-resolves; bunfig is required
      sourceVerifiedAt: BUN_SOURCE_TAG,
      sourceNote:
        "frozen_lockfile is set only by --frozen-lockfile / `bun ci` / --production / bunfig " +
        "(CommandLineArguments.zig:797, PackageManagerOptions.zig:335-344,613-620); env.isCI() only " +
        "disables the progress bar (PackageManagerOptions.zig:392).",
    },
    pnpm: {
      config: "committed pnpm-lock.yaml + pnpm install --frozen-lockfile",
      inputSpec: FROZEN_SPEC,
      resolvedVersion: pnpmV1,
      byteIdentical: pnpmByteIdentical,
      frozenRuns: PNPM_FROZEN_RUNS,
      failsClosedOnDrift: pnpmFailsClosedOnDrift, // measured: non-zero + outdated-lockfile error + lock unchanged
      driftExitCode: pnpmDrift.code,
      driftError: pnpmDriftErr,
      autoEnablesFrozenInCi: pnpmAutoFreezesInCi, // measured: bare CI install fails closed on the same drift
      ciDriftError: pnpmCiFrozenErr,
    },
  },
  namedCatalogLanes: {
    consumers: 2,
    bun: {
      where: "root package.json workspaces.catalogs",
      stableResolves: bunCs,
      nextResolves: bunCn,
      repointConsumerManifestsEdited: bunManifestsEdited, // counted over BOTH consumers
      cohortMovedTo: bunCsAfter,
    },
    pnpm: {
      where: "pnpm-workspace.yaml catalogs",
      stableResolves: pnpmCs,
      nextResolves: pnpmCn,
      oneLockfile: pnpmOneLockfile,
      repointConsumerManifestsEdited: pnpmManifestsEdited, // counted over BOTH consumers
      cohortMovedTo: pnpmCsAfter,
    },
  },
  workspaceInCatalog: {
    bun: {
      accepts: bunWsInstall.code === 0,
      linkedLocal: bunWsResolved.out.trim() === "LOCAL-UTIL",
    },
    pnpm: {
      rejectsEveryForm: pnpmWsFormsRejected === PNPM_WS_FORMS.length,
      formsTested: PNPM_WS_FORMS,
      formsRejected: pnpmWsFormsRejected,
      error: "ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC",
    },
  },
  publishBakesConcrete: {
    bun: {
      sourceCore: bunBake.sourceCore,
      sourceDep: bunBake.sourceDep,
      tarballCore: bunBake.core,
      tarballDep: bunBake.dep,
    },
    pnpm: {
      sourceCore: pnpmBake.sourceCore,
      sourceDep: pnpmBake.sourceDep,
      tarballCore: pnpmBake.core,
      tarballDep: pnpmBake.dep,
    },
    implication:
      "a consumer catalog cannot repoint a baked range inside a dependent lib's tarball; a universal " +
      "lib re-exported through every other lib advances by republishing its dependents.",
  },
  bunIgnoresPnpmCatalog: {
    resolved: bunPnpmCatResolved,
    diagnostic: bunPnpmCatDiag ? `${DEP}@catalog: failed to resolve` : null,
  },
  reproduced: true,
};
mkdirSync(join(process.cwd(), "bench"), { recursive: true });
writeFileSync(
  join(process.cwd(), "bench/wave-rollout-bench.json"),
  JSON.stringify(result, null, 2),
);
console.log("\n--- bench/wave-rollout-bench.json written (all rungs reproduced) ---");

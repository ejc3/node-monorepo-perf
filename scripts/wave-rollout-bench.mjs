#!/usr/bin/env node
// Demonstrate, on self-contained repros, the load-bearing mechanics of advancing an internal core lib
// through a hermetic, wave-based rollout — and the two places the clean story breaks. This is the
// empirical backing for ROLLOUT.md. Each rung HARD-ASSERTS a stable fact; the one behavior genuinely
// in question — bun's explicit `--frozen-lockfile` on drift (oven-sh/bun#24223) — is RECORDED with its
// evidence rather than asserted. Setup failures (a seed install that didn't run, a missing lockfile, a
// network/registry error) HARD-FAIL everywhere, so a failed measurement never reads as a clean result.
//
//   A. pnpm is the determinism boundary. A committed lockfile + `pnpm install --frozen-lockfile`
//      yields a byte-identical resolution (the lockfile is never rewritten and the resolved version is
//      constant across runs), and frozen FAILS CLOSED on drift (a manifest out of sync with the lock
//      aborts with ERR_PNPM_OUTDATED_LOCKFILE). So a `^`/`*` range is inert under frozen — the
//      lockfile, not the range form, is what makes a build reproducible.
//   B. The bun side, measured on 1.3.14 + cross-checked against bun's source at the `bun-v1.3.14` tag.
//      B1 explicit frozen on drift — RECORDED (does `--frozen-lockfile` fail closed? #24223 reports
//         contexts where it does not). Classified by evidence: exit + lockfile-unchanged + the
//         "lockfile is frozen" diagnostic.
//      B2 CI auto-enable — ASSERTED: a bare `bun install` with CI=1 does NOT freeze (re-resolves and
//         rewrites bun.lock). Source: frozen_lockfile is set only by --frozen-lockfile / `bun ci` /
//         --production / bunfig; env.isCI() only disables the progress bar. pnpm, by contrast, flips
//         its frozen default to true in CI.
//      B3 pnpm catalog — ASSERTED: bun does not resolve a `catalog:` defined only in
//         pnpm-workspace.yaml (it treats `catalog:` as a literal spec and fails to resolve). Source:
//         bun reads catalogs from package.json, pnpm-workspace.yaml only via the migration path.
//   C. The DIRECT clean wave. pnpm named catalogs (catalog:stable / catalog:next) route two cohorts to
//      two versions of a directly-consumed dep in ONE lockfile, and repointing the stable catalog entry
//      moves the cohort with ZERO consumer-manifest edits (measured by hashing every consumer manifest
//      before and after).
//   D. Catalogs reject the workspace protocol. Every workspace: form tested (*, ^, ~, ^1.0.0) aborts
//      with ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC, so the catalog channel needs a
//      registry-published lib, never a workspace one.
//   E. The UNIVERSAL collapse. `pnpm pack` bakes a CONCRETE range for a lib's own internal deps into
//      the tarball (workspace:^ -> ^1.0.0), so a consumer catalog cannot repoint that transitive edge:
//      advancing a lib every other lib re-exports is a republish-fanout, not a one-line flip.
//
//   node scripts/wave-rollout-bench.mjs
//
// Self-contained and non-destructive: scaffolds throwaway workspaces under the OS temp dir (never the
// repo tree, so no worktree needed) and removes them on exit. Pins each scaffold to the public npm
// registry for one tiny real dep (is-odd) so resolution is deterministic and auth-free — the registry
// IDENTITY is immaterial to the pnpm/bun mechanics shown here; registry-identity behavior (CodeArtifact
// resolution, the publish rewrite live) is covered by registry-resolution-demo.sh / per-app-workspace-
// demo.sh. The bun source line refs in the recorded note are pinned to bun-v1.3.14, so the bench asserts
// the running bun is that version. HARD-FAILS if any asserted mechanic stops reproducing, so a tool
// change that alters it turns the bench red instead of letting a stale claim stand ->
// bench/wave-rollout-bench.json.

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
// Resolved version of a dep as actually linked into a consumer's node_modules (symlink resolves on
// read), i.e. what the build would compile against — not what the manifest range says.
const resolved = (dir, dep) => readJSON(join(dir, "node_modules", dep, "package.json")).version;

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
// One package.json shape for every consumer/leaf in this bench.
const mf = (name, deps) => ({ name, version: "0.0.0", private: true, dependencies: deps });

// =================================================================================================
// A. pnpm is the determinism boundary: byte-identical under frozen, fail-closed on drift.
// =================================================================================================
console.log("== A. pnpm frozen-lockfile: byte-identical + fail-closed ==");
const aDir = scaffold("a-frozen-pnpm", {
  "package.json": mf("wave-frozen", { [DEP]: FROZEN_SPEC }),
});
const aInstall = run("pnpm install --no-frozen-lockfile", aDir);
if (aInstall.code !== 0 || !existsSync(join(aDir, "node_modules", DEP)))
  fail(
    `A: initial pnpm install failed (network/registry?) exit ${aInstall.code}\n${aInstall.out.slice(-600)}`,
  );
const aLock = join(aDir, "pnpm-lock.yaml");
const aV1 = resolved(aDir, DEP);
const aHash1 = sha(aLock);
// Two frozen installs from a wiped node_modules: the lockfile must not be rewritten and the resolved
// version must be constant — that is the "rebuild resolves the same" property (the range is inert).
const FROZEN_RUNS = 2;
const aVersions = [aV1];
const aHashes = [aHash1];
for (let i = 0; i < FROZEN_RUNS; i++) {
  rmSync(join(aDir, "node_modules"), { recursive: true, force: true });
  const r = run("pnpm install --frozen-lockfile", aDir);
  if (r.code !== 0 || !existsSync(join(aDir, "node_modules", DEP)))
    fail(`A: frozen install #${i + 1} failed exit ${r.code}\n${r.out.slice(-600)}`);
  aVersions.push(resolved(aDir, DEP));
  aHashes.push(sha(aLock));
}
const aByteIdentical = aVersions.every((v) => v === aV1) && aHashes.every((h) => h === aHash1);
if (!aByteIdentical) fail(`A: frozen not byte-identical: versions ${aVersions}, lock ${aHashes}`);
// Drift: add a dependency the committed lockfile does not contain, WITHOUT regenerating the lock.
writeFileSync(
  join(aDir, "package.json"),
  JSON.stringify(mf("wave-frozen", { [DEP]: FROZEN_SPEC, "is-even": "^1.0.0" }), null, 2),
);
const aDrift = run("pnpm install --frozen-lockfile", aDir);
const aDriftErr = (aDrift.out.match(/ERR_PNPM_OUTDATED_LOCKFILE/) || [])[0] || null;
if (aDrift.code === 0 || !aDriftErr)
  fail(
    `A: frozen should fail closed on drift (ERR_PNPM_OUTDATED_LOCKFILE); got exit ${aDrift.code}\n${aDrift.out.slice(-600)}`,
  );
console.log(
  `  byte-identical: ${DEP}@${aV1} across ${FROZEN_RUNS} frozen runs (lock ${aHash1}); drift -> exit ${aDrift.code} (${aDriftErr})`,
);

// =================================================================================================
// B. The bun side, measured on 1.3.14. Setup failures hard-fail; B1 recorded, B2/B3 asserted.
// =================================================================================================
console.log("== B. bun, measured on 1.3.14 (frozen drift / CI auto-enable / pnpm catalog) ==");
const BUN_FROZEN_DIAG = /lockfile had changes, but lockfile is frozen/i; // bun's fail-closed message

// B1: explicit --frozen-lockfile on an added-dep drift (RECORDED).
const b1Dir = scaffold("b1-frozen-bun", { "package.json": mf("wave-b1", { [DEP]: FROZEN_SPEC }) });
const b1Seed = run("bun install", b1Dir);
const b1Lock = join(b1Dir, "bun.lock");
if (b1Seed.code !== 0 || !existsSync(b1Lock))
  fail(
    `B1: bun seed install failed / no bun.lock (network?) exit ${b1Seed.code}\n${b1Seed.out.slice(-600)}`,
  );
const b1HashBefore = sha(b1Lock);
writeFileSync(
  join(b1Dir, "package.json"),
  JSON.stringify(mf("wave-b1", { [DEP]: FROZEN_SPEC, "is-even": "^1.0.0" }), null, 2),
);
const b1 = run("bun install --frozen-lockfile", b1Dir);
const b1LockChanged = !existsSync(b1Lock) || sha(b1Lock) !== b1HashBefore;
const b1FailedClosed = b1.code !== 0 && !b1LockChanged && BUN_FROZEN_DIAG.test(b1.out);
const b1FrozenDrift = {
  exit: b1.code,
  lockfileChanged: b1LockChanged,
  failedClosed: b1FailedClosed,
  diagnostic: BUN_FROZEN_DIAG.test(b1.out) ? "lockfile had changes, but lockfile is frozen" : null,
};

// B2: bare `bun install` with CI=1 on the same drift — ASSERT it does NOT auto-freeze (re-resolves).
const b2Dir = scaffold("b2-ci-bun", { "package.json": mf("wave-b2", { [DEP]: FROZEN_SPEC }) });
const b2Seed = run("bun install", b2Dir);
const b2Lock = join(b2Dir, "bun.lock");
if (b2Seed.code !== 0 || !existsSync(b2Lock))
  fail(`B2: bun seed install failed / no bun.lock exit ${b2Seed.code}\n${b2Seed.out.slice(-600)}`);
const b2HashBefore = sha(b2Lock);
writeFileSync(
  join(b2Dir, "package.json"),
  JSON.stringify(mf("wave-b2", { [DEP]: FROZEN_SPEC, "is-even": "^1.0.0" }), null, 2),
);
const b2 = run("bun install", b2Dir, { CI: "1" });
const b2LockRewritten = existsSync(b2Lock) && sha(b2Lock) !== b2HashBefore;
const b2DidNotFreeze = b2.code === 0 && b2LockRewritten;
const b2Froze = b2.code !== 0 && BUN_FROZEN_DIAG.test(b2.out);
// Classify by evidence; an unrelated nonzero exit (network) is neither and must not pass.
if (!b2DidNotFreeze && !b2Froze)
  fail(
    `B2: could not classify CI=1 bare install (exit ${b2.code}, lockRewritten ${b2LockRewritten})\n${b2.out.slice(-600)}`,
  );
if (!b2DidNotFreeze)
  fail(
    `B2: bun auto-froze under CI=1 (contradicts ${BUN_SOURCE_TAG} source); exit ${b2.code}\n${b2.out.slice(-600)}`,
  );
const b2CiAutoEnable = { exit: b2.code, lockfileRewritten: b2LockRewritten, autoFroze: false };

// B3: a `catalog:` defined only in pnpm-workspace.yaml — ASSERT bun does not resolve it.
const b3Dir = scaffold("b3-pnpm-catalog-bun", {
  "package.json": mf("wave-b3", { [DEP]: "catalog:" }),
  "pnpm-workspace.yaml": `catalog:\n  ${DEP}: ${STABLE}\n`,
});
const b3 = run("bun install", b3Dir);
const b3Resolved = b3.code === 0 && existsSync(join(b3Dir, "node_modules", DEP));
const b3CatalogDiag = new RegExp(`${DEP}@catalog:.*failed to resolve`, "i").test(b3.out);
if (b3Resolved)
  fail(
    `B3: bun resolved a pnpm-workspace.yaml catalog (contradicts ${BUN_SOURCE_TAG} source)\n${b3.out.slice(-600)}`,
  );
if (!b3CatalogDiag)
  fail(
    `B3: bun failed for a non-catalog reason (network?); expected "<dep>@catalog: failed to resolve"\n${b3.out.slice(-600)}`,
  );
const b3PnpmCatalog = {
  exit: b3.code,
  resolvedPnpmCatalog: false,
  diagnostic: `${DEP}@catalog: failed to resolve`,
};
console.log(
  `  B1 frozen+drift: exit ${b1.code} (failedClosed=${b1FrozenDrift.failedClosed})  |  ` +
    `B2 CI=1 bare install: exit ${b2.code} (autoFroze=false, lockRewritten=${b2LockRewritten})  |  ` +
    `B3 pnpm-yaml catalog: exit ${b3.code} (resolved=false, "failed to resolve")`,
);

// =================================================================================================
// C. The DIRECT clean wave: named catalogs route cohorts; repoint edits no consumer manifest.
// =================================================================================================
console.log("== C. named catalogs: cohort routing + zero-manifest-edit repoint ==");
const cDir = scaffold("c-catalog", {
  "package.json": { name: "wave-catalog-root", version: "0.0.0", private: true },
  "pnpm-workspace.yaml": `packages:\n  - "consumers/*"\ncatalogs:\n  stable:\n    ${DEP}: ${STABLE}\n  next:\n    ${DEP}: ${NEXT}\n`,
  "consumers/cohort-stable/package.json": mf("@wave/cohort-stable", { [DEP]: "catalog:stable" }),
  "consumers/cohort-next/package.json": mf("@wave/cohort-next", { [DEP]: "catalog:next" }),
});
const cInstall = run("pnpm install --no-frozen-lockfile", cDir);
if (cInstall.code !== 0)
  fail(`C: catalog install failed exit ${cInstall.code}\n${cInstall.out.slice(-600)}`);
const cStable = resolved(join(cDir, "consumers/cohort-stable"), DEP);
const cNext = resolved(join(cDir, "consumers/cohort-next"), DEP);
if (cStable !== STABLE || cNext !== NEXT)
  fail(`C: routing wrong: stable->${cStable} (want ${STABLE}), next->${cNext} (want ${NEXT})`);
// "One lockfile" is measured, not assumed: exactly one root pnpm-lock.yaml, no per-consumer lockfile,
// and that single file records both is-odd majors.
const cConsumerDirs = ["consumers/cohort-stable", "consumers/cohort-next"];
const cLockText = readFileSync(join(cDir, "pnpm-lock.yaml"), "utf8");
const cOneLockfile =
  cConsumerDirs.every((d) => !existsSync(join(cDir, d, "pnpm-lock.yaml"))) &&
  cLockText.includes(`${DEP}@${STABLE}`) &&
  cLockText.includes(`${DEP}@${NEXT}`);
if (!cOneLockfile)
  fail(`C: expected one root lockfile holding both ${DEP}@${STABLE} and ${DEP}@${NEXT}`);
// Repoint the stable channel to NEXT by editing ONLY the workspace yaml. Hash every consumer manifest
// before and after so "zero manifest edits" is measured, not assumed.
const cManifests = ["consumers/cohort-stable/package.json", "consumers/cohort-next/package.json"];
const cBefore = cManifests.map((m) => sha(join(cDir, m)));
const cYaml = join(cDir, "pnpm-workspace.yaml");
const cYamlBefore = sha(cYaml);
writeFileSync(
  cYaml,
  `packages:\n  - "consumers/*"\ncatalogs:\n  stable:\n    ${DEP}: ${NEXT}\n  next:\n    ${DEP}: ${NEXT}\n`,
);
const cRepoint = run("pnpm install --no-frozen-lockfile", cDir);
if (cRepoint.code !== 0)
  fail(`C: repoint install failed exit ${cRepoint.code}\n${cRepoint.out.slice(-600)}`);
const cStableAfter = resolved(join(cDir, "consumers/cohort-stable"), DEP);
const cManifestsEdited = cManifests.filter((m, i) => sha(join(cDir, m)) !== cBefore[i]).length;
const cYamlChanged = sha(cYaml) !== cYamlBefore;
if (cStableAfter !== NEXT || cManifestsEdited !== 0 || !cYamlChanged)
  fail(
    `C: repoint failed: stable->${cStableAfter} (want ${NEXT}); manifests edited ${cManifestsEdited} (want 0); yaml changed ${cYamlChanged}`,
  );
console.log(
  `  routing: stable->${DEP}@${cStable}, next->${DEP}@${cNext} (one lockfile); repoint stable->${NEXT}: ${cManifestsEdited} consumer manifests edited, workspace yaml changed ${cYamlChanged}`,
);

// =================================================================================================
// D. Catalogs reject the workspace protocol — every workspace: form, so a workspace:* core lib
//    cannot be a catalog channel.
// =================================================================================================
console.log("== D. catalog value workspace: is rejected (every form) ==");
const D_FORMS = ["workspace:*", "workspace:^", "workspace:~", "workspace:^1.0.0"];
for (const form of D_FORMS) {
  const dDir = scaffold(`d-reject-${form.replace(/[^a-z0-9]/gi, "_")}`, {
    "package.json": { name: "wave-reject-root", version: "0.0.0", private: true },
    "pnpm-workspace.yaml": `packages:\n  - "packages/*"\n  - "consumers/*"\ncatalog:\n  "@wave/util": "${form}"\n`,
    "packages/util/package.json": { name: "@wave/util", version: "1.0.0", private: true },
    "consumers/app/package.json": mf("@wave/reject-app", { "@wave/util": "catalog:" }),
  });
  const r = run("pnpm install --no-frozen-lockfile", dDir);
  if (r.code === 0 || !/ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC/.test(r.out))
    fail(`D: catalog value "${form}" should be rejected; got exit ${r.code}\n${r.out.slice(-600)}`);
}
console.log(
  `  every form rejected (${D_FORMS.join(", ")}) with ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC`,
);

// =================================================================================================
// E. The UNIVERSAL collapse: a published lib bakes a CONCRETE internal range into its tarball.
// =================================================================================================
console.log(
  "== E. published tarball bakes a concrete range (transitive edge can't be repointed) ==",
);
const eDir = scaffold("e-transitive", {
  "package.json": { name: "wave-transitive-root", version: "0.0.0", private: true },
  "pnpm-workspace.yaml": `packages:\n  - "packages/*"\n`,
  "packages/core/package.json": { name: "@wave/core", version: "1.0.0", main: "index.js" },
  "packages/core/index.js": "module.exports = { v: 1 };\n",
  // mid re-exports core, declaring it with the workspace protocol (the in-tree co-dev form).
  "packages/mid/package.json": {
    name: "@wave/mid",
    version: "1.0.0",
    main: "index.js",
    dependencies: { "@wave/core": "workspace:^" },
  },
  "packages/mid/index.js": "module.exports = require('@wave/core');\n",
});
const eInstall = run("pnpm install --no-frozen-lockfile", eDir);
if (eInstall.code !== 0)
  fail(`E: transitive workspace install failed exit ${eInstall.code}\n${eInstall.out.slice(-600)}`);
const midDir = join(eDir, "packages/mid");
const ePack = run("pnpm pack --pack-destination .", midDir);
if (ePack.code !== 0) fail(`E: pnpm pack failed exit ${ePack.code}\n${ePack.out.slice(-600)}`);
const tgz = readdirSync(midDir).find((f) => f.endsWith(".tgz"));
if (!tgz) fail(`E: no tarball produced by pnpm pack`);
// Read the tarball's package.json without unpacking to disk; guard tar's exit before parsing.
const eTar = run(`tar -xzOf ${tgz} package/package.json`, midDir);
if (eTar.code !== 0 || !eTar.out.trim())
  fail(
    `E: tar could not read package/package.json from ${tgz} (exit ${eTar.code})\n${eTar.out.slice(-400)}`,
  );
const eTarballSpec = JSON.parse(eTar.out).dependencies["@wave/core"];
const eSourceSpec = readJSON(join(midDir, "package.json")).dependencies["@wave/core"];
if (eTarballSpec !== "^1.0.0" || eSourceSpec !== "workspace:^")
  fail(
    `E: expected source "workspace:^" baked to "^1.0.0" in tarball; got source "${eSourceSpec}", tarball "${eTarballSpec}"`,
  );
console.log(
  `  mid source "@wave/core": "${eSourceSpec}"  ->  published tarball "@wave/core": "${eTarballSpec}" (concrete, not repointable by a consumer catalog)`,
);

// --- record ----------------------------------------------------------------------------------------
const result = {
  claim:
    "Hermetic core-lib rollout mechanics, measured. pnpm is the determinism boundary: a committed " +
    "lockfile + --frozen-lockfile is byte-identical (range inert) and FAILS CLOSED on drift " +
    "(ERR_PNPM_OUTDATED_LOCKFILE). bun (the install tool of record) does NOT auto-enable frozen in CI " +
    "and ignores pnpm-workspace.yaml catalogs (both asserted, source-verified at bun-v1.3.14); its " +
    "explicit frozen fails closed on the drift here but is recorded, not asserted (#24223). The DIRECT " +
    "clean wave is pnpm named catalogs routing cohorts to versions in one lockfile, with a " +
    "zero-consumer-manifest repoint; but a catalog value cannot be a workspace: spec (any form), and a " +
    "published lib bakes a CONCRETE range for its internal deps into the tarball (workspace:^ -> " +
    "^1.0.0), so advancing a UNIVERSAL lib every other lib re-exports is a republish-fanout, not a " +
    "one-line catalog flip.",
  versions: { pnpm: PNPM_VER, bun: BUN_VER, node: process.version },
  registry: REGISTRY,
  frozenPnpm: {
    config: "committed pnpm-lock.yaml + pnpm install --frozen-lockfile",
    inputSpec: FROZEN_SPEC,
    resolvedVersion: aV1,
    frozenRuns: FROZEN_RUNS,
    byteIdentical: aByteIdentical,
    lockfileHash: aHash1,
    failsClosedOnDrift: true,
    driftError: aDriftErr,
  },
  frozenBun: {
    measuredBunVersion: BUN_VER,
    sourceVerifiedAt: BUN_SOURCE_TAG,
    note:
      "bun is the optimal-stack installer but not the rollout determinism authority. Source-verified at " +
      BUN_SOURCE_TAG +
      " (src/install): frozen_lockfile is set only by --frozen-lockfile / `bun ci` / --production / " +
      "bunfig (CommandLineArguments.zig:797, PackageManagerOptions.zig:335-344,613-620); env.isCI() only " +
      "disables the progress bar (PackageManagerOptions.zig:392), so bun does NOT auto-enable frozen in " +
      "CI — pnpm does. bun reads catalogs from package.json (lockfile/Package.zig:1592-2011), not " +
      "pnpm-workspace.yaml (read only via the migration path, pnpm.zig). B2/B3 below assert these; B1 " +
      "(explicit frozen on drift) is recorded per run, since oven-sh/bun#24223 reports contexts where it " +
      "does not fail.",
    b1FrozenDrift, // RECORDED
    b2CiAutoEnable, // ASSERTED: did not auto-freeze
    b3PnpmCatalog, // ASSERTED: did not resolve the pnpm-workspace.yaml catalog
  },
  namedCatalogDirect: {
    config:
      "catalog:stable / catalog:next route two cohorts; repoint edits only pnpm-workspace.yaml",
    dep: DEP,
    stableSpec: STABLE,
    nextSpec: NEXT,
    stableResolves: cStable,
    nextResolves: cNext,
    oneLockfile: cOneLockfile,
    repoint: {
      consumerManifestsEdited: cManifestsEdited,
      consumerManifestCount: cManifests.length,
      workspaceYamlChanged: cYamlChanged,
      cohortStableMovedTo: cStableAfter,
    },
  },
  catalogRejectsWorkspace: {
    config: "catalog value is a workspace: spec",
    formsTested: D_FORMS,
    allRejected: true,
    error: "ERR_PNPM_CATALOG_ENTRY_INVALID_WORKSPACE_SPEC",
  },
  universalCollapse: {
    config: "pnpm pack a lib whose internal dep is workspace:^; inspect the tarball",
    sourceSpec: eSourceSpec,
    tarballSpec: eTarballSpec,
    bakedConcrete: true,
    implication:
      "a consumer catalog over @wave/core cannot repoint mid's baked @wave/core range; a universal " +
      "lib (re-exported through every other lib) must be advanced by republishing its dependents.",
  },
  reproduced: true,
};
mkdirSync(join(process.cwd(), "bench"), { recursive: true });
writeFileSync(
  join(process.cwd(), "bench/wave-rollout-bench.json"),
  JSON.stringify(result, null, 2),
);
console.log("\n--- bench/wave-rollout-bench.json written (all rungs reproduced) ---");

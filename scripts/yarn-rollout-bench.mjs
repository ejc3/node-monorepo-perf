#!/usr/bin/env node
// Vets yarn 4 as a wave-rollout driver on the same five rungs wave-rollout-bench measures
// for bun and pnpm (ROLLOUT.md), on self-contained temp scaffolds pinned to public npm for
// one tiny real dep. Behaviors are MEASURED and recorded; each rung HARD-ASSERTS only its
// measurement validity (the install ran, the scaffold built) — the recorded booleans are
// the findings, and the summary claim is derived from them so it cannot contradict the
// data in the same file.
//
//   node scripts/yarn-rollout-bench.mjs
//
// The five rungs, yarn 4.17.0 (pinned standalone CLI):
//   1  Determinism — the lockfile, not the range, is the boundary: a committed lockfile
//      resolves byte-identically across fresh installs; `--immutable` FAILS CLOSED on a
//      drifted manifest (exit 1, lockfile untouched); and — unlike bun, which needs a
//      committed bunfig line — yarn AUTO-ENABLES immutable installs in CI (a bare
//      `CI=true yarn install` on drift fails closed with no config at all).
//   2  Named-catalog lanes — `catalog:stable` / `catalog:next` route two cohorts to two
//      versions in one lockfile (catalogs live in .yarnrc.yml); a repoint edits 0
//      consumer manifests.
//   3  `workspace:` as a catalog value — accepted or rejected, and if accepted whether
//      it links the local package (bun accepts; pnpm rejects every form).
//   4  Publish bakes a CONCRETE range — `yarn pack` rewrites `workspace:^` AND
//      `catalog:` to real ranges/versions in the packed manifest.
//   5  Cross-tool — yarn does not read pnpm-workspace.yaml catalogs or bun's
//      package.json catalogs; yarn catalogs are authored in .yarnrc.yml.
//
// Self-contained: scaffolds under the OS temp dir, removed on exit; needs no worktree;
// touches no turbo state. Network: registry.npmjs.org for is-odd/left-pad only.

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { YARN_VERSION } from "./_pins.mjs";
import { yarnEnv, fetchYarnCli, yarnRcLines } from "./_pm-bench-lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = mkdtempSync(join(tmpdir(), "yarn-rollout-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};
const YARNJS = fetchYarnCli(ROOT, YARN_VERSION);

// run yarn under the scrubbed env (ambient YARN_* would override the scaffold's rc);
// `extra` adds env for the specific probe (e.g. CI=true)
const CI_DETECTION_VARS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "TF_BUILD",
  "JENKINS_URL",
  "APPVEYOR",
  "DRONE",
  "CODEBUILD_BUILD_ID",
  "BUILD_NUMBER",
  "RUN_ID",
  "TEAMCITY_VERSION",
];
function yarn(args, cwd, extra) {
  // yarn's immutable-in-CI default keys off ci-info; ci-info's isCI is gated on
  // env.CI !== "false", so CI="false" neutralizes detection even for vendor vars the
  // list misses — the CI probe overrides with CI="true" explicitly
  const env = yarnEnv(extra);
  for (const k of CI_DETECTION_VARS) if (!(extra && k in extra)) delete env[k];
  if (!(extra && "CI" in extra)) env.CI = "false";
  const r = spawnSync("node", [YARNJS, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 26,
    timeout: 300000,
    env,
  });
  if (r.error) fail(`yarn ${args.join(" ")}: ${r.error.code || r.error.message}`);
  // a signal-killed child has status null — that is a harness fault, never a measured
  // behavior (null !== 0 would otherwise read as a fail-closed PASS)
  if (r.signal || r.status === null)
    fail(`yarn ${args.join(" ")} killed by ${r.signal || "unknown signal"} — not a measurement`);
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const write = (base, files) => {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(base, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
};
// the shared knob list (_pm-bench-lib) with enableImmutableInstalls left UNPINNED —
// rung 1 measures yarn's own CI default, which an rc pin would mask; rungs 2-5 re-add
// the pin via extraLines
const rc = (extraLines = []) =>
  [...yarnRcLines("node-modules", { pinImmutable: false, extraLines }), ""].join("\n");
const scaffold = (name, files) => {
  const base = join(ROOT, name);
  write(base, files);
  return base;
};
const rmState = (dir) => {
  spawnSync("bash", ["-c", "find . -name node_modules -type d -prune -exec rm -rf {} +"], {
    cwd: dir,
  });
  rmSync(join(dir, ".yarn"), { recursive: true, force: true });
};

const result = { yarn: YARN_VERSION, rungs: {} };

// ---- 1. determinism -------------------------------------------------------------------------------
console.log(
  "== 1. determinism: byte-identical lockfile; --immutable and CI fail closed on drift ==",
);
{
  const dir = scaffold("determinism", {
    "package.json": { name: "det", private: true, workspaces: ["pkgs/*"] },
    ".yarnrc.yml": rc(),
    "pkgs/app/package.json": {
      name: "app",
      version: "0.0.0",
      dependencies: { "is-odd": "^3.0.0" },
    },
  });
  let r = yarn(["install"], dir);
  if (r.code !== 0) fail(`determinism seed install failed:\n${r.out.slice(-400)}`);
  const lock1 = sha(join(dir, "yarn.lock"));
  rmSync(join(dir, "yarn.lock"));
  rmState(dir);
  // the second resolve runs against a FRESH global folder (cache + metadata re-fetched
  // from the registry), so byte-identity is two independent resolves, not one resolve
  // replayed from a warm cache
  const freshGlobal = join(ROOT, "det-global2");
  r = yarn(["install"], dir, { YARN_GLOBAL_FOLDER: freshGlobal });
  if (r.code !== 0) fail(`determinism second install failed:\n${r.out.slice(-400)}`);
  const freshCache = join(freshGlobal, "cache");
  if (
    !existsSync(freshCache) ||
    readdirSync(freshCache).filter((f) => f.endsWith(".zip")).length === 0
  )
    fail(
      "second resolve did not populate its fresh global folder with package zips — YARN_GLOBAL_FOLDER not honored, the resolve was not independent",
    );
  const byteIdentical = sha(join(dir, "yarn.lock")) === lock1;

  // drift the manifest, then measure both fail-closed paths
  const mf = JSON.parse(readFileSync(join(dir, "pkgs/app/package.json"), "utf8"));
  mf.dependencies["left-pad"] = "1.3.0";
  writeFileSync(join(dir, "pkgs/app/package.json"), JSON.stringify(mf, null, 2));
  const h0 = sha(join(dir, "yarn.lock"));
  // fail-closed requires yarn's own immutable-violation marker (YN0028, "lockfile would
  // have been modified") — a registry outage also exits 1 with the lock untouched and
  // must not read as the immutable behavior
  const yn0028 = (out) => /YN0028/.test(out);
  const imm = yarn(["install", "--immutable"], dir);
  const immFailsClosed = imm.code !== 0 && sha(join(dir, "yarn.lock")) === h0 && yn0028(imm.out);
  const ci = yarn(["install"], dir, { CI: "true" });
  const ciFailsClosed = ci.code !== 0 && sha(join(dir, "yarn.lock")) === h0 && yn0028(ci.out);
  const yn0028Line = (out) =>
    out
      .split("\n")
      .find((l) => /YN0028/.test(l))
      ?.slice(0, 200) || null;
  result.rungs.determinism = {
    lockfileByteIdenticalAcrossFreshResolves: byteIdentical,
    immutableFailsClosedOnDrift: immFailsClosed,
    immutableExit: imm.code,
    immutableErrorSample: yn0028Line(imm.out),
    ciBareInstallFailsClosedOnDrift: ciFailsClosed,
    ciBareExit: ci.code,
    ciErrorSample: yn0028Line(ci.out),
    note: "enableImmutableInstalls is deliberately NOT pinned in this scaffold's rc — the CI row measures yarn's own default (immutable auto-enabled under CI), the behavior bun only gets from a committed bunfig line and pnpm gets from its CI auto-frozen default",
  };
  console.log(
    `  byte-identical=${byteIdentical}; --immutable on drift exit=${imm.code} (fail-closed=${immFailsClosed}); CI bare install exit=${ci.code} (fail-closed=${ciFailsClosed})`,
  );
}

// ---- 2. named-catalog lanes -----------------------------------------------------------------------
console.log("== 2. named catalogs: two cohorts, two versions, one lockfile; 0-manifest repoint ==");
{
  const dir = scaffold("catalogs", {
    "package.json": { name: "cat", private: true, workspaces: ["pkgs/*"] },
    ".yarnrc.yml": rc([
      "enableImmutableInstalls: false",
      "catalogs:",
      "  stable:",
      '    is-odd: "1.0.0"',
      "  next:",
      '    is-odd: "3.0.1"',
    ]),
    "pkgs/cs/package.json": {
      name: "cs",
      version: "0.0.0",
      dependencies: { "is-odd": "catalog:stable" },
    },
    "pkgs/cn/package.json": {
      name: "cn",
      version: "0.0.0",
      dependencies: { "is-odd": "catalog:next" },
    },
  });
  const r = yarn(["install"], dir);
  if (r.code !== 0) fail(`catalog install failed:\n${r.out.slice(-400)}`);
  // resolve with Node's own walk-up from the consumer dir — the hoisted layout places
  // the single-version copy at the ROOT node_modules and only the conflicting one
  // per-package, so a fixed per-package path would miss one cohort
  const ver = (pkg) => {
    const p = spawnSync(
      "node",
      ["-e", 'process.stdout.write(require("is-odd/package.json").version)'],
      { cwd: join(dir, "pkgs", pkg), encoding: "utf8", env: yarnEnv({ NODE_PATH: "" }) },
    );
    if (p.status !== 0) fail(`is-odd did not resolve from pkgs/${pkg}`);
    return p.stdout.trim();
  };
  const stableV = ver("cs");
  const nextV = ver("cn");
  // repoint: stable -> 3.0.1, editing ONLY the rc
  const before = [sha(join(dir, "pkgs/cs/package.json")), sha(join(dir, "pkgs/cn/package.json"))];
  writeFileSync(
    join(dir, ".yarnrc.yml"),
    rc([
      "enableImmutableInstalls: false",
      "catalogs:",
      "  stable:",
      '    is-odd: "3.0.1"',
      "  next:",
      '    is-odd: "3.0.1"',
    ]),
  );
  const r2 = yarn(["install"], dir);
  if (r2.code !== 0) fail(`catalog repoint install failed:\n${r2.out.slice(-400)}`);
  const manifestsEdited = [
    sha(join(dir, "pkgs/cs/package.json")),
    sha(join(dir, "pkgs/cn/package.json")),
  ].filter((h, i) => h !== before[i]).length;
  result.rungs.namedCatalogs = {
    twoCohortsTwoVersions: stableV === "1.0.0" && nextV === "3.0.1",
    stableResolved: stableV,
    nextResolved: nextV,
    repointResolved: ver("cs"),
    repointEffective: ver("cs") === "3.0.1",
    consumerManifestsEditedOnRepoint: manifestsEdited,
    authoredIn: ".yarnrc.yml (catalogs:)",
  };
  console.log(
    `  cs->${stableV} cn->${nextV}; repoint cs->${ver("cs")} (manifests edited ${manifestsEdited}/2)`,
  );
}

// ---- 3. workspace: as a catalog value --------------------------------------------------------------
console.log("== 3. workspace: as a catalog value ==");
{
  const dir = scaffold("wscat", {
    "package.json": { name: "wscat", private: true, workspaces: ["pkgs/*"] },
    ".yarnrc.yml": rc([
      "enableImmutableInstalls: false",
      "catalogs:",
      "  ws:",
      '    util: "workspace:*"',
    ]),
    "pkgs/util/package.json": { name: "util", version: "1.0.0" },
    "pkgs/app/package.json": {
      name: "app",
      version: "0.0.0",
      dependencies: { util: "catalog:ws" },
    },
  });
  const r = yarn(["install"], dir);
  const accepted = r.code === 0;
  let linksLocal = false;
  if (accepted) {
    const probe = spawnSync(
      "node",
      ["-e", 'process.stdout.write(require.resolve("util/package.json"))'],
      { cwd: join(dir, "pkgs", "app"), encoding: "utf8", env: yarnEnv({ NODE_PATH: "" }) },
    );
    if (probe.status !== 0)
      fail(`workspace-catalog probe could not resolve util after an accepted install`);
    linksLocal = (probe.stdout || "").includes(join("pkgs", "util"));
  }
  result.rungs.workspaceAsCatalogValue = {
    accepted,
    linksLocalPackage: linksLocal,
    errorSample: accepted ? null : r.out.slice(-300),
  };
  console.log(`  accepted=${accepted}; links local=${linksLocal}`);
}

// ---- 4. publish bakes a concrete range -------------------------------------------------------------
console.log("== 4. yarn pack: workspace:^ and catalog: baked to concrete ranges ==");
{
  const dir = scaffold("pack", {
    "package.json": { name: "pack", private: true, workspaces: ["pkgs/*"] },
    ".yarnrc.yml": rc(["enableImmutableInstalls: false", "catalog:", '  is-odd: "3.0.1"']),
    "pkgs/core/package.json": {
      name: "core",
      version: "2.5.0",
      dependencies: { util: "workspace:^", "is-odd": "catalog:" },
    },
    "pkgs/util/package.json": { name: "util", version: "1.2.0" },
  });
  let r = yarn(["install"], dir);
  if (r.code !== 0) fail(`pack scaffold install failed:\n${r.out.slice(-400)}`);
  const tgz = join(ROOT, "core.tgz");
  r = yarn(["pack", "--out", tgz], join(dir, "pkgs", "core"));
  if (r.code !== 0) fail(`yarn pack failed:\n${r.out.slice(-400)}`);
  const packed = spawnSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" });
  if (packed.status !== 0) fail("could not read packed manifest");
  const deps = JSON.parse(packed.stdout).dependencies || {};
  result.rungs.publishBakesConcrete = {
    workspaceCaret: deps.util,
    catalogDep: deps["is-odd"],
    bothConcrete: deps.util === "^1.2.0" && deps["is-odd"] === "3.0.1",
  };
  console.log(`  packed deps: util "${deps.util}", is-odd "${deps["is-odd"]}"`);
}

// ---- 5. cross-tool: yarn reads only its own catalog homes ------------------------------------------
console.log("== 5. cross-tool: pnpm-workspace.yaml / bun package.json catalogs are not read ==");
{
  // a pnpm-style catalog in pnpm-workspace.yaml and a bun-style catalog in package.json,
  // with NO yarn catalog — if yarn read either, the install would resolve; it must fail
  const dir = scaffold("crosstool", {
    "package.json": {
      name: "cross",
      private: true,
      workspaces: { packages: ["pkgs/*"], catalog: { "is-odd": "3.0.1" } },
    },
    "pnpm-workspace.yaml": 'packages:\n  - "pkgs/*"\ncatalog:\n  is-odd: 3.0.1\n',
    ".yarnrc.yml": rc(["enableImmutableInstalls: false"]),
    "pkgs/app/package.json": {
      name: "app",
      version: "0.0.0",
      dependencies: { "is-odd": "catalog:" },
    },
  });
  const r = yarn(["install"], dir);
  // the "reads neither" conclusion requires yarn's catalog-unresolvable error (YN0082);
  // any other failure (network, registry) leaves the question open — null, not false
  const catalogUnresolvable = r.code !== 0 && /YN0082/.test(r.out);
  result.rungs.crossTool = {
    readsPnpmWorkspaceYamlCatalog: catalogUnresolvable ? false : null,
    readsBunPackageJsonCatalog: catalogUnresolvable ? false : null,
    installExitWithForeignCatalogsOnly: r.code,
    resolvedDespiteNoYarnCatalog: r.code === 0,
    errorSample: r.code === 0 ? null : r.out.slice(-260),
  };
  if (r.code === 0) {
    // if it resolved, one of the foreign homes WAS read — record which is unknown, flag it
    result.rungs.crossTool.readsPnpmWorkspaceYamlCatalog = null;
    result.rungs.crossTool.readsBunPackageJsonCatalog = null;
  }
  console.log(
    `  install with only pnpm/bun catalog homes present: exit=${r.code} (${r.code === 0 ? "RESOLVED — a foreign catalog was read" : "failed as expected — yarn catalogs live in .yarnrc.yml"})`,
  );
}

// ---- summary claim, derived clause-by-clause from the measured booleans ----------------------------
// every clause is conditional on its own rung's booleans, so a future yarn that drops a
// behavior (e.g. the CI auto-immutable default) yields a claim that says so — the JSON
// can never carry a claim its own rung data disproves
const R = result.rungs;
const D = R.determinism;
const X = R.crossTool;
const allNative =
  D.immutableFailsClosedOnDrift &&
  D.ciBareInstallFailsClosedOnDrift &&
  D.lockfileByteIdenticalAcrossFreshResolves &&
  R.namedCatalogs.twoCohortsTwoVersions &&
  R.namedCatalogs.repointEffective &&
  R.namedCatalogs.consumerManifestsEditedOnRepoint === 0 &&
  R.workspaceAsCatalogValue.accepted &&
  R.workspaceAsCatalogValue.linksLocalPackage &&
  R.publishBakesConcrete.bothConcrete &&
  X.readsPnpmWorkspaceYamlCatalog === false &&
  X.readsBunPackageJsonCatalog === false;
const wsCat = R.workspaceAsCatalogValue.accepted
  ? R.workspaceAsCatalogValue.linksLocalPackage
    ? "ACCEPTED (links the local package, like bun; pnpm rejects it)"
    : "ACCEPTED but the local package did not link"
  : "REJECTED (like pnpm)";
const ciClause = D.ciBareInstallFailsClosedOnDrift
  ? `and CI auto-enables immutable with no config (bare CI install exit ${D.ciBareExit}) — the ` +
    `default bun gets only from a committed bunfig line`
  : `but a bare CI install did NOT fail closed on drift (exit ${D.ciBareExit})`;
const crossClause =
  X.readsPnpmWorkspaceYamlCatalog === false && X.readsBunPackageJsonCatalog === false
    ? "yarn does not read pnpm-workspace.yaml or bun package.json catalogs — author them in .yarnrc.yml"
    : "foreign-catalog isolation was NOT confirmed this run (see crossTool rung)";
result.claim =
  `yarn ${YARN_VERSION} runs the rollout mechanics ` +
  (allNative ? "natively" : "only partially (see rungs)") +
  `: byte-identical lockfile resolves (${D.lockfileByteIdenticalAcrossFreshResolves}); ` +
  `--immutable ${D.immutableFailsClosedOnDrift ? "fails closed" : "did NOT fail closed"} on drift ` +
  `(exit ${D.immutableExit}, lock ${D.immutableFailsClosedOnDrift ? "untouched" : "state in rung"}) ` +
  ciClause +
  `; named catalogs in .yarnrc.yml ` +
  (R.namedCatalogs.twoCohortsTwoVersions && R.namedCatalogs.repointEffective
    ? `route two cohorts to two versions and a repoint edits ` +
      `${R.namedCatalogs.consumerManifestsEditedOnRepoint} consumer manifests`
    : `did NOT route/repoint the two cohorts as expected (see namedCatalogs rung)`) +
  `; workspace: as a catalog ` +
  `value is ${wsCat}; yarn pack ${R.publishBakesConcrete.bothConcrete ? "bakes" : "did NOT bake"} ` +
  `workspace:^ -> "${R.publishBakesConcrete.workspaceCaret}" ` +
  `and catalog: -> "${R.publishBakesConcrete.catalogDep}"; ` +
  crossClause +
  `.`;

writeFileSync(
  join(REPO, "bench", "yarn-rollout-bench.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log("\n--- bench/yarn-rollout-bench.json written ---");
console.log(result.claim);

#!/usr/bin/env node
// What Scriptc 0.4.0 says of the engine before its rewrites and after (ROUTE-PLANNER.md), written
// to bench/route-planner-scriptc.json: for each, `scriptc coverage --tier static-only` (statements
// analyzed and compiled statically, and the exit status with --fail-on blockers) and
// `scriptc build --lib` (its exit status and the error count it reports). Tool behavior, no
// timing: the same on any machine with the same Scriptc and sources.
//
//   ROUTE_ROOT=<dir> node scripts/route-planner/scriptc-check.mjs
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, root } from "./lib.mjs";
import { PRE_SCRIPTC, variant } from "./variants.mjs";

const V = join(root(), "variants");
const VERSION = "0.4.0";
const SCRIPTC = join(process.env.SCRIPTC_HOME || join(process.env.HOME, ".cache", `scriptc-${VERSION}`), "bin", "scriptc");
if (!existsSync(SCRIPTC)) {
  console.error(`${SCRIPTC} is missing: route-planner/native/build.sh fetches Scriptc ${VERSION}`);
  process.exit(2);
}
const version = spawnSync(SCRIPTC, ["--version"], { encoding: "utf8" }).stdout.trim();
if (version !== VERSION) throw new Error(`expected Scriptc ${VERSION}, found ${version}`);

function check(name, edits) {
  const dir = variant(V, name, edits);
  const cwd = join(dir, "native");
  // the record names no directory of the machine's: paths relative to the variant
  const run = (args) => {
    const r = spawnSync(SCRIPTC, args, { cwd, encoding: "utf8" });
    return { status: r.status, text: ((r.stdout || "") + (r.stderr || "")).split(`${dir}/`).join("") };
  };
  const cov = run(["coverage", "engine-lib.ts", "--tier", "static-only", "--fail-on", "blockers"]);
  if (cov.status !== 0 && cov.status !== 1) throw new Error(`${name}: scriptc coverage exited ${cov.status}`);
  const build = run(["build", "--lib", "--profile", "profile.json", "-o", join(dir, "check.a")]);
  const num = (re, text) => {
    const v = Number(re.exec(text)?.[1] ?? NaN);
    if (!Number.isInteger(v)) throw new Error(`${name}: no count for ${re} in Scriptc's output`);
    return v;
  };
  return {
    coverage: {
      statements: num(/statements analyzed\s+(\d+)/, cov.text),
      static: num(/compile statically\s+(\d+)/, cov.text),
      exitStatus: cov.status,
      output: cov.text.trim().split("\n").map((l) => l.trimEnd()),
    },
    build: {
      exitStatus: build.status,
      errors: build.status === 0 ? 0 : num(/^(\d+) errors?\.$/m, build.text),
      errorCodes: [...build.text.matchAll(/\b(SC\d{4})\b/g)].map((m) => m[1]).sort(),
    },
  };
}

const record = {
  generator: "scripts/route-planner/scriptc-check.mjs",
  scriptc: version,
  before: check("pre-scriptc", PRE_SCRIPTC),
  now: check("now", []),
};
if (record.now.build.exitStatus !== 0 || record.now.coverage.static !== record.now.coverage.statements)
  throw new Error("the engine as committed does not compile with Scriptc");
const OUT = join(REPO, "bench", "route-planner-scriptc.json");
writeFileSync(OUT, JSON.stringify(record, null, 2) + "\n");
console.log(`wrote ${OUT}: before ${record.before.coverage.static}/${record.before.coverage.statements} static, build exit ${record.before.build.exitStatus} with ${record.before.build.errors} errors`);

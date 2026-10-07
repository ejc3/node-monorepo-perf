#!/usr/bin/env node
// Build a candidate native binding from a next.js worktree.
//
//   node scripts/turbopack-gym/build.mjs <name> [--from <ref>] [--patch <file>]...
//
// Creates (or reuses) worktree $GYM_ROOT/worktrees/<name> on branch gym/cand/<name>,
// starting at --from (default gym/incumbent), applies each --patch, and builds
// next-napi-bindings with the gym profile (release, no LTO, 16 codegen units: within
// a few percent of the shipped binary at a fraction of the link time). A new target
// dir is seeded as a btrfs reflink copy of the base target, so registry crates are
// not rebuilt. The binding lands in $GYM_ROOT/bindings/<name>/.
//
// An agent can also edit the worktree directly and re-run this command; it rebuilds
// whatever is in the worktree.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BINDINGS,
  BINDING_FILE,
  BUILD_CPUS,
  NEXTJS,
  ROOT,
  TARGETS,
  WORKTREES,
  ensureDir,
  parseArgs,
  sh,
} from "./lib.mjs";

export const CARGO_ENV = {
  CARGO_PROFILE_RELEASE_LTO: "false",
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
};
export const FEATURES = "image-extended,tracing/release_max_level_trace";

export function worktreeFor(name) {
  return name === "base" ? NEXTJS : join(WORKTREES, name);
}

export function build(name, { from = "gym/incumbent", patches = [], jobs } = {}) {
  const wt = worktreeFor(name);
  if (!existsSync(wt)) {
    ensureDir(WORKTREES);
    sh("git", ["-C", NEXTJS, "worktree", "add", "-q", "-B", `gym/cand/${name}`, wt, from]);
  }
  for (const p of patches) sh("git", ["-C", wt, "apply", "--3way", resolve(p)]);

  const target = join(TARGETS, name);
  if (!existsSync(target) && existsSync(join(TARGETS, "base"))) {
    sh("cp", ["-a", "--reflink=always", join(TARGETS, "base"), target]);
  }
  const log = join(ensureDir(join(ROOT, "logs")), `build-${name}.log`);
  const t0 = Date.now();
  const r = spawnSync(
    "bash",
    [
      "-c",
      `taskset -c ${BUILD_CPUS} cargo build -p next-napi-bindings --release --features ${FEATURES} ${jobs ? `-j ${jobs}` : ""} > ${log} 2>&1`,
    ],
    { cwd: wt, env: { ...process.env, ...CARGO_ENV, CARGO_TARGET_DIR: target }, stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error(`cargo build failed for ${name}; see ${log}`);
  const out = ensureDir(join(BINDINGS, name));
  copyFileSync(join(target, "release", "libnext_napi_bindings.so"), join(out, BINDING_FILE));
  const head = sh("git", ["-C", wt, "rev-parse", "HEAD"]).trim();
  const diff = sh("git", ["-C", wt, "diff", "gym/base"]);
  writeFileSync(
    join(out, "source.json"),
    JSON.stringify(
      { name, head, built: new Date().toISOString(), seconds: (Date.now() - t0) / 1000 },
      null,
      1,
    ),
  );
  writeFileSync(join(out, "candidate.diff"), diff);
  return { name, seconds: (Date.now() - t0) / 1000, binding: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2), { from: 1, patch: "list", jobs: 1 });
  if (!a._[0]) throw new Error("usage: build.mjs <name> [--from ref] [--patch file]...");
  console.log(
    JSON.stringify(build(a._[0], { from: a.from, patches: a.patch || [], jobs: a.jobs })),
  );
}

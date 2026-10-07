#!/usr/bin/env node
// Build a candidate native binding from a next.js worktree.
//
//   node scripts/turbopack-gym/build.mjs <name> [--from <ref>] [--patch <file>]...
//
// Creates worktree $GYM_ROOT/worktrees/<name> on branch gym/cand/<name> at --from
// (default gym/incumbent) and applies each --patch once, at creation; an existing
// worktree is rebuilt as it stands (an agent edits it and re-runs this command), and
// must contain --from if one is given. Builds next-napi-bindings with --release, LTO off
// and 16 codegen units (the same settings for every binding the gym compares), cargo
// pinned to GYM_BUILD_CPUS under their CPU locks. A new target dir is seeded from the
// base target (a reflink copy where the filesystem supports it). The binding, its
// diff against gym/base and source.json land in $GYM_ROOT/bindings/<name>/, swapped in
// whole.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  withCpus,
} from "./lib.mjs";

export const CARGO_ENV = {
  CARGO_PROFILE_RELEASE_LTO: "false",
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
};
export const FEATURES = "image-extended,tracing/release_max_level_trace";

export function worktreeFor(name) {
  return name === "base" ? NEXTJS : join(WORKTREES, name);
}

export async function build(name, { from, patches = [], jobs } = {}) {
  const wt = worktreeFor(name);
  if (!existsSync(wt)) {
    ensureDir(WORKTREES);
    sh("git", [
      "-C",
      NEXTJS,
      "worktree",
      "add",
      "-q",
      "-B",
      `gym/cand/${name}`,
      wt,
      from || "gym/incumbent",
    ]);
    for (const p of patches) sh("git", ["-C", wt, "apply", "--3way", resolve(p)]);
  } else {
    if (patches.length)
      throw new Error(`worktree ${wt} exists: its patches were applied when it was created`);
    if (from) {
      try {
        sh("git", ["-C", wt, "merge-base", "--is-ancestor", from, "HEAD"]);
      } catch {
        throw new Error(`worktree ${wt} exists and does not contain ${from}`);
      }
    }
  }

  const target = join(TARGETS, name);
  if (!existsSync(target) && existsSync(join(TARGETS, "base"))) {
    sh("cp", ["-a", "--reflink=auto", join(TARGETS, "base"), target]);
  }
  const log = join(ensureDir(join(ROOT, "logs")), `build-${name}.log`);
  const t0 = Date.now();
  await withCpus(BUILD_CPUS, async () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        `taskset -c ${BUILD_CPUS} cargo build -p next-napi-bindings --release --features ${FEATURES} ${jobs ? `-j ${jobs}` : ""} > ${log} 2>&1`,
      ],
      {
        cwd: wt,
        env: { ...process.env, ...CARGO_ENV, CARGO_TARGET_DIR: target },
        stdio: "inherit",
      },
    );
    if (r.status !== 0) throw new Error(`cargo build failed for ${name}; see ${log}`);
  });
  // assemble the new binding directory beside the old one, then swap it in
  const out = join(BINDINGS, name);
  const tmp = ensureDir(`${out}.tmp-${process.pid}`);
  copyFileSync(join(target, "release", "libnext_napi_bindings.so"), join(tmp, BINDING_FILE));
  writeFileSync(join(tmp, "candidate.diff"), sh("git", ["-C", wt, "diff", "gym/base"]));
  writeFileSync(
    join(tmp, "source.json"),
    JSON.stringify(
      {
        name,
        head: sh("git", ["-C", wt, "rev-parse", "HEAD"]).trim(),
        base: sh("git", ["-C", wt, "rev-parse", "gym/base"]).trim(),
        built: new Date().toISOString(),
        cargo: CARGO_ENV,
        seconds: (Date.now() - t0) / 1000,
      },
      null,
      1,
    ),
  );
  const old = `${out}.old-${process.pid}`;
  if (existsSync(out)) renameSync(out, old);
  renameSync(tmp, out);
  rmSync(old, { recursive: true, force: true });
  return { name, seconds: (Date.now() - t0) / 1000, binding: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = parseArgs(process.argv.slice(2), { from: 1, patch: "list", jobs: 1 });
  if (!a._[0]) throw new Error("usage: build.mjs <name> [--from ref] [--patch file]...");
  console.log(
    JSON.stringify(await build(a._[0], { from: a.from, patches: a.patch || [], jobs: a.jobs })),
  );
}

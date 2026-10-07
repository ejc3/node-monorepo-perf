#!/usr/bin/env node
// Re-measure the records TURBOPACK-GRAPH.md cites, from the tracked patches:
//
//   1. build the bindings named in bench/turbopack-gym/bindings.json, each from
//      gym/base (v16.4.0) plus its patches, in a fresh worktree;
//   2. run the A/B rows one at a time on one lane pair (A and B concurrently on its two
//      lanes, lanes and launch order swapped every rep);
//   3. run the scaling sweep (one build at a time, base and 15+22 interleaved, 3 reps);
//   4. write bench/turbopack-graph-ab.json and bench/turbopack-graph-scaling.json.
//
//   GYM_ROOT=/scratch node scripts/turbopack-gym/canonical.mjs [--host bigbox] [--lanes 0-23:24-47]
//   make gym-canonical GYM_HOST=bigbox
//
// --only ab|scaling|record runs one step (after the bindings).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "./build.mjs";
import { BINDINGS, BINDING_FILE, REPO, WORKTREES, parseArgs } from "./lib.mjs";

const a = parseArgs(process.argv.slice(2), { host: 1, lanes: 1, only: 1, reps: 1 });
const hostArgs = a.host ? ["--host", a.host] : [];
const LANES = a.lanes || "0-23:24-47";
const REPS = a.reps || "6";

const BINDING_MAP = JSON.parse(
  readFileSync(join(REPO, "bench", "turbopack-gym", "bindings.json"), "utf8"),
);
const AB_ROWS = [
  { label: "aa", b: "base" },
  { label: "11", b: "11" },
  { label: "15", b: "15" },
  { label: "22", b: "22" },
  { label: "15+22", b: "15+22" },
  { label: "workers-16", b: "base", env: "TURBO_TASKS_AVAILABLE_PARALLELISM=16" },
  { label: "evict-8g", b: "base", env: "TURBO_ENGINE_EVICT_MIN_BYTES=8589934592" },
  { label: "no-fs-cache", b: "base", env: "MONOLITH_TP_FS_CACHE=0" },
];

function node(script, args) {
  const r = spawnSync("node", [join(REPO, "scripts", "turbopack-gym", script), ...args], {
    cwd: REPO,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0 && !(script === "ab.mjs" && r.status === 1))
    throw new Error(`${script} ${args.join(" ")} failed (${r.status})`);
}

// 1. bindings from the patches (a binding that exists must have been built from them)
for (const [name, { patches, diffSha256 }] of Object.entries(BINDING_MAP)) {
  if (name === "base") continue;
  if (!existsSync(join(BINDINGS, name, BINDING_FILE))) {
    if (existsSync(join(WORKTREES, name)))
      throw new Error(`worktree ${name} exists without a binding: remove it or build it`);
    await build(name, {
      from: "gym/base",
      patches: patches.map((p) => join(REPO, "bench", "turbopack-gym", "candidates", p)),
    });
  }
  const { createHash } = await import("node:crypto");
  const got = createHash("sha256")
    .update(readFileSync(join(BINDINGS, name, "candidate.diff")))
    .digest("hex")
    .slice(0, 16);
  if (got !== diffSha256)
    throw new Error(`binding ${name}: diff ${got} is not bindings.json's ${diffSha256}`);
}

if (!a.only || a.only === "ab")
  for (const row of AB_ROWS)
    node("ab.mjs", [
      "--a",
      "base",
      "--b",
      row.b,
      ...(row.env ? ["--b-env", row.env] : []),
      "--label",
      row.label,
      "--lanes",
      LANES,
      "--reps",
      REPS,
      ...hostArgs,
    ]);

if (!a.only || a.only === "scaling")
  node("scaling.mjs", ["--binding", "base,15+22", "--reps", "3", ...hostArgs]);

if (!a.only || a.only === "record") {
  node("record.mjs", ["ab", "--labels", AB_ROWS.map((r) => r.label).join(","), ...hostArgs]);
  node("record.mjs", ["scaling", ...hostArgs]);
}

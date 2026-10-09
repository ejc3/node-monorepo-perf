#!/usr/bin/env node
// Re-measure the records TURBOPACK-GRAPH.md cites, from the tracked patches:
//
//   0. set up the apps (and the base binding on a host) as the generator gives them now;
//   1. build the bindings named in bench/turbopack-gym/bindings.json, each from
//      gym/base (v16.4.0) plus its patches, in a fresh worktree;
//   2. run the A/B rows one at a time on one lane pair (A and B concurrently on its two
//      lanes; lanes swap every rep, launch order every two reps);
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
import { resolveBinding } from "./bindings.mjs";
import { BINDINGS, REPO, WORKTREES, parseArgs } from "./lib.mjs";

const a = parseArgs(process.argv.slice(2), { host: 1, lanes: 1, only: 1, reps: 1, tag: 1 });
const hostArgs = a.host ? ["--host", a.host] : [];
const LANES = a.lanes || "0-23:24-47";
const REPS = a.reps || "6";
// every A/B and the sweep of this canonical run carry its tag; the records take only
// rows with it (--only record --tag <tag> to re-record one run)
const TAG = a.tag || `canonical-${new Date().toISOString().replace(/[:.]/g, "-")}`;
console.error(`[canonical] tag ${TAG}`);

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

// ab.mjs exits 0 (win) or 1 (no win) after a measurement; anything else is an error
function node(script, args, okCodes = [0]) {
  const r = spawnSync("node", [join(REPO, "scripts", "turbopack-gym", script), ...args], {
    cwd: REPO,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (!okCodes.includes(r.status))
    throw new Error(`${script} ${args.join(" ")} failed (${r.status})`);
}

// 0. the apps (and on a host, the base binding) are what the generator and tag give now
if (!a.only) {
  node("setup.mjs", ["--no-fp"]);
  if (a.host) node("setup.mjs", ["--host", a.host]);
}

// 1. bindings built from gym/base plus their patches, each verified against bindings.json
for (const [name, { patches, head, diffSha256 }] of Object.entries(BINDING_MAP)) {
  if (name !== "base" && !existsSync(join(BINDINGS, name))) {
    if (existsSync(join(WORKTREES, name)))
      throw new Error(`worktree ${name} exists without a binding: remove it or build it`);
    await build(name, {
      from: "gym/base",
      patches: patches.map((p) => join(REPO, "bench", "turbopack-gym", "candidates", p)),
    });
  }
  const { source } = resolveBinding(name);
  if (source.head !== head || source.diffSha256 !== diffSha256)
    throw new Error(
      `binding ${name} (head ${source.head}, diff ${source.diffSha256}) is not bindings.json's (${head}, ${diffSha256})`,
    );
}

if (!a.only || a.only === "ab")
  for (const row of AB_ROWS)
    node(
      "ab.mjs",
      [
        "--a",
        "base",
        "--b",
        row.b,
        ...(row.env ? ["--b-env", row.env] : []),
        "--label",
        row.label,
        "--tag",
        TAG,
        "--lanes",
        LANES,
        "--reps",
        REPS,
        ...hostArgs,
      ],
      [0, 1],
    );

if (!a.only || a.only === "scaling")
  node("scaling.mjs", ["--binding", "base,15+22", "--reps", "3", "--tag", TAG, ...hostArgs]);

if (!a.only || a.only === "record") {
  node("record.mjs", [
    "ab",
    "--labels",
    AB_ROWS.map((r) => r.label).join(","),
    "--tag",
    TAG,
    ...hostArgs,
  ]);
  node("record.mjs", ["scaling", "--tag", TAG, ...hostArgs]);
}

#!/usr/bin/env node
// Self-tests for the gym's own correctness; exits non-zero on a failure.
//
//   node scripts/turbopack-gym/selftest.mjs            # CPU locks (no builds; seconds)
//   node scripts/turbopack-gym/selftest.mjs --builds   # + output fingerprint on the quick app
//
// locks:   24 processes x 3 rounds contend for overlapping CPU sets; no two holds of a
//          shared CPU may overlap in time and every hold must complete. A lock left by
//          a dead process is reclaimed; a live owner's lock is respected.
// record:  record.mjs publishes a consistent synthetic A/B and refuses a tampered
//          verdict, a run of other binding code, and a run of another app tree.
// builds:  two builds of the quick app with the base binding have the same normalized
//          fingerprint; a copy of the app with one numeric constant changed (same
//          length) does not.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPS, parseArgs } from "./lib.mjs";

const a = parseArgs(process.argv.slice(2), { builds: "bool", child: 1, out: 1 });
const LIB = new URL("./lib.mjs", import.meta.url).pathname;

// worker mode: hold CPU sets and log [cpus, t0, t1]
if (a.child) {
  const lib = await import(LIB);
  const { appendFileSync } = await import("node:fs");
  const choices = [["0-1:2-3"], ["2-3:4-5"], ["4-5:6-7"], ["0-3:4-7"], ["1-1:6-6"]];
  for (let i = 0; i < 6; i++) {
    const c = choices[(process.pid + i) % choices.length];
    await lib.withCpus(c, async (got) => {
      const t0 = performance.timeOrigin + performance.now();
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
      const t1 = performance.timeOrigin + performance.now();
      appendFileSync(a.out, JSON.stringify({ cpus: lib.expandCpus(got), t0, t1 }) + "\n");
    });
  }
  process.exit(0);
}

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed++;
};

// --- locks ------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), "gym-selftest-"));
const env = { ...process.env, GYM_LOCKS: join(scratch, "locks") };
const log = join(scratch, "holds.jsonl");
for (let round = 0; round < 3; round++) {
  await Promise.all(
    Array.from(
      { length: 24 },
      () =>
        new Promise((res, rej) =>
          spawn("node", [new URL(import.meta.url).pathname, "--child", "1", "--out", log], {
            env,
            stdio: ["ignore", "ignore", "inherit"],
          }).on("close", (code) =>
            code === 0 ? res() : rej(new Error(`lock worker exited ${code}`)),
          ),
        ),
    ),
  );
}
const holds = readFileSync(log, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
let overlaps = 0;
for (let i = 0; i < holds.length; i++)
  for (let j = i + 1; j < holds.length; j++) {
    const [x, y] = [holds[i], holds[j]];
    if (x.cpus.some((c) => y.cpus.includes(c)) && x.t0 < y.t1 && y.t0 < x.t1) overlaps++;
  }
check(holds.length === 3 * 24 * 6, `all ${3 * 24 * 6} lock holds completed (${holds.length})`);
check(overlaps === 0, `no overlapping holds of a shared CPU (${overlaps})`);

process.env.GYM_LOCKS = env.GYM_LOCKS;
const lib = await import(`${LIB}?selftest`);
for (const [cpu, pid] of [
  [5, 999999999],
  [6, 1],
]) {
  const dir = join(env.GYM_LOCKS, `cpu-${cpu}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pid"), String(pid));
}
let reclaimed = false;
await lib.withCpus("5-5", async () => (reclaimed = true));
check(reclaimed, "a lock whose owner is gone is reclaimed");
let stole = false;
await Promise.race([
  lib.withCpus("6-6", async () => (stole = true)),
  new Promise((r) => setTimeout(r, 3000)),
]);
check(!stole, "a lock whose owner is alive is respected");
rmSync(scratch, { recursive: true, force: true });

// --- record verification ------------------------------------------------------------
// record.mjs on synthetic runs: a consistent A/B publishes; a log whose verdict
// disagrees with its reps, a run of other binding code, and a run of another app tree
// are each refused.
{
  const { appTreeHash } = await import("./bench.mjs");
  const root = mkdtempSync(join(tmpdir(), "gym-selftest-record-"));
  const appDir = join(root, "apps", "quick");
  // (a monolith app too: the record names both)
  mkdirSync(join(root, "apps", "monolith"), { recursive: true });
  writeFileSync(
    join(root, "apps", "monolith", "monolith.json"),
    JSON.stringify({ out: "x", files: 1 }),
  );
  mkdirSync(join(appDir, "app"), { recursive: true });
  writeFileSync(join(appDir, "monolith.json"), JSON.stringify({ out: "x", files: 1 }));
  writeFileSync(join(appDir, "app", "page.tsx"), "export default () => null;\n");
  const appHash = appTreeHash(appDir);
  const machine = {
    arch: "arm64",
    cpuModel: "test",
    cores: 2,
    numaNodes: 1,
    memGiB: 1,
    instanceType: null,
    node: "v0",
    sharedBox: false,
    buildNode: "v0",
  };
  const phase = (s) => ({ s, at: 0, cores: 1, sysShare: 0 });
  const run = (id, graph, over = {}) => ({
    id,
    label: "",
    binding: "base",
    cpus: "0-0",
    ncpu: 1,
    env: {},
    app: "quick",
    appHash,
    when: new Date().toISOString(),
    wall: 30,
    cores: 1,
    memPeakGiB: 1,
    graph: phase(graph),
    entrypoints: phase(15),
    emit: phase(5),
    turbopack: phase(20),
    persistence: null,
    output: { files: 1, sha: "s", exactSha: "e" },
    machine,
    bindingSource: { head: null, diffSha256: "e3b0c44298fc1c14", nodeSha256: "n" },
    ...over,
  });
  const attempt = (logOver, runOver = {}) => {
    rmSync(join(root, "runs"), { recursive: true, force: true });
    mkdirSync(join(root, "results"), { recursive: true });
    const runs = [run("r1", 10), run("r2", 8, runOver), run("r3", 10), run("r4", 8)];
    for (const r of runs) {
      mkdirSync(join(root, "runs", r.id), { recursive: true });
      writeFileSync(join(root, "runs", r.id, "run.json"), JSON.stringify(r));
    }
    const log = {
      label: "t",
      when: new Date().toISOString(),
      a: { binding: "base", env: {} },
      b: { binding: "base", env: {} },
      app: "quick",
      lanes: ["0-0", "1-1"],
      metric: "graph",
      guardMetric: "turbopack",
      threshold: 0.04,
      guard: 0.02,
      ratio: 0.8,
      win: false,
      runs: [
        ["r1", "r2"],
        ["r3", "r4"],
      ],
      host: "local",
      ...logOver,
    };
    writeFileSync(join(root, "results", "ab.jsonl"), JSON.stringify(log) + "\n");
    const r = spawnSync(
      "node",
      [
        process.env.GYM_SELFTEST_RECORD || new URL("./record.mjs", import.meta.url).pathname,
        "ab",
        "--labels",
        "t",
        "--out",
        join(root, "out.json"),
      ],
      {
        env: { ...process.env, GYM_ROOT: root, GYM_RESULTS: join(root, "results") },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    if (process.env.GYM_SELFTEST_VERBOSE) process.stderr.write(r.stderr);
    return r.status;
  };
  // guard x1.0 < 1.02 and same output, ratio 0.8 < 0.96, swaps < 1: a win
  check(attempt({ win: true }) === 0, "record publishes a consistent A/B");
  check(
    attempt({ win: true, ratio: 0.7 }) !== 0,
    "record refuses a log whose ratio disagrees with its reps",
  );
  check(
    attempt({ win: true }, { bindingSource: { diffSha256: "0000000000000000" } }) !== 0,
    "record refuses a run of other binding code",
  );
  check(
    attempt({ win: true }, { appHash: "0000000000000000" }) !== 0,
    "record refuses a run of another app tree",
  );
  rmSync(root, { recursive: true, force: true });
}

// --- output fingerprint ------------------------------------------------------------
if (a.builds) {
  const { bench } = await import("./bench.mjs");
  const quick = join(APPS, "quick");
  const [x, y] = await Promise.all([
    bench({ binding: "base", cpus: "0-15", app: quick, label: "selftest-a" }),
    bench({ binding: "base", cpus: "16-31", app: quick, label: "selftest-b" }),
  ]);
  check(x.output.sha === y.output.sha, `same binding, same normalized output (${x.output.sha})`);
  const copy = join(APPS, "quick-selftest");
  rmSync(copy, { recursive: true, force: true });
  cpSync(quick, copy, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (p) => !p.includes("/.next"),
  });
  const f = join(copy, "src", "features", "f40", "m05.ts");
  const src = readFileSync(f, "utf8");
  // same length, so a size-only comparison cannot see it
  writeFileSync(
    f,
    src.replace(
      /let acc = (\d+);/,
      (_, d) => `let acc = ${(d[0] === "9" ? "1" : "9").repeat(d.length)};`,
    ),
  );
  try {
    const z = await bench({
      binding: "base",
      cpus: "0-15",
      app: copy,
      label: "selftest-perturbed",
    });
    check(
      src !== readFileSync(f, "utf8") && z.output.sha !== x.output.sha,
      "one changed constant changes the normalized output",
    );
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

process.exit(failed ? 1 : 0);

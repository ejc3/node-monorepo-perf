#!/usr/bin/env node
// Self-tests for the gym's own correctness; exits non-zero on a failure.
//
//   node scripts/turbopack-gym/selftest.mjs            # CPU locks (no builds; seconds)
//   node scripts/turbopack-gym/selftest.mjs --builds   # + output fingerprint on the quick app
//
// locks:   24 processes x 3 rounds contend for overlapping CPU sets; no two holds of a
//          shared CPU may overlap in time and every hold must complete. CPUs held by a
//          live process stay taken; a holder killed with SIGKILL frees them.
// record:  record.mjs publishes a consistent synthetic A/B and refuses a tampered
//          verdict, a run of other binding code, and a run of another app tree.
// drift:   drift.mjs's edits land in N distinct modules, an interrupted sweep's journal
//          restores the tree (bytes and timestamps), and an edited tree is refused;
//          drift.mjs record refuses a run whose log line does not fit it or its plan.
// builds:  8 builds of the quick app with the base binding (4 lanes x 2 rounds, under
//          CPU locks) have one normalized fingerprint; a copy of the app with one
//          numeric constant changed (same length) does not. route-stats.mjs on a kept
//          build: candidate 60 writes the build's own stats file, and a patch that
//          changes the stats is refused. A run sent SIGTERM mid-build stops its build
//          scope, exits non-zero and frees its CPUs.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
// a holder process keeps CPUs 5-6; while it lives they stay taken, once it is killed
// (SIGKILL: no cleanup runs) the kernel drops its locks
const holder = spawn(
  "node",
  [
    "--input-type=module",
    "-e",
    `const l = await import(${JSON.stringify(LIB)}); await l.withCpus("5-6", async () => { console.log("HELD"); await new Promise(() => {}); });`,
  ],
  { env, stdio: ["ignore", "pipe", "inherit"] },
);
await new Promise((r) => holder.stdout.on("data", (d) => String(d).includes("HELD") && r()));
let stole = false;
await Promise.race([
  lib.withCpus("6-6", async () => (stole = true)),
  new Promise((r) => setTimeout(r, 3000)),
]);
check(!stole, "a CPU held by a live process is not taken");
holder.kill("SIGKILL");
await new Promise((r) => holder.on("close", r));
let reclaimed = false;
await Promise.race([
  lib.withCpus("5-6", async () => (reclaimed = true)),
  new Promise((r) => setTimeout(r, 5000)),
]);
check(reclaimed, "a killed holder's CPUs are free again");
rmSync(scratch, { recursive: true, force: true });

// --- record verification ------------------------------------------------------------
// record.mjs on synthetic runs: a consistent A/B publishes; a log whose verdict
// disagrees with its reps, a repeated run, a rep on the wrong lane, a run of other
// binding code, and a run of another app tree are each refused.
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
    boot: "b",
  };
  const baseHead = JSON.parse(
    readFileSync(new URL("../../bench/turbopack-gym/bindings.json", import.meta.url), "utf8"),
  ).base.head;
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
    bindingSource: { head: baseHead, diffSha256: "e3b0c44298fc1c14", nodeSha256: "n" },
    ...over,
  });
  const attempt = (logOver, runOver = {}) => {
    rmSync(join(root, "runs"), { recursive: true, force: true });
    mkdirSync(join(root, "results"), { recursive: true });
    // lanes swap every rep: rep 0 A on 0-0, B on 1-1; rep 1 the other way round
    const runs = [
      run("r1", 10),
      run("r2", 8, { cpus: "1-1", ...runOver }),
      run("r3", 10, { cpus: "1-1" }),
      run("r4", 8),
    ];
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
    attempt({
      win: true,
      runs: [
        ["r1", "r2"],
        ["r1", "r2"],
      ],
    }) !== 0,
    "record refuses an A/B that repeats a run",
  );
  check(attempt({ win: true }, { cpus: "0-0" }) !== 0, "record refuses a rep on the wrong lane");
  check(
    attempt(
      { win: true },
      { bindingSource: { head: baseHead, diffSha256: "0000000000000000", nodeSha256: "n" } },
    ) !== 0,
    "record refuses a run of other binding code",
  );
  check(
    attempt({ win: true }, { appHash: "0000000000000000" }) !== 0,
    "record refuses a run of another app tree",
  );
  rmSync(root, { recursive: true, force: true });
}

// --- drift edits ------------------------------------------------------------------
// drift.mjs edits an app's source between builds: the edits land where it says, an
// interrupted sweep's journal restores the tree byte for byte (timestamps too), and an
// edited tree is refused as a starting point.
{
  const { ROOT } = await import(LIB);
  const drift = await import(new URL("./drift.mjs", import.meta.url).pathname);
  const { appTreeHash } = await import(new URL("./bench.mjs", import.meta.url).pathname);
  const base = mkdtempSync(join(ROOT, "tmp-selftest-drift-"));
  const appName = `selftest-drift-${process.pid}`;
  const app = join(base, appName);
  try {
    execFileSync(
      "node",
      [
        new URL("../monolith-gen.mjs", import.meta.url).pathname,
        "--out",
        app,
        "--routes",
        "30",
        "--features",
        "12",
        "--ui",
        "10",
        "--utils",
        "20",
      ],
      { stdio: "ignore" },
    );
    const pristine = appTreeHash(app);
    const n = 30; // more than the 12 features: the picks wrap to other module slots
    const targets = drift.editTargets(app, n);
    const mtimes = () => targets.map((t) => String(statSync(t.path, { bigint: true }).mtimeNs));
    const before = mtimes();
    check(new Set(targets.map((t) => t.path)).size === n, "drift picks N distinct modules");
    drift.applyEdits(app, appName, targets, "import");
    const texts = targets.map((t) => readFileSync(t.path, "utf8"));
    check(
      texts.every((x) => x.includes('-drift"') && x.split("_drift_fn }").length === 2),
      "each picked module gets the label mark and one new import",
    );
    check(appTreeHash(app) !== pristine, "the edits change the tree hash");
    let refused = false;
    try {
      drift.checkPristine(app);
    } catch {
      refused = true;
    }
    check(refused, "an edited tree is refused as a starting point");
    // the sweep was interrupted here: the next one restores from the journal
    check(drift.restoreJournal(appName) === n, "the journal restores every edited file");
    check(appTreeHash(app) === pristine, "the restored tree hashes as before the edits");
    check(
      JSON.stringify(mtimes()) === JSON.stringify(before),
      "restored files keep their nanosecond timestamps",
    );
    check(drift.restoreJournal(appName) === 0, "a restored journal is gone");
    drift.checkPristine(app);
    // 14 modules per feature: the pick order's stride of 7 revisits slots, so N picks over
    // the 12 features cannot all differ; drift must refuse rather than edit fewer than N
    const app14 = join(base, "m14");
    execFileSync(
      "node",
      [
        new URL("../monolith-gen.mjs", import.meta.url).pathname,
        "--out",
        app14,
        "--routes",
        "30",
        "--features",
        "12",
        "--feature-modules",
        "14",
        "--ui",
        "10",
        "--utils",
        "20",
      ],
      { stdio: "ignore" },
    );
    let short = null;
    try {
      short = drift.editTargets(app14, 12 * 14);
    } catch {}
    check(
      short === null || new Set(short.map((t) => t.path)).size === short.length,
      "drift refuses a pick order that repeats a module",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(join(ROOT, "drift", appName), { recursive: true, force: true });
  }
}

// --- drift record verification ------------------------------------------------------
// drift.mjs record on a synthetic sweep (one binding, warm/cold/off at N = 0 and 1): the
// consistent sweep publishes; a log whose mode, cache size, tree or plan position does
// not fit its run is refused. A one-patch binding whose patch is not its diff is refused.
{
  const { appTreeHash } = await import("./bench.mjs");
  const { publishedBinding } = await import(LIB);
  const root = mkdtempSync(join(tmpdir(), "gym-selftest-drift-record-"));
  const appDir = join(root, "apps", "drift-t");
  mkdirSync(join(appDir, "app"), { recursive: true });
  writeFileSync(join(appDir, "monolith.json"), JSON.stringify({ out: "x", files: 1 }));
  writeFileSync(join(appDir, "app", "page.tsx"), "export default () => null;\n");
  const pristine = appTreeHash(appDir);
  const map = JSON.parse(
    readFileSync(new URL("../../bench/turbopack-gym/bindings.json", import.meta.url), "utf8"),
  );
  const machine = { arch: "arm64", cpuModel: "test", cores: 2, sharedBox: false, boot: "b" };
  const phase = (s, at) => ({ s, at, cores: 1 });
  const attempt = (tamper = () => {}) => {
    rmSync(join(root, "runs"), { recursive: true, force: true });
    rmSync(join(root, "results"), { recursive: true, force: true });
    mkdirSync(join(root, "results"), { recursive: true });
    const lines = [{ id: "seed", rep: -1, n: 0, mode: "seed", cacheBefore: 0, cacheAfter: 9 }];
    for (const n of [0, 1])
      for (const mode of ["warm", "cold", "off"])
        lines.push({
          id: `${mode}${n}`,
          rep: 0,
          n,
          mode,
          cacheBefore: mode === "warm" ? 9 : 0,
          cacheAfter: mode === "off" ? 0 : 9,
        });
    const runs = {};
    for (const l of lines) {
      Object.assign(l, { sweep: "drift-t", binding: "base", appHash: l.n ? "edited" : pristine });
      runs[l.id] = {
        id: l.id,
        binding: "base",
        cpus: "0-0",
        appHash: l.appHash,
        env: {
          TURBO_ENGINE_IGNORE_DIRTY: "1",
          ...(l.mode === "off" && { MONOLITH_TP_FS_CACHE: "0" }),
        },
        machine,
        bindingSource: { head: map.base.head, diffSha256: map.base.diffSha256 },
        wall: 10,
        cores: 1,
        memPeakGiB: 1,
        graph: phase(2, 3),
        entrypoints: phase(1, 5),
        emit: phase(2, 6),
        turbopack: phase(6, 2),
        persistence: null,
        compaction: null,
        timeline: [1, 1, 1, 4, 4, 4, 4, 4, 1, 1],
        output: { sha: l.n ? "o1" : "o0" },
      };
    }
    const plan = {
      sweep: "drift-t",
      tag: null,
      edit: "import",
      app: "drift-t",
      bindings: ["base"],
      modes: ["warm", "cold", "off"],
      points: [0, 1],
      reps: 1,
      cpus: "0-0",
      seeds: { base: "o0" },
      pristine,
      mismatches: [],
    };
    tamper(lines, runs, plan);
    for (const r of Object.values(runs)) {
      mkdirSync(join(root, "runs", r.id), { recursive: true });
      writeFileSync(join(root, "runs", r.id, "run.json"), JSON.stringify(r));
    }
    writeFileSync(
      join(root, "results", "drift.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    writeFileSync(join(root, "results", "drift-sweeps.jsonl"), JSON.stringify(plan) + "\n");
    const r = spawnSync(
      "node",
      [
        process.env.GYM_SELFTEST_DRIFT || new URL("./drift.mjs", import.meta.url).pathname,
        "record",
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
  const line = (lines, id) => lines.find((l) => l.id === id);
  const published = () => JSON.parse(readFileSync(join(root, "out.json"), "utf8"));
  check(attempt() === 0, "drift record publishes a consistent sweep");
  // a resumed sweep: attempt a1 built the seed and point (0, 0), then a cold build of
  // (0, 1) before its machine went away; attempt a2 rebuilt the seed on another boot and
  // finished (0, 1). The record counts each point's finishing attempt and a1's seed only.
  const resumed = (lines, runs, extra = () => {}) => {
    for (const l of lines) l.attempt = l.n === 1 ? "a2" : "a1";
    lines.push({ ...line(lines, "cold1"), id: "cold1-a1", attempt: "a1" });
    runs["cold1-a1"] = { ...runs.cold1, id: "cold1-a1" };
    lines.push({ ...line(lines, "seed"), id: "seed-a2", attempt: "a2" });
    runs["seed-a2"] = { ...runs.seed, id: "seed-a2" };
    lines.push({ sweep: "drift-t", attempt: "a1", rep: 0, n: 0, mode: "point", mismatches: [] });
    lines.push({ sweep: "drift-t", attempt: "a2", rep: 0, n: 1, mode: "point", mismatches: [] });
    for (const id of ["warm1", "cold1", "off1", "seed-a2"])
      runs[id] = { ...runs[id], machine: { ...machine, boot: "b2" } };
    extra(lines, runs);
  };
  check(
    attempt((lines, runs) => resumed(lines, runs)) === 0 && published().boots === 2,
    "drift record publishes a resumed sweep from its finishing attempts, across two boots",
  );
  check(
    attempt((lines, runs) =>
      resumed(lines, runs, () => {
        runs.warm1 = { ...runs.warm1, machine: { ...machine, boot: "b2", cores: 4 } };
      }),
    ) !== 0,
    "drift record refuses a resumed sweep whose attempts ran on different machine types",
  );
  {
    const { resumable, countedRuns } = await import(
      new URL("./drift.mjs", import.meta.url).pathname
    );
    const p = (sweep, extra = {}) => ({
      sweep,
      tag: "t",
      edit: "import",
      app: "a",
      bindings: ["x"],
      modes: ["warm"],
      points: [0, 1],
      reps: 2,
      cpus: "0-23",
      pageWorkers: "match",
      instanceType: "c8gd.48xlarge",
      ...extra,
    });
    const want = p(null);
    check(
      resumable([p("s1"), p("s2")], [], want, "c8gd.48xlarge")?.sweep === "s2" &&
        resumable([p("s1")], [{ sweep: "s1" }], want, "c8gd.48xlarge") === null &&
        resumable([p("s1", { reps: 3 })], [], want, "c8gd.48xlarge") === null &&
        resumable([p("s1")], [], want, "c9gd.48xlarge") === null,
      "drift --resume picks the newest unfinished sweep with the same plan on the same instance type",
    );
    const legacy = [{ sweep: "s", id: "r1", mode: "warm", rep: 0, n: 0 }];
    check(
      countedRuns(legacy, "s").length === 1,
      "drift counts every run of a sweep from before point lines",
    );
  }
  check(
    published().pageWorkers === "default",
    "drift record calls a sweep without a page-workers setting default",
  );
  check(
    attempt((_, runs, plan) => {
      plan.pageWorkers = "match";
      for (const r of Object.values(runs)) r.env.CIRCLE_NODE_TOTAL = "1";
    }) === 0 && published().pageWorkers === "match",
    "drift record publishes a match sweep whose runs set the pool to its CPUs",
  );
  check(
    attempt((_, runs) => (runs.cold1.env.CIRCLE_NODE_TOTAL = "1")) !== 0,
    "drift record refuses a run whose page-data pool is not the plan's",
  );
  check(
    attempt((_, runs, plan) => {
      plan.pageWorkers = "match";
      for (const r of Object.values(runs)) if (r.id !== "warm1") r.env.CIRCLE_NODE_TOTAL = "1";
    }) !== 0,
    "drift record refuses a match sweep with a run left at the default pool",
  );
  check(
    attempt((_, runs) => delete runs.off1.env.MONOLITH_TP_FS_CACHE) !== 0,
    "drift record refuses an off run built with the cache on",
  );
  check(
    attempt((lines) => (line(lines, "warm1").cacheBefore = 0)) !== 0,
    "drift record refuses a warm run that started with no cache",
  );
  check(
    attempt((lines) => (line(lines, "cold1").cacheBefore = 9)) !== 0,
    "drift record refuses a cold run that started with a cache",
  );
  check(
    attempt((lines) => (line(lines, "cold1").appHash = "other")) !== 0,
    "drift record refuses a log line whose tree is not its run's",
  );
  check(
    attempt((lines, runs) => (line(lines, "off1").appHash = runs.off1.appHash = "edited2")) !== 0,
    "drift record refuses two trees for one N",
  );
  check(
    attempt((lines) => (line(lines, "off1").rep = 1)) !== 0,
    "drift record refuses a run outside its plan",
  );
  check(
    attempt((_, runs) => (runs.warm1.output.sha = "o2")) !== 0,
    "drift record refuses a warm output that is not the cold one",
  );
  const one = Object.entries(map).find(([, v]) => v.patches.length === 1);
  let refused = false;
  try {
    publishedBinding({ x: { ...one[1], diffSha256: "0000000000000000" } }, "x");
  } catch {
    refused = true;
  }
  check(
    refused && publishedBinding(map, one[0]).patches.length === 1,
    "a record refuses a one-patch binding whose patch is not its diff",
  );
  rmSync(root, { recursive: true, force: true });
}

// --- page-data workers -------------------------------------------------------------
// "match" sizes Next's page-data pool to the build's CPUs through CIRCLE_NODE_TOTAL; the
// default leaves Next's own (every CPU of the machine) and an unknown mode is refused.
{
  const { pageWorkersEnv } = lib;
  let refused = false;
  try {
    pageWorkersEnv("all", "0-23");
  } catch {
    refused = true;
  }
  check(
    pageWorkersEnv("match", "0-23,48-55").CIRCLE_NODE_TOTAL === "32" &&
      Object.keys(pageWorkersEnv("default", "0-23")).length === 0 &&
      Object.keys(pageWorkersEnv(undefined, "0-23")).length === 0 &&
      refused,
    "page workers: match counts the build's CPUs, default sets nothing",
  );
}

// --- remote records -----------------------------------------------------------------
// record.mjs --host --out: the remote run writes the --out file's name under the host's
// gitignored bench/raw/remote/ (never over a record in the host's checkout, whatever --out
// names) and that file comes back to --out, never over the default record.
{
  const { remoteRecord } = await import("./hosts.mjs");
  const r = remoteRecord(
    ["ab", "--labels", "x", "--host", "h", "--out", "bench/turbopack-graph-52.json"],
    { repoDir: "/remote/repo" },
    "bench/turbopack-graph-52.json",
    "turbopack-graph-ab.json",
  );
  check(
    r.remote === "/remote/repo/bench/raw/remote/turbopack-graph-52.json" &&
      r.local.endsWith("/bench/turbopack-graph-52.json") &&
      JSON.stringify(r.args) === JSON.stringify(["ab", "--labels", "x", "--out", r.remote]),
    "record --host --out copies the named record back to --out",
  );
  const canon = remoteRecord(
    ["ab", "--host=h", "--out=x/turbopack-graph-scaling.json"],
    { repoDir: "/remote/repo" },
    "x/turbopack-graph-scaling.json",
    "turbopack-graph-ab.json",
  );
  check(
    canon.remote === "/remote/repo/bench/raw/remote/turbopack-graph-scaling.json" &&
      JSON.stringify(canon.args) === JSON.stringify(["ab", "--out", canon.remote]),
    "record --host --out never writes over a record in the host's checkout",
  );
}

// --- published records -------------------------------------------------------------
// No record under bench/ carries a kernel address (a perf symbol that did not resolve
// gives one; it shows this boot's kernel layout).
{
  const bench = new URL("../../bench/", import.meta.url).pathname;
  const files = [bench, join(bench, "turbopack-gym")].flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith(".json") || f.endsWith(".md"))
      .map((f) => join(d, f)),
  );
  const hits = files.filter((f) => /0xffff[0-9a-f]{12}/.test(readFileSync(f, "utf8")));
  check(!hits.length, `no published record holds a kernel address (${hits.join(" ")})`);
}

// --- report keys ------------------------------------------------------------------
// report.mjs in a scratch repo holding the canonical records, a TURBOPACK-GRAPH.md with
// `keys`, and any extra files; returns the run and the rendered doc.
function reportWith(keys, extra = {}, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "gym-report-"));
  try {
    const here = new URL(".", import.meta.url).pathname;
    const repo = join(here, "..", "..");
    mkdirSync(join(dir, "scripts", "turbopack-gym"), { recursive: true });
    mkdirSync(join(dir, "bench", "turbopack-gym"), { recursive: true });
    cpSync(join(here, "report.mjs"), join(dir, "scripts", "turbopack-gym", "report.mjs"));
    for (const f of ["turbopack-graph-ab.json", "turbopack-graph-scaling.json"])
      cpSync(join(repo, "bench", f), join(dir, "bench", f));
    writeFileSync(
      join(dir, "TURBOPACK-GRAPH.md"),
      "<!-- turbopack-graph:ab --><!-- /turbopack-graph:ab -->\n" +
        "<!-- turbopack-graph:scaling --><!-- /turbopack-graph:scaling -->\n" +
        keys.map((k) => `<!--v:${k}-->?<!--/v-->`).join("\n") +
        "\n",
    );
    for (const f of ["README.md", "SUMMARY.md", "bench/turbopack-gym/cache-drift.md"])
      writeFileSync(join(dir, f), "");
    for (const [f, body] of Object.entries(extra)) writeFileSync(join(dir, f), body);
    const r = spawnSync("node", [join(dir, "scripts", "turbopack-gym", "report.mjs"), ...args], {
      encoding: "utf8",
    });
    return { ...r, doc: readFileSync(join(dir, "TURBOPACK-GRAPH.md"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// report.mjs names a missing optional record in its error (a doc key that needs it).
{
  const r = reportWith(["oc.mono-52.ratio"], {}, ["--check"]);
  check(
    r.status !== 0 && r.stderr.includes("no bench/turbopack-graph-52.json"),
    "report.mjs names a missing optional record",
  );
}
// rs.* keys: a route-stats record's medians, ratio and manifest count; an error naming a
// record that is absent.
{
  const rec = JSON.stringify({
    ratio: 0.25,
    manifests: { files: 2073, mb: 774.6 },
    median: { base: { s: 8, rssMiB: 1310 }, candidate: { s: 2, rssMiB: 113 } },
  });
  const r = reportWith(
    ["rs.c60.base.s", "rs.c60.candidate.rssMiB", "rs.c60.ratio", "rs.c60.manifests"],
    { "bench/turbopack-gym/route-stats-60.json": rec },
  );
  check(
    r.status === 0 &&
      r.doc.includes("<!--v:rs.c60.base.s-->8.00s<!--/v-->") &&
      r.doc.includes("<!--v:rs.c60.candidate.rssMiB-->113 MiB<!--/v-->") &&
      r.doc.includes("<!--v:rs.c60.ratio-->0.250<!--/v-->") &&
      r.doc.includes("<!--v:rs.c60.manifests-->2,073 files, 774.6 MB<!--/v-->"),
    "report.mjs renders rs.* keys from a route-stats record",
  );
  const missing = reportWith(["rs.c60.ratio"]);
  check(
    missing.status !== 0 && missing.stderr.includes("no route-stats record c60"),
    "report.mjs names a missing route-stats record",
  );
}
// na.* keys: a next-ab record's medians and ratio; an error naming a record that is absent
{
  const rec = JSON.stringify({
    median: {
      cold: {
        base: { wall: 80, turbopack: 45, after: 35 },
        candidate: { wall: 60, turbopack: 45, after: 15 },
        ratio: 0.75,
      },
    },
  });
  const r = reportWith(
    ["na.c62.cold.base.after", "na.c62.cold.candidate.wall", "na.c62.cold.ratio"],
    {
      "bench/turbopack-gym/next-ab-62.json": rec,
    },
  );
  check(
    r.status === 0 &&
      r.doc.includes("<!--v:na.c62.cold.base.after-->35.0s<!--/v-->") &&
      r.doc.includes("<!--v:na.c62.cold.candidate.wall-->60.0s<!--/v-->") &&
      r.doc.includes("<!--v:na.c62.cold.ratio-->0.750<!--/v-->"),
    "report.mjs renders na.* keys from a next-ab record",
  );
  const missing = reportWith(["na.c62.cold.ratio"]);
  check(
    missing.status !== 0 && missing.stderr.includes("no next-ab record c62"),
    "report.mjs names a missing next-ab record",
  );
}
// cr.* keys: the median over a cache-read set's reps, a ratio of two medians, and an
// error naming a set the record does not have.
{
  const b = (binding, mode, turbopack) => ({ n: 0, binding, mode, wall: 20, turbopack });
  const probes = JSON.stringify({
    s: { builds: [b("base", "mmap", 10), b("base", "mmap", 14), b("x", "mmap", 4)] },
  });
  const extra = { "bench/turbopack-gym/cache-read-probes.json": probes };
  const ok = reportWith(["cr.s.base.mmap.0.turbopack", "cr.s.base.mmap.0.over.x.mmap"], extra);
  check(
    ok.status === 0 &&
      ok.doc.includes("<!--v:cr.s.base.mmap.0.turbopack-->12.0s<!--/v-->") &&
      ok.doc.includes("<!--v:cr.s.base.mmap.0.over.x.mmap-->3.0<!--/v-->"),
    "report.mjs renders cache-read medians and ratios",
  );
  const missing = reportWith(["cr.t.base.mmap.0.turbopack"], extra);
  check(
    missing.status !== 0 && missing.stderr.includes("no set t in cache-read-probes.json"),
    "report.mjs names a missing cache-read set",
  );
  // a top-level entry that is not a set of builds, and a build without the field
  const notSet = reportWith(["cr.method.base.mmap.0.turbopack"], {
    "bench/turbopack-gym/cache-read-probes.json": JSON.stringify({ method: { builds: "x" } }),
  });
  check(
    notSet.status !== 0 && notSet.stderr.includes("no set method in cache-read-probes.json"),
    "report.mjs refuses a cache-read entry that is not a set",
  );
  const noField = reportWith(["cr.s.base.mmap.0.wall"], {
    "bench/turbopack-gym/cache-read-probes.json": JSON.stringify({
      s: { builds: [{ n: 0, binding: "base", mode: "mmap", turbopack: 1 }] },
    }),
  });
  check(
    noField.status !== 0 && noField.stderr.includes("cr.s.base.mmap.0.wall: no wall"),
    "report.mjs refuses a cache-read build without the field",
  );
  // pageCache sets name the page cache (cold|hot) where other sets name the access mode
  const pc = reportWith(["cr.p.base.hot.0.turbopack"], {
    "bench/turbopack-gym/cache-read-probes.json": JSON.stringify({
      p: {
        builds: [
          { n: 0, binding: "base", mode: "mmap", pageCache: "cold", turbopack: 30 },
          { n: 0, binding: "base", mode: "mmap", pageCache: "hot", turbopack: 4 },
        ],
      },
    }),
  });
  check(
    pc.status === 0 && pc.doc.includes("<!--v:cr.p.base.hot.0.turbopack-->4.0s<!--/v-->"),
    "report.mjs reads a pageCache set by its page cache",
  );
}

// --- cpuCount counts distinct CPUs ------------------------------------------------------
{
  // the cpuset and the CPU locks take the distinct CPUs of a list; the page-data pool sized
  // to match (pageWorkersEnv) must count the same CPUs, not the length of each range
  check(
    lib.cpuCount("0-3,2-5") === 6 &&
      lib.cpuCount("0-23") === 24 &&
      lib.cpuCount("4,4") === 1 &&
      lib.pageWorkersEnv("match", "0-3,2-5").CIRCLE_NODE_TOTAL === "6",
    `cpuCount counts each CPU once (0-3,2-5 -> ${lib.cpuCount("0-3,2-5")})`,
  );
}

// --- route-stats.mjs paths ---------------------------------------------------------
{
  // a relative --patch must be found although `patch -d` runs in another directory: the run
  // gets past the patch and stops at the fixture app, which has no typescript
  const { routeStats } = await import("./route-stats.mjs");
  const dir = mkdtempSync(join(tmpdir(), "gym-selftest-route-paths-"));
  try {
    mkdirSync(join(dir, "output", "diagnostics"), { recursive: true });
    writeFileSync(join(dir, "output", "diagnostics", "route-bundle-stats.json"), "[]");
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "package.json"), "{}");
    const patch = relative(
      process.cwd(),
      join(lib.CANDIDATES, "60-route-stats-json-manifest.patch"),
    );
    let message = "";
    try {
      await routeStats({
        output: join(dir, "output"),
        app: join(dir, "app"),
        patch,
        reps: 1,
        cpu: "0",
      });
    } catch (e) {
      message = e.message;
    }
    check(
      !patch.startsWith("/") && /typescript/.test(message) && !/patch file/.test(message),
      `route-stats.mjs applies a patch given by a relative path (${message.split("\n")[0]})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- climb.mjs measures native candidates only ------------------------------------------
{
  // a candidate whose patch changes only Next.js's JavaScript/TypeScript would build an
  // unchanged binding: climb must skip it (route-stats.mjs or next-ab.mjs measure those)
  const ok = typeof lib.nativeCandidate === "function";
  const rust = { patch: "bench/turbopack-gym/candidates/61-shared-manifest-entry-parts.patch" };
  const js = { patch: "bench/turbopack-gym/candidates/60-route-stats-json-manifest.patch" };
  const climbSrc = readFileSync(new URL("./climb.mjs", import.meta.url), "utf8");
  check(
    ok &&
      lib.nativeCandidate(rust) === true &&
      lib.nativeCandidate(js) === false &&
      lib.nativeCandidate({ env: { A: "1" } }) === true &&
      /nativeCandidate\(cand\)/.test(climbSrc),
    "climb.mjs skips a candidate whose patch changes no native source",
  );
  // a patch that also changes Next.js's JavaScript would be climbed with that half unrun
  const dir = mkdtempSync(join(tmpdir(), "gym-selftest-mixed-"));
  try {
    const mixed = join(dir, "mixed.patch");
    writeFileSync(
      mixed,
      "--- a/crates/x/src/lib.rs\n+++ b/crates/x/src/lib.rs\n--- a/packages/next/src/y.ts\n+++ b/packages/next/src/y.ts\n",
    );
    const deleted = join(dir, "deleted.patch");
    writeFileSync(
      deleted,
      "diff --git a/crates/x/src/lib.rs b/crates/x/src/lib.rs\n--- a/crates/x/src/lib.rs\n+++ b/crates/x/src/lib.rs\ndiff --git a/packages/next/src/y.ts b/packages/next/src/y.ts\ndeleted file mode 100644\n--- a/packages/next/src/y.ts\n+++ /dev/null\n",
    );
    const renamed = join(dir, "renamed.patch");
    writeFileSync(
      renamed,
      "diff --git a/crates/x/src/lib.rs b/crates/x/src/lib.rs\n--- a/crates/x/src/lib.rs\n+++ b/crates/x/src/lib.rs\ndiff --git a/packages/next/src/y.ts b/crates/x/src/y.rs\nsimilarity index 100%\nrename from packages/next/src/y.ts\nrename to crates/x/src/y.rs\n",
    );
    check(
      ok &&
        lib.nativeCandidate({ patch: mixed }) === false &&
        lib.nativeCandidate({ patch: deleted }) === false &&
        lib.nativeCandidate({ patch: renamed }) === false,
      "climb.mjs skips a candidate whose patch also changes, deletes or renames Next.js's JavaScript",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- route-stats.mjs samples do not block signals ---------------------------------------
{
  // each sample is an awaited child process, killed on abort, and the loop checks for an
  // abort before each sample, so SIGINT/SIGTERM stop the run instead of waiting for all
  const rs = await import("./route-stats.mjs");
  const src = readFileSync(new URL("./route-stats.mjs", import.meta.url), "utf8");
  let ticked = false;
  const timer = setTimeout(() => (ticked = true), 50);
  const r = typeof rs.runSample === "function" ? await rs.runSample("sleep", ["0.5"]) : null;
  clearTimeout(timer);
  check(
    r?.status === 0 && ticked && !/spawnSync\(/.test(src) && /checkAborted\(\)/.test(src),
    "route-stats.mjs runs each sample as an awaited child and checks for an abort between them",
  );
}

// --- next-ab.mjs and next-overlay.cjs ---------------------------------------------------
{
  const { buildOverlays, overlayEnv, patchedFiles } = await import("./next-ab.mjs");
  const throws = (f) => {
    try {
      f();
      return "";
    } catch (e) {
      return e.message;
    }
  };
  check(
    /under packages\/next\/src\//.test(
      throws(() => patchedFiles("--- a/crates/x.rs\n+++ b/crates/x.rs\n")),
    ) && /changes no file/.test(throws(() => patchedFiles("nothing\n"))),
    "next-ab.mjs takes patches to Next.js TypeScript sources only",
  );
  // the preload runs a replacement in place of a dist file, under its name, and logs the load
  const dir = mkdtempSync(join(tmpdir(), "gym-selftest-overlay-"));
  try {
    const dist = join(dir, "node_modules", "next", "dist");
    mkdirSync(join(dist, "lib"), { recursive: true });
    writeFileSync(join(dist, "lib", "dep.js"), "module.exports = 'dep';\n");
    writeFileSync(join(dist, "x.js"), "module.exports = 'stock';\n");
    writeFileSync(join(dir, "x-new.js"), "module.exports = 'replaced ' + require('./lib/dep');\n");
    const log = join(dir, "overlay.log");
    const r = spawnSync(
      process.execPath,
      ["-p", `require(${JSON.stringify(join(dist, "x.js"))})`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...overlayEnv({ [join(dist, "x.js")]: join(dir, "x-new.js") }, log),
        },
      },
    );
    const logged = existsSync(log) ? readFileSync(log, "utf8") : "";
    check(
      r.stdout.trim() === "replaced dep" && logged.includes(`${r.pid} ${join(dist, "x.js")}`),
      `next-overlay.cjs loads the replacement under the dist file's name and logs it (${r.stdout.trim() || r.stderr.slice(0, 200)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // on the quick app (its own typescript and next): candidate 62 replaces the app's
  // dist/server/config-shared.js, base and candidate compiled from the vendored source
  const quick = join(APPS, "quick");
  if (existsSync(join(quick, "node_modules", "typescript"))) {
    const work = mkdtempSync(join(tmpdir(), "gym-selftest-next-ab-"));
    try {
      const { overlays, sources } = buildOverlays({
        app: quick,
        patch: join(lib.CANDIDATES, "62-available-parallelism.patch"),
        work,
      });
      const [target] = Object.keys(overlays.candidate);
      const text = (side) => readFileSync(overlays[side][target], "utf8");
      check(
        target.endsWith("/next/dist/server/config-shared.js") &&
          existsSync(target) &&
          Object.keys(overlays.base).join() === target &&
          sources["config-shared.ts"] &&
          text("candidate").includes("availableParallelism()") &&
          !text("base").includes("availableParallelism()"),
        "next-ab.mjs compiles base and candidate 62 over the app's dist/server/config-shared.js",
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } else check(false, "the quick app has typescript (next-ab.mjs overlay test)");
}

// --- published records carry no boot id ----------------------------------------------
{
  // the boot id is for raw logs only; records written straight to bench/ take the machine
  // fields without it
  const pub = lib.publicMachine ? lib.publicMachine() : lib.machine();
  const writers = ["route-stats.mjs", "next-ab.mjs"].filter((f) =>
    /machine: machine\(\)/.test(readFileSync(new URL(`./${f}`, import.meta.url), "utf8")),
  );
  check(
    !("boot" in pub) && pub.instanceType !== undefined && writers.length === 0,
    `records written by route-stats.mjs and next-ab.mjs leave out the boot id (${writers.join(", ") || "none embed machine()"})`,
  );
}

// --- next-ab.mjs warm builds use the cache -------------------------------------------
{
  // a patched binding is built from a dirty next.js tree and, without
  // TURBO_ENGINE_IGNORE_DIRTY, writes its cache where the next build deletes it: next-ab must
  // set it like drift.mjs, and refuse a warm build that rebuilt the module graph
  const { buildEnv, checkWarm } = await import("./next-ab.mjs");
  let refused = "";
  try {
    checkWarm({ graph: { s: 4 } }, "candidate");
  } catch (e) {
    refused = e.message;
  }
  check(
    buildEnv?.({ A: "1" }).TURBO_ENGINE_IGNORE_DIRTY === "1" &&
      buildEnv({ A: "1" }).A === "1" &&
      /rebuilt the module graph/.test(refused) &&
      checkWarm({ graph: null }, "base") === undefined,
    "next-ab.mjs keeps the cache of a patched binding and refuses a warm build that did not use it",
  );
}

// --- bench.mjs --node ----------------------------------------------------------------
{
  // a build with another node binary records that binary's version and hash
  const { prepare } = await import("./bench.mjs");
  const quick = join(APPS, "quick");
  const p = prepare({ binding: "stock", app: quick, node: process.execPath });
  const plain = prepare({ binding: "stock", app: quick });
  check(
    p.node === process.execPath &&
      p.buildNode.startsWith(`${process.version} (`) &&
      /\([0-9a-f]{16}\)$/.test(p.buildNode) &&
      plain.buildNode === process.version,
    `bench.mjs records the node binary a build runs on (${p.buildNode})`,
  );
}

// --- bench.mjs --node on the command line ------------------------------------------------
{
  // the CLI takes --node and hands it to bench(): with a binary that does not exist the run
  // fails resolving that binary, not on an unknown flag
  const r = spawnSync(
    process.execPath,
    [
      new URL("./bench.mjs", import.meta.url).pathname,
      "--node",
      "/nonexistent/gym-selftest-node",
      "--binding",
      "stock",
      "--app",
      "quick",
      "--cpus",
      "0-1",
    ],
    { encoding: "utf8", env: process.env, timeout: 60000 },
  );
  check(
    r.status !== 0 && !/unknown flag/.test(r.stderr) && /gym-selftest-node|ENOENT/.test(r.stderr),
    `bench.mjs accepts --node and runs the build with it (${(r.stderr.match(/Error[^\n]*/) || [""])[0].slice(0, 100)})`,
  );
}

// --- process-start probes count successful launches only ------------------------------
{
  // a launch that failed (resource limits at a large heap) would otherwise be timed as a
  // fast start: both probes check the child's exit before keeping a sample
  const py = readFileSync(new URL("./process-start-cost.py", import.meta.url), "utf8");
  const js = readFileSync(new URL("./process-start-cost.mjs", import.meta.url), "utf8");
  check(
    /waitstatus_to_exitcode|WEXITSTATUS|status != 0/.test(py) && /\.status !== 0|\.error/.test(js),
    "process-start-cost.{py,mjs} refuse a launch that did not exit 0",
  );
}

// --- record writers check each build's binding against bindings.json ------------------
{
  // a record names a binding from bindings.json; each build's binding source must be that
  // entry's head and diff, or the record would credit results to a stack it did not measure
  const map = { x: { head: "h1", diffSha256: "d1", patches: [] } };
  const good = { id: "r1", binding: "x", bindingSource: { head: "h1", diffSha256: "d1" } };
  const stale = { id: "r2", binding: "x", bindingSource: { head: "h1", diffSha256: "d2" } };
  const unknown = { id: "r3", binding: "y", bindingSource: { head: "h1", diffSha256: "d1" } };
  const throws = (f) => {
    try {
      f();
      return false;
    } catch {
      return true;
    }
  };
  const fn = lib.checkBindingSource;
  const users = ["drift.mjs", "next-ab.mjs"].filter(
    (f) => !/checkBindingSource\(/.test(readFileSync(new URL(`./${f}`, import.meta.url), "utf8")),
  );
  check(
    typeof fn === "function" &&
      !throws(() => fn(map, good)) &&
      throws(() => fn(map, stale)) &&
      throws(() => fn(map, unknown)) &&
      users.length === 0,
    `drift.mjs and next-ab.mjs check each build's binding against bindings.json (missing: ${users.join(", ") || "none"})`,
  );
}

// --- GYM_RUNS ---------------------------------------------------------------------------
{
  // the run directories can live apart from GYM_ROOT (a volume that outlives the machine)
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const l = await import(${JSON.stringify(LIB)}); console.log(l.RUNS)`,
    ],
    { encoding: "utf8", env: { ...process.env, GYM_RUNS: "/gym-selftest/runs" } },
  );
  check(r.stdout.trim() === "/gym-selftest/runs", "GYM_RUNS moves the run directories");
}

// --- output fingerprint ------------------------------------------------------------
if (a.builds) {
  // under the CPU locks of the 64 CPUs it builds on, like any other gym run
  const { bench } = await import("./bench.mjs");
  const quick = join(APPS, "quick");
  const lanes = ["0-15", "16-31", "32-47", "48-63"];
  await lib.withCpus("0-63", async () => {
    const shas = new Set();
    let first;
    for (let round = 0; round < 2; round++) {
      const runs = await Promise.all(
        lanes.map((cpus, i) =>
          bench({ binding: "base", cpus, app: quick, label: `selftest-${round}${i}`, quiet: true }),
        ),
      );
      for (const r of runs) shas.add(r.output.sha);
      first ??= runs[0];
    }
    check(
      shas.size === 1,
      `8 builds of one binding, one normalized output (${[...shas].join(" ")})`,
    );
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
        quiet: true,
      });
      check(
        src !== readFileSync(f, "utf8") && z.output.sha !== first.output.sha,
        "one changed constant changes the normalized output",
      );
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
}

// --- route-stats.mjs -----------------------------------------------------------------
if (a.builds) {
  // on a kept build of the quick app: candidate 60 writes the build's own stats file, and a
  // patch that changes the stats is refused
  const { bench } = await import("./bench.mjs");
  const { routeStats, BASE_TS } = await import("./route-stats.mjs");
  const quick = join(APPS, "quick");
  const run = await lib.withCpus("0-15", () =>
    bench({
      binding: "base",
      cpus: "0-15",
      app: quick,
      label: "selftest-route-stats",
      keep: true,
      quiet: true,
    }),
  );
  const dir = mkdtempSync(join(tmpdir(), "gym-selftest-route-stats-"));
  try {
    const opts = { output: run.distDir, app: quick, reps: 1, cpu: "16" };
    const real = await routeStats({
      ...opts,
      patch: join(lib.CANDIDATES, "60-route-stats-json-manifest.patch"),
    });
    check(
      real.sameOutput && real.matchesBuild && real.manifests.files > 0,
      `route-stats.mjs: candidate 60 writes the build's route-bundle-stats.json (${real.manifests.files} manifests)`,
    );
    const ts = "packages/next/src/build/route-bundle-stats.ts";
    const changed = join(dir, "changed.ts");
    writeFileSync(
      changed,
      readFileSync(BASE_TS, "utf8").replace("total += size\n", "total += size + 1\n"),
    );
    const diff = spawnSync(
      "diff",
      ["-u", "--label", `a/${ts}`, "--label", `b/${ts}`, BASE_TS, changed],
      {
        encoding: "utf8",
      },
    );
    const tampered = join(dir, "tampered.patch");
    writeFileSync(tampered, diff.stdout);
    let refused = "";
    try {
      await routeStats({ ...opts, patch: tampered });
    } catch (e) {
      refused = e.message;
    }
    check(
      diff.status === 1 && /different route-bundle-stats\.json/.test(refused),
      "route-stats.mjs refuses a candidate whose stats differ",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(run.distDir, { recursive: true, force: true });
  }
}

// --- next-ab.mjs ---------------------------------------------------------------------
if (a.builds) {
  // candidate 62 on the quick app: with the reference (base told the worker count the
  // candidate computes) the outputs match; against base's default count they do not, and the
  // run is refused
  const { nextAb } = await import("./next-ab.mjs");
  const opts = {
    patch: join(lib.CANDIDATES, "62-available-parallelism.patch"),
    app: "quick",
    cpus: "0-15",
    reps: 1,
    modes: ["cold"],
  };
  const rec = await nextAb({ ...opts, referenceEnv: { CIRCLE_NODE_TOTAL: "16" } });
  check(
    rec.sameOutput &&
      rec.outputs.candidate === rec.outputs.reference &&
      rec.runs.every((r) => r.overlayProcesses >= 1),
    "next-ab.mjs: candidate 62's output equals base's with the same worker count set",
  );
  let refused = "";
  try {
    await nextAb(opts);
  } catch (e) {
    refused = e.message;
  }
  check(
    /candidate's output \w+ differs from base's/.test(refused),
    `next-ab.mjs refuses a candidate whose output differs (${refused.slice(0, 120)})`,
  );
}

if (a.builds) {
  const quick = join(APPS, "quick");
  // SIGTERM mid-build: the build's scope is stopped, the process unwinds (exit non-zero)
  // and its CPU locks are released
  const scopes = () =>
    execFileSync("systemctl", ["list-units", "--type=scope", "--no-legend", "gym-*"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean).length;
  const before = scopes();
  const marker = join(tmpdir(), `gym-selftest-finally-${process.pid}`);
  rmSync(marker, { force: true });
  const victim = spawn(
    "node",
    [
      "--input-type=module",
      "-e",
      `const l = await import(${JSON.stringify(LIB)}); const b = await import(${JSON.stringify(new URL("./bench.mjs", import.meta.url).pathname)}); await l.withCpus("0-15", async () => { try { await b.bench({ binding: "base", cpus: "0-15", app: ${JSON.stringify(quick)}, quiet: true }); } finally { (await import("node:fs")).writeFileSync(${JSON.stringify(marker)}, "finally ran"); } });`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  for (let i = 0; i < 100 && scopes() <= before; i++) await new Promise((r) => setTimeout(r, 200));
  check(scopes() > before, "the interrupted build was running in its scope");
  victim.kill("SIGTERM");
  const code = await new Promise((r) => victim.on("close", r));
  check(code !== 0, `an interrupted run exits non-zero (${code})`);
  let left = scopes();
  for (let i = 0; i < 50 && left > before; i++) {
    await new Promise((r) => setTimeout(r, 200));
    left = scopes();
  }
  check(left <= before, "no build scope outlives the interrupted run");
  check(existsSync(marker), "the interrupted run's finally blocks ran");
  rmSync(marker, { force: true });
  let freed = false;
  await Promise.race([
    lib.withCpus("0-15", async () => (freed = true)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  check(freed, "the interrupted run's CPUs are free again");
}

process.exit(failed ? 1 : 0);

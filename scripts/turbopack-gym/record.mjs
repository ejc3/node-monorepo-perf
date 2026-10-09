#!/usr/bin/env node
// Turn raw gym runs into the records of record that TURBOPACK-GRAPH.md cites. Every
// published number is recomputed from the per-run files ($GYM_ROOT/runs/<id>/run.json),
// and every run is verified before it is used: its binding's code (provenance against
// bench/turbopack-gym/bindings.json), the app tree it built (the app's current tree
// hash on this host), and one machine for the whole record. A run that fails a check
// stops the record.
//
//   node scripts/turbopack-gym/record.mjs scaling [--sweep <id>]  # -> bench/turbopack-graph-scaling.json
//   node scripts/turbopack-gym/record.mjs ab [--labels a,b]       # -> bench/turbopack-graph-ab.json
//   node scripts/turbopack-gym/record.mjs ab --host bigbox        # write it where the runs are
//
// scaling: one sweep from scaling.mjs (default: the latest). ab: the latest A/B per
// label (default: every label in the log).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appTreeHash } from "./bench.mjs";
import { APPS, REPO, RESULTS, RUNS, median, parseArgs, readJsonl } from "./lib.mjs";
import { host, runRemote, stripHost, sync } from "./hosts.mjs";

const argv = process.argv.slice(2);
const a = parseArgs(argv, { labels: 1, host: 1, sweep: 1, out: 1, tag: 1 });
const kind = a._[0];
const OUT = { scaling: "turbopack-graph-scaling.json", ab: "turbopack-graph-ab.json" }[kind];
if (!OUT) {
  console.error("usage: record.mjs scaling|ab [--sweep id] [--labels a,b] [--host name]");
  process.exit(1);
}

// --host: write the record on the host whose runs it describes, then copy it back
if (a.host) {
  const h = host(a.host);
  sync(h, []);
  const { code } = await runRemote(h, "scripts/turbopack-gym/record.mjs", stripHost(argv));
  if (code !== 0) process.exit(typeof code === "number" ? code : 1);
  execFileSync(
    "scp",
    [...h.ssh, `${h.target}:${h.repoDir}/bench/${OUT}`, join(REPO, "bench", OUT)],
    {
      stdio: "inherit",
    },
  );
  console.log(`copied bench/${OUT} from ${a.host}`);
  process.exit(0);
}

const sha16 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
const BINDING_MAP = JSON.parse(
  readFileSync(join(REPO, "bench", "turbopack-gym", "bindings.json"), "utf8"),
);
const PHASES = ["graph", "entrypoints", "emit", "turbopack", "persistence"];

const loadRun = (id) => {
  const p = join(RUNS, id, "run.json");
  if (!existsSync(p))
    throw new Error(`run ${id} is not on this host: write the record where it ran (--host)`);
  return JSON.parse(readFileSync(p, "utf8"));
};

// the app each run built must be the app this host has now (whose shape the record states)
const appInfo = new Map();
function app(name) {
  if (!appInfo.has(name)) {
    const dir = join(APPS, name);
    const { out, ...shape } = JSON.parse(readFileSync(join(dir, "monolith.json"), "utf8"));
    appInfo.set(name, { shape, hash: appTreeHash(dir) });
  }
  return appInfo.get(name);
}

let recordMachine;
function verify(run) {
  const entry = BINDING_MAP[run.binding];
  if (!entry)
    throw new Error(
      `run ${run.id}: binding "${run.binding}" is not in bench/turbopack-gym/bindings.json`,
    );
  if (run.bindingSource?.head !== entry.head)
    throw new Error(
      `run ${run.id}: binding ${run.binding} built from ${run.bindingSource?.head}, bindings.json says ${entry.head}`,
    );
  if (!run.bindingSource?.nodeSha256) throw new Error(`run ${run.id}: no native module hash`);
  if (run.bindingSource?.diffSha256 !== entry.diffSha256)
    throw new Error(
      `run ${run.id}: binding ${run.binding} ran diff ${run.bindingSource?.diffSha256}, bindings.json says ${entry.diffSha256}`,
    );
  if (!run.appHash || run.appHash !== app(run.app).hash)
    throw new Error(
      `run ${run.id}: app tree ${run.appHash} is not this host's ${run.app} (${app(run.app).hash})`,
    );
  if (!run.machine?.boot) throw new Error(`run ${run.id} has no machine fields`);
  const { buildNode, ...m } = run.machine;
  recordMachine ??= run.machine;
  const { buildNode: _, ...rm } = recordMachine;
  if (JSON.stringify(m) !== JSON.stringify(rm) || buildNode !== recordMachine.buildNode)
    throw new Error(`run ${run.id} ran on a different machine than the record's other runs`);
  if (!run.output?.files) throw new Error(`run ${run.id} has no output fingerprint`);
}

// the per-run fields a record publishes
const publish = (r) => ({
  cpus: r.cpus,
  env: r.env,
  when: r.when,
  wall: r.wall,
  cores: r.cores,
  memPeakGiB: r.memPeakGiB,
  ...Object.fromEntries(PHASES.map((p) => [p, r[p]])),
  output: r.output,
  bindingSource: r.bindingSource,
});

function bindingsUsed(names) {
  return Object.fromEntries(
    [...new Set(names)].map((n) => [
      n,
      {
        diffSha256: BINDING_MAP[n].diffSha256,
        patches: BINDING_MAP[n].patches.map((f) => ({
          patch: `bench/turbopack-gym/candidates/${f}`,
          sha256: sha16(readFileSync(join(REPO, "bench", "turbopack-gym", "candidates", f))),
        })),
      },
    ]),
  );
}

const common = {
  generator:
    "scripts/turbopack-gym (bench.mjs: next build --experimental-build-mode=compile, cold, cpuset-pinned systemd scope)",
  bindingBuild:
    "next-napi-bindings from vercel/next.js v16.4.0 (gym/base) plus each binding's patches; cargo --release, CARGO_PROFILE_RELEASE_LTO=false, CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16",
};
const publicMachine = () => {
  const { boot, ...m } = recordMachine; // the boot hash stays in the raw logs
  return m;
};
const write = (rec) => {
  const path = a.out || join(REPO, "bench", OUT); // --out: elsewhere (selftest)
  writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${path}`);
};
const gmean = (xs) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
const r4 = (x) => +x.toFixed(4);

if (kind === "scaling") {
  const sweeps = readJsonl(join(RESULTS, "sweeps.jsonl")).filter(
    (m) => (!a.sweep || m.sweep === a.sweep) && (!a.tag || m.tag === a.tag),
  );
  if (!sweeps.length)
    throw new Error("no completed sweep matches (scaling.mjs writes sweeps.jsonl at the end)");
  const manifest = sweeps.at(-1);
  const sweep = manifest.sweep;
  const runs = readJsonl(join(RESULTS, "runs.jsonl"))
    .filter((r) => r.sweep === sweep)
    .map((r) => ({ ...loadRun(r.id), rep: r.rep }));
  // the full matrix, exactly once each
  const seen = new Set();
  for (const r of runs) {
    verify(r);
    const key = `${r.binding}\t${r.ncpu}\t${r.rep}`;
    if (seen.has(key)) throw new Error(`sweep ${sweep} has two runs of ${key}`);
    if (r.cpus !== `0-${r.ncpu - 1}` || r.app !== manifest.app)
      throw new Error(`run ${r.id} is not part of sweep ${sweep}'s plan`);
    seen.add(key);
  }
  for (const b of manifest.bindings)
    for (const n of manifest.sizes)
      for (let rep = 0; rep < manifest.reps; rep++)
        if (!seen.has(`${b}\t${n}\t${rep}`))
          throw new Error(`sweep ${sweep} lacks ${b} at ${n} cores, rep ${rep}`);
  if (seen.size !== manifest.bindings.length * manifest.sizes.length * manifest.reps)
    throw new Error(`sweep ${sweep} has runs outside its plan`);
  // per (binding, cores): every rep, and medians over reps
  const groups = new Map();
  for (const r of runs) {
    const k = `${r.binding}\t${r.ncpu}`;
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  const points = [...groups.values()].map((rs) => ({
    binding: rs[0].binding,
    ncpu: rs[0].ncpu,
    reps: rs.length,
    median: Object.fromEntries(
      PHASES.filter((p) => rs.every((r) => r[p])).map((p) => [
        p,
        {
          s: median(rs.map((r) => r[p].s)),
          cores: median(rs.map((r) => r[p].cores)),
          sysShare: median(rs.map((r) => r[p].sysShare)),
        },
      ]),
    ),
    runs: rs.map((r) => ({ rep: r.rep, ...publish(r) })),
  }));
  write({
    ...common,
    sweep,
    tag: manifest.tag,
    app: { name: runs[0].app, appHash: runs[0].appHash, ...app(runs[0].app).shape },
    machine: publicMachine(),
    bindings: bindingsUsed(runs.map((r) => r.binding)),
    points,
  });
} else {
  const want = a.labels ? new Set(a.labels.split(",")) : null;
  const latest = new Map();
  for (const r of readJsonl(join(RESULTS, "ab.jsonl"))) {
    if (want && !want.has(r.label)) continue;
    if (a.tag && r.tag !== a.tag) continue;
    const prev = latest.get(r.label);
    if (prev && (prev.host || "local") !== (r.host || "local"))
      throw new Error(
        `label ${r.label} was measured on two hosts; record it on one (--labels, --host)`,
      );
    latest.set(r.label, r);
  }
  if (want) for (const l of want) if (!latest.has(l)) throw new Error(`no A/B labeled ${l}`);
  const rows = [...latest.values()].map((log) => {
    const { metric = "graph", guardMetric = "turbopack", threshold = 0.04, guard = 0.02 } = log;
    const ids = log.runs.flat();
    if (new Set(ids).size !== ids.length) throw new Error(`A/B ${log.label} repeats a run`);
    const reps = log.runs.map(([ia, ib], i) => {
      const [ra, rb] = [loadRun(ia), loadRun(ib)];
      // lanes swap every rep: A runs on lane 0 in even reps, lane 1 in odd reps
      const [la, lb] = i % 2 ? [log.lanes[1], log.lanes[0]] : log.lanes;
      if (ra.cpus !== la || rb.cpus !== lb)
        throw new Error(`A/B ${log.label}: rep ${i} ran on ${ra.cpus}/${rb.cpus}, not ${la}/${lb}`);
      for (const [r, side] of [
        [ra, log.a],
        [rb, log.b],
      ]) {
        verify(r);
        if (
          r.binding !== side.binding ||
          JSON.stringify(r.env) !== JSON.stringify(side.env) ||
          r.app !== log.app
        )
          throw new Error(
            `A/B ${log.label}: run ${r.id} is not ${side.binding} ${JSON.stringify(side.env)} on ${log.app}`,
          );
      }
      return { a: publish(ra), b: publish(rb) };
    });
    if (reps.length < 2 || reps.length % 2)
      throw new Error(`A/B ${log.label} has ${reps.length} reps`);
    // recompute the verdict from the reps (the log's summary is checked, not trusted)
    const ratios = reps.map((p) => p.b[metric].s / p.a[metric].s);
    const guards = reps.map((p) => p.b[guardMetric].s / p.a[guardMetric].s);
    const ratio = gmean(ratios);
    const guardRatio = gmean(guards);
    const swapRatios = [];
    for (let i = 0; i + 1 < ratios.length; i += 2)
      swapRatios.push(Math.sqrt(ratios[i] * ratios[i + 1]));
    const sameOutput = reps.every((p) => p.a.output.sha === p.b.output.sha);
    const consistent = swapRatios.every((x) => x < 1);
    const win = ratio < 1 - threshold && consistent && guardRatio < 1 + guard && sameOutput;
    if (Math.abs(ratio - log.ratio) > 1e-3 || win !== log.win)
      throw new Error(
        `A/B ${log.label}: recomputed ratio ${ratio} / win ${win} disagree with the log (${log.ratio} / ${log.win})`,
      );
    return {
      label: log.label,
      when: log.when,
      a: log.a,
      b: log.b,
      app: log.app,
      lanes: log.lanes,
      metric,
      guardMetric,
      threshold,
      guard,
      ratio: r4(ratio),
      swapRatios: swapRatios.map(r4),
      guardRatio: r4(guardRatio),
      sameOutput,
      consistent,
      win,
      aMedian: median(reps.map((p) => p.a[metric].s)),
      bMedian: median(reps.map((p) => p.b[metric].s)),
      reps,
    };
  });
  const apps = Object.fromEntries(
    [...new Set(rows.map((r) => r.app))].map((n) => [n, { appHash: app(n).hash, ...app(n).shape }]),
  );
  write({
    ...common,
    machine: publicMachine(),
    apps,
    bindings: bindingsUsed(rows.flatMap((r) => [r.a.binding, r.b.binding])),
    rows,
  });
}

#!/usr/bin/env node
// Persistent-cache drift: how a warm `next build` (Turbopack's filesystem cache restored
// from an earlier build) compares to a cold one as more source files change between the
// two. The second observation of vercel/next.js#98043: a warm rebuild after one changed
// file is fast, after a few hundred it is slower than building with no cache at all.
//
//   node scripts/turbopack-gym/drift.mjs --app drift-monolith --binding base,15+22 --cpus 0-23
//   node scripts/turbopack-gym/drift.mjs --app drift-monolith --edit import
//   node scripts/turbopack-gym/drift.mjs --app drift-quick --points 0,1,10 --reps 1   # smoke
//   node scripts/turbopack-gym/drift.mjs record [--sweep a,b | --tag t]  # -> bench/turbopack-graph-drift.json
//
// The sweep edits the app's source tree, so it refuses the shared apps (monolith, quick):
// generate a copy (scripts/monolith-gen.mjs --out $GYM_ROOT/apps/drift-monolith, then
// `pnpm install --ignore-workspace` in it). For each binding it first builds the pristine
// tree cold into the fixed distDir .next-drift (the cache lives in <distDir>/cache)
// and snapshots that directory (a reflink copy: GYM_ROOT must be on btrfs or xfs).
// Then, rep by rep, for each N in --points:
//   1. edit N feature modules (--edit label: one string literal each; import: that and a
//      new import edge each; see EDITS), files spread over the features first, journaled
//      so an interrupted run restores the tree;
//   2. for every binding and mode, in an order rotated per point:
//      warm  the snapshot restored into the fixed distDir, then a build with the cache on;
//      cold  a fresh distDir with the cache on (the cache starts empty and is written);
//      off   a fresh distDir with the cache off (MONOLITH_TP_FS_CACHE=0);
//   3. restore the tree and check it hashes as before.
// Each build is a bench.mjs run (phases, cores, output fingerprint, machine fields),
// appended to drift.jsonl with its sweep, rep, N, mode and the cache directory's size
// before and after; a completed sweep is appended to drift-sweeps.jsonl. Checks: a warm
// build's output matches the cold build's of the same tree and binding, every binding's
// cold output matches, and an edit changes the cold output. A run whose outputs differ
// keeps both in its run directory and the sweep is marked unclean (record refuses it).
//
// Holds the CPU locks of --cpus for the whole sweep (one build at a time) and a named
// lock on the app (one sweep edits a tree at a time).

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { appTreeHash, bench } from "./bench.mjs";
import {
  APPS,
  REPO,
  RESULTS,
  ROOT,
  RUNS,
  appendJsonl,
  checkAborted,
  ensureDir,
  median,
  parseArgs,
  publishedBinding,
  readJsonl,
  withCpus,
  withLock,
} from "./lib.mjs";

const SHARED_APPS = new Set(["monolith", "quick"]); // setup.mjs owns these
const MODES = ["warm", "cold", "off"];
const MARK = "-drift"; // appended to one label per edited module
const LOG = join(RESULTS, "drift.jsonl");
const SWEEPS = join(RESULTS, "drift-sweeps.jsonl");
const PHASES = ["graph", "entrypoints", "emit", "turbopack", "persistence", "compaction"];
// A binding built from a modified next.js tree (every patched one) is "dirty": without
// this, Turbopack writes its cache to a temporary directory it deletes on the next build,
// so a patched binding would never build warm (db_versioning.rs). Set for every run.
const ENV = { TURBO_ENGINE_IGNORE_DIRTY: "1" };
const CACHE_DISABLED = "File System Cache is disabled";
const WARM_OPTIONAL = ["turbopack-module-graph", "turbopack-write-entrypoints", "turbopack-emit"];

// ---- the edit -------------------------------------------------------------------------

// Every feature module starts its table with `{ id: 0, label: "fNNNmMM-0", w: … }`. Both
// edits append MARK to that label: the label is a string the module's value functions read
// (r.label.length), so the emitted code of every reachable edited module changes.
//   label   only that: the module graph keeps its shape.
//   import  also a new import of a util the module did not import, used by a new export:
//           one new edge per edited module, so the module graph and the analyses over it
//           (binding usage, merged modules, chunk groups) are recomputed.
export const EDITS = ["label", "import"];
const labelOf = (id) => `label: "${id}-0"`;

// The first N targets of one fixed order: pick k takes feature k mod F and module slot
// (floor(k / F) * 7 + k mod F) mod M, so N up to F touches N different features and the
// picks rotate over the lib, client and server tiers.
export function editTargets(app, n) {
  const fdir = join(app, "src", "features");
  const features = readdirSync(fdir)
    .filter((d) => /^f\d+$/.test(d))
    .sort();
  const mods = (f) =>
    readdirSync(join(fdir, f))
      .filter((m) => /^m\d+\.tsx?$/.test(m))
      .sort();
  if (!features.length) throw new Error(`${app} has no feature modules`);
  const M = mods(features[0]).length;
  if (!M) throw new Error(`${app} has no feature modules`);
  if (n > features.length * M)
    throw new Error(`--points: ${n} > ${features.length * M} feature modules in ${app}`);
  const out = [];
  for (let k = 0; k < n; k++) {
    const f = features[k % features.length];
    const list = mods(f);
    if (list.length !== M) throw new Error(`${f} has ${list.length} modules, not ${M}`);
    const mod = list[(Math.floor(k / features.length) * 7 + (k % features.length)) % M];
    const id = `${f}${mod.replace(/\.tsx?$/, "")}`;
    out.push({ k, id, path: join(fdir, f, mod), from: labelOf(id) });
  }
  // the slot stride of 7 revisits slots when 7 divides M: refuse rather than edit fewer
  if (new Set(out.map((t) => t.path)).size !== n)
    throw new Error(`${app}: the pick order repeats a module within ${n} picks (M = ${M})`);
  return out;
}

// The edited text of one target; throws unless the file is as generated.
function editText(text, { k, id, path, from }, kind, utils) {
  if (text.split(from).length !== 2 || text.includes("drift"))
    throw new Error(`${path} is not as generated (an edit left behind?)`);
  let out = text.replace(from, from.slice(0, -1) + MARK + '"');
  if (kind === "import") {
    if (!text.includes(`export const ${id}_TABLE`)) throw new Error(`${path} has no ${id}_TABLE`);
    let j = (k * 37 + 11) % utils.length;
    while (text.includes(`"@/lib/${utils[j]}"`)) j = (j + 1) % utils.length;
    const u = utils[j];
    out +=
      `\nimport { ${u}_fn0 as ${id}_drift_fn } from "@/lib/${u}";\n` +
      `export const ${id}_drift = () => ${id}_drift_fn(${id}_TABLE);\n`;
  }
  return out;
}
const utilsOf = (app) =>
  readdirSync(join(app, "src", "lib"))
    .filter((f) => /^u\d+\.ts$/.test(f))
    .sort()
    .map((f) => f.slice(0, -3));

// Every feature module as generated (editText's checks), nothing carrying a mark.
export function checkPristine(app) {
  const fdir = join(app, "src", "features");
  const utils = utilsOf(app);
  let k = 0;
  for (const f of readdirSync(fdir).filter((d) => /^f\d+$/.test(d))) {
    for (const mod of readdirSync(join(fdir, f)).filter((m) => /^m\d+\.tsx?$/.test(m))) {
      const id = `${f}${mod.replace(/\.tsx?$/, "")}`;
      const path = join(fdir, f, mod);
      editText(
        readFileSync(path, "utf8"),
        { k: k++, id, path, from: labelOf(id) },
        "import",
        utils,
      );
    }
  }
}

// An interrupted sweep leaves its journal (original bytes and timestamps of every edited
// file); the next sweep on the app restores it before anything else.
const journalPath = (appName) => join(ensureDir(join(ROOT, "drift", appName)), "journal.json");
const setTimes = (entries) => {
  // nanosecond timestamps, so a restored file is the snapshot's file to the stat
  const r = spawnSync(
    "python3",
    [
      "-c",
      "import json,os,sys\nfor p,a,m in json.load(sys.stdin): os.utime(p, ns=(int(a), int(m)))",
    ],
    { input: JSON.stringify(entries), encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`restoring timestamps failed: ${r.stderr}`);
};
export function restoreJournal(appName) {
  const p = journalPath(appName);
  if (!existsSync(p)) return 0;
  const files = JSON.parse(readFileSync(p, "utf8"));
  for (const f of files) writeFileSync(f.path, Buffer.from(f.bytes, "base64"));
  setTimes(files.map((f) => [f.path, f.atimeNs, f.mtimeNs]));
  rmSync(p);
  return files.length;
}
export function applyEdits(app, appName, targets, kind) {
  const utils = utilsOf(app);
  const files = targets.map((t) => {
    const bytes = readFileSync(t.path);
    const st = statSync(t.path, { bigint: true });
    return {
      path: t.path,
      edited: editText(bytes.toString("utf8"), t, kind, utils),
      bytes: bytes.toString("base64"),
      atimeNs: String(st.atimeNs),
      mtimeNs: String(st.mtimeNs),
    };
  });
  const p = journalPath(appName);
  writeFileSync(`${p}.tmp`, JSON.stringify(files.map(({ edited, ...f }) => f)));
  renameSync(`${p}.tmp`, p);
  for (const f of files) writeFileSync(f.path, f.edited);
}

// ---- directories ----------------------------------------------------------------------

// One distDir name for every binding (builds run one at a time): the name is in the
// emitted code, so a name of another length shifts source-map columns and the outputs
// of two bindings would not compare.
const DIST = ".next-drift";
const snapOf = (appName, binding) =>
  join(ROOT, "drift", appName, "snap", binding.replace(/[^\w.+-]/g, "_"));
const bytesOf = (dir) =>
  existsSync(dir)
    ? Number(execFileSync("du", ["-sb", dir], { encoding: "utf8" }).split("\t")[0])
    : 0;
// A reflink copy (btrfs, xfs), never a plain one: a plain copy reads and writes every
// cache file, so the restored cache would start in the page cache, and a warm build's
// first reads (what candidates 53 and 55 target) would not be measured. The copy's files
// are new inodes with no cached pages.
function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true });
  ensureDir(dirname(to));
  const r = spawnSync("cp", ["-a", "--reflink=always", from, to], { encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`cp --reflink=always ${from} ${to} (needs btrfs or xfs): ${r.stderr}`);
}

// ---- the sweep ------------------------------------------------------------------------

async function sweep(o) {
  const appName = o.app;
  const app = join(APPS, appName);
  if (SHARED_APPS.has(appName) || appName.includes("/"))
    throw new Error(`--app ${appName}: drift edits the tree; use a copy under $GYM_ROOT/apps`);
  if (!existsSync(join(app, "node_modules", "next")))
    throw new Error(`${app} is not an installed app (monolith-gen.mjs, then pnpm install)`);
  const bindings = o.binding.split(",");
  const modes = o.modes.split(",");
  if (!modes.length || modes.some((m) => !MODES.includes(m)))
    throw new Error(`--modes: a list of ${MODES.join(",")}`);
  const points = o.points.split(",").map(Number);
  if (points.some((n) => !Number.isInteger(n) || n < 0))
    throw new Error("--points: non-negative integers");
  if (points.some((n, i) => i && n <= points[i - 1])) throw new Error("--points: ascending");
  const reps = Number(o.reps);
  if (!Number.isInteger(reps) || reps < 1) throw new Error("--reps: a positive integer");
  const id = `drift-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  if (!EDITS.includes(o.edit)) throw new Error(`--edit: one of ${EDITS.join(", ")}`);
  const plan = {
    sweep: id,
    tag: o.tag || null,
    edit: o.edit,
    app: appName,
    bindings,
    modes,
    points,
    reps,
    cpus: o.cpus,
  };
  console.error(`[drift] ${JSON.stringify(plan)}`);

  await withLock(`drift-${appName}`, () =>
    withCpus(o.cpus, async () => {
      const restored = restoreJournal(appName);
      if (restored) console.error(`[drift] restored ${restored} files from an interrupted sweep`);
      rmSync(join(app, DIST), { recursive: true, force: true });
      checkPristine(app);
      const pristine = appTreeHash(app);
      const log = (rec) => appendJsonl(LOG, { sweep: id, ...rec });
      const run = async ({ env = {}, ...args }) => {
        const rec = await bench({
          cpus: o.cpus,
          app,
          label: "drift",
          env: { ...ENV, ...env },
          ...args,
        });
        if (readFileSync(join(RUNS, rec.id, "build.log"), "utf8").includes(CACHE_DISABLED))
          throw new Error(`run ${rec.id}: Turbopack disabled its filesystem cache`);
        return rec;
      };

      // the warm state per binding: the pristine tree built cold into the fixed distDir
      const seeds = {};
      for (const binding of bindings) {
        const dist = DIST;
        const rec = await run({ binding, distDir: dist, keep: true, label: "drift-seed" });
        const cacheAfter = bytesOf(join(app, dist, "cache"));
        if (!cacheAfter) throw new Error(`${binding}: the seed build wrote no ${dist}/cache`);
        copyTree(join(app, dist), snapOf(appName, binding));
        rmSync(join(app, dist), { recursive: true, force: true });
        if (rec.appHash !== pristine) throw new Error(`seed ${rec.id} built ${rec.appHash}`);
        seeds[binding] = rec.output.sha;
        log({
          id: rec.id,
          rep: -1,
          n: 0,
          mode: "seed",
          binding,
          cacheBefore: 0,
          cacheAfter,
          appHash: rec.appHash,
        });
      }
      if (new Set(Object.values(seeds)).size !== 1)
        throw new Error(`seed outputs differ across bindings: ${JSON.stringify(seeds)}`);

      const mismatches = [];
      let unit = 0;
      for (let rep = 0; rep < reps; rep++) {
        for (const n of points) {
          checkAborted();
          const targets = editTargets(app, n);
          let edited = pristine;
          const outs = {};
          let done = false;
          try {
            applyEdits(app, appName, targets, o.edit);
            edited = appTreeHash(app);
            if (n > 0 && edited === pristine)
              throw new Error(`N=${n}: the edit left the tree hash unchanged`);
            const units = bindings.flatMap((binding) => modes.map((mode) => ({ binding, mode })));
            const shift = unit++ % units.length;
            for (const { binding, mode } of [...units.slice(shift), ...units.slice(0, shift)]) {
              // every mode builds into DIST (see there); its output is then moved
              // into the run's directory until the point's outputs are compared
              const dist = join(app, DIST);
              rmSync(dist, { recursive: true, force: true });
              let cacheBefore = 0;
              if (mode === "warm") {
                copyTree(snapOf(appName, binding), dist);
                // trace files are outputs of the seed build, not cache state
                for (const t of ["trace", "trace-build", "trace-turbopack"])
                  rmSync(join(dist, t), { force: true });
                cacheBefore = bytesOf(join(dist, "cache"));
                if (!cacheBefore) throw new Error(`${binding}: restored snapshot has no cache`);
              }
              const rec = await run({
                binding,
                distDir: DIST,
                keep: true,
                env: mode === "off" ? { MONOLITH_TP_FS_CACHE: "0" } : {},
                // a warm build skips the spans of work its cache already holds
                optional: mode === "warm" ? WARM_OPTIONAL : [],
              });
              // proof the cache was read: an unchanged tree skips the module graph
              if (mode === "warm" && n === 0 && rec.graph)
                throw new Error(
                  `run ${rec.id}: warm build of the unchanged tree rebuilt the graph`,
                );
              const cacheAfter = bytesOf(join(dist, "cache"));
              rec.distDir = join(RUNS, rec.id, "output");
              renameSync(dist, rec.distDir);
              if (rec.appHash !== edited)
                throw new Error(`run ${rec.id} built tree ${rec.appHash}, not ${edited}`);
              outs[`${binding}\t${mode}`] = rec;
              log({
                id: rec.id,
                rep,
                n,
                mode,
                binding,
                cacheBefore,
                cacheAfter,
                appHash: rec.appHash,
                edits: targets.length,
              });
              console.error(
                `[drift] rep ${rep} N=${n} ${binding} ${mode}: wall ${rec.wall}s run-turbopack ${rec.turbopack.s}s graph ${rec.graph?.s ?? "-"}s cache ${(cacheBefore / 2 ** 30).toFixed(2)} -> ${(cacheAfter / 2 ** 30).toFixed(2)} GiB`,
              );
            }
            done = true;
          } finally {
            restoreJournal(appName);
            if (!done)
              for (const rec of Object.values(outs))
                rmSync(rec.distDir, { recursive: true, force: true });
          }
          if (appTreeHash(app) !== pristine) throw new Error(`N=${n}: the tree did not restore`);
          // outputs: warm == cold per binding, cold and off each equal across bindings,
          // and an edit shows in the cold output
          const bad = [];
          const same = (x, y) => x && y && x.output.sha === y.output.sha;
          for (const b of bindings)
            if (
              outs[`${b}\twarm`] &&
              outs[`${b}\tcold`] &&
              !same(outs[`${b}\twarm`], outs[`${b}\tcold`])
            )
              bad.push([outs[`${b}\twarm`], outs[`${b}\tcold`]]);
          for (const m of ["cold", "off", "warm"])
            for (const b of bindings.slice(1))
              if (
                outs[`${bindings[0]}\t${m}`] &&
                outs[`${b}\t${m}`] &&
                !same(outs[`${bindings[0]}\t${m}`], outs[`${b}\t${m}`])
              )
                bad.push([outs[`${bindings[0]}\t${m}`], outs[`${b}\t${m}`]]);
          const cold = outs[`${bindings[0]}\tcold`] || outs[`${bindings[0]}\twarm`];
          if (n > 0 && cold && cold.output.sha === seeds[bindings[0]])
            throw new Error(`N=${n}: the edit did not change the output (${cold.output.sha})`);
          const keep = new Set(bad.flat());
          for (const rec of Object.values(outs)) {
            if (keep.has(rec))
              console.error(`[drift] N=${n}: outputs differ, kept in ${rec.distDir}`);
            else rmSync(rec.distDir, { recursive: true, force: true });
          }
          for (const [x, y] of bad) mismatches.push({ rep, n, runs: [x.id, y.id] });
        }
      }
      appendJsonl(SWEEPS, {
        ...plan,
        seeds,
        pristine,
        mismatches,
        completed: new Date().toISOString(),
      });
      for (const b of bindings) rmSync(snapOf(appName, b), { recursive: true, force: true });
      console.log(JSON.stringify({ sweep: id, mismatches: mismatches.length }));
    }),
  );
}

// ---- the record -----------------------------------------------------------------------

const BINDING_MAP = () =>
  JSON.parse(readFileSync(join(REPO, "bench", "turbopack-gym", "bindings.json"), "utf8"));
const GiB = (b) => +(b / 2 ** 30).toFixed(3);
const pick = (r) => ({
  wall: r.wall,
  cores: r.cores,
  memPeakGiB: r.memPeakGiB,
  ...Object.fromEntries(PHASES.map((p) => [p, r[p]])),
  output: r.output.sha,
});

const LOW = 1.5;
const compileBuckets = (r) =>
  r.timeline.slice(Math.ceil(r.turbopack.at), Math.floor(r.turbopack.at + r.turbopack.s));

// Where a build's wall time goes, from its trace offsets: before run-turbopack (process
// start, config), run-turbopack before emit starts (a warm build's cache restore and
// invalidation have no trace span of their own), emit, and after run-turbopack (cache
// persistence and compaction, process exit).
const SPLIT = {
  startup: (r) => r.turbopack.at,
  preEmit: (r) => (r.emit ? r.emit.at - r.turbopack.at : null),
  afterCompile: (r) => r.wall - r.turbopack.at - r.turbopack.s,
  // 1 s CPU buckets inside run-turbopack under LOW cores, in all and from its start
  lowCoreS: (r) => compileBuckets(r).filter((c) => c < LOW).length,
  leadLowCoreS: (r) => {
    const b = compileBuckets(r);
    const i = b.findIndex((c) => c >= LOW);
    return i < 0 ? b.length : i;
  },
};

// One sweep's runs, verified against its plan, as medians per (N, binding, mode).
function series(plan, check) {
  if (plan.mismatches.length)
    throw new Error(`sweep ${plan.sweep} has ${plan.mismatches.length} output mismatches`);
  const map = BINDING_MAP();
  const runs = readJsonl(LOG)
    .filter((l) => l.sweep === plan.sweep)
    .map((l) => {
      const r = JSON.parse(readFileSync(join(RUNS, l.id, "run.json"), "utf8"));
      const entry = map[r.binding];
      if (
        !entry ||
        r.bindingSource?.head !== entry.head ||
        r.bindingSource?.diffSha256 !== entry.diffSha256
      )
        throw new Error(`run ${r.id}: binding ${r.binding} does not match bindings.json`);
      if (r.cpus !== plan.cpus) throw new Error(`run ${r.id} ran on ${r.cpus}, not ${plan.cpus}`);
      if (l.binding !== r.binding || l.appHash !== r.appHash)
        throw new Error(`run ${r.id}: drift.jsonl's binding or tree is not its run's`);
      if ((l.n === 0) !== (r.appHash === plan.pristine))
        throw new Error(`run ${r.id}: tree hash does not match N=${l.n}`);
      if (r.env.TURBO_ENGINE_IGNORE_DIRTY !== "1")
        throw new Error(`run ${r.id} ran without TURBO_ENGINE_IGNORE_DIRTY`);
      // the mode the log claims is the build that ran: only off turns the cache off,
      // only warm starts from a cache
      if (r.env.MONOLITH_TP_FS_CACHE !== (l.mode === "off" ? "0" : undefined))
        throw new Error(`run ${r.id}: MONOLITH_TP_FS_CACHE does not fit mode ${l.mode}`);
      if ((l.mode === "warm") !== l.cacheBefore > 0)
        throw new Error(`run ${r.id}: cache before the build does not fit mode ${l.mode}`);
      check(r);
      // a warm build has no span for its graph recomputation (at most empty
      // write-entrypoints spans): its graph and entrypoints are unmeasured, not ~0
      if (l.mode === "warm") Object.assign(r, { graph: null, entrypoints: null });
      return { ...l, r };
    });
  // the full plan, exactly once each: a seed per binding, then binding x mode x point x rep
  const key = (b, m, n, rep) => `${b}\t${m}\t${n}\t${rep}`;
  const want = new Set(plan.bindings.map((b) => key(b, "seed", 0, -1)));
  for (const b of plan.bindings)
    for (const m of plan.modes)
      for (const n of plan.points)
        for (let rep = 0; rep < plan.reps; rep++) want.add(key(b, m, n, rep));
  const seen = new Set(runs.map((x) => key(x.binding, x.mode, x.n, x.rep)));
  if (seen.size !== runs.length || seen.size !== want.size || [...want].some((k) => !seen.has(k)))
    throw new Error(
      `sweep ${plan.sweep}: ${runs.length} runs (${seen.size} distinct) are not its plan's ${want.size}`,
    );
  // one tree per N (the edits are deterministic), a different tree for every N
  const trees = new Map();
  for (const x of runs) {
    if ((trees.get(x.n) ?? x.r.appHash) !== x.r.appHash)
      throw new Error(`sweep ${plan.sweep}: N=${x.n} built more than one tree`);
    trees.set(x.n, x.r.appHash);
  }
  if (new Set(trees.values()).size !== trees.size)
    throw new Error(`sweep ${plan.sweep}: two values of N built the same tree`);
  // per binding and N, warm and cold builds give one output and cache-off builds one
  // (not the cold one: a changed build setting changes the output, see TURBOPACK-GRAPH.md)
  const outputs = new Map();
  for (const x of runs.filter((x) => x.mode !== "seed")) {
    const k = `${x.binding}\t${x.n}\t${x.mode === "off" ? "off" : "on"}`;
    if ((outputs.get(k) ?? x.r.output.sha) !== x.r.output.sha)
      throw new Error(`sweep ${plan.sweep}: ${x.binding} N=${x.n} ${x.mode} outputs differ`);
    outputs.set(k, x.r.output.sha);
  }
  const med = (xs, f) => (xs.every((x) => f(x) != null) ? +median(xs.map(f)).toFixed(3) : null);
  const points = plan.points.map((n) => ({
    n,
    ...Object.fromEntries(
      plan.bindings.map((b) => [
        b,
        Object.fromEntries(
          plan.modes.map((m) => {
            const rs = runs.filter((x) => x.n === n && x.binding === b && x.mode === m);
            return [
              m,
              {
                median: {
                  wall: med(rs, (x) => x.r.wall),
                  ...Object.fromEntries(PHASES.map((p) => [p, med(rs, (x) => x.r[p]?.s)])),
                  graphCores: med(rs, (x) => x.r.graph?.cores),
                  ...Object.fromEntries(
                    Object.entries(SPLIT).map(([k, f]) => [k, med(rs, (x) => f(x.r))]),
                  ),
                  cacheBeforeGiB: GiB(median(rs.map((x) => x.cacheBefore))),
                  cacheAfterGiB: GiB(median(rs.map((x) => x.cacheAfter))),
                },
                runs: rs.map((x) => ({
                  rep: x.rep,
                  cacheBefore: x.cacheBefore,
                  cacheAfter: x.cacheAfter,
                  ...pick(x.r),
                })),
              },
            ];
          }),
        ),
      ]),
    ),
  }));
  // crossover: the first N whose median warm time reaches the cold / cache-off median
  const others = plan.modes.includes("warm") ? plan.modes.filter((m) => m !== "warm") : [];
  const crossover = Object.fromEntries(
    plan.bindings.map((b) => [
      b,
      Object.fromEntries(
        ["wall", "turbopack"].flatMap((metric) =>
          others.map((m) => {
            const hit = points.find((p) => p[b].warm.median[metric] >= p[b][m].median[metric]);
            return [`${metric}Vs${m[0].toUpperCase()}${m.slice(1)}`, hit ? hit.n : null];
          }),
        ),
      ),
    ]),
  );
  const seeds = Object.fromEntries(
    plan.bindings.map((b) => {
      const s = runs.find((x) => x.binding === b && x.mode === "seed");
      return [b, { cacheGiB: GiB(s.cacheAfter), ...pick(s.r) }];
    }),
  );
  return { edit: plan.edit, sweep: plan.sweep, seeds, crossover, points };
}

// --sweep a,b: those sweeps; else the latest completed sweep per edit (with --tag, of that tag)
function record(o) {
  const all = readJsonl(SWEEPS).filter((m) => !o.tag || m.tag === o.tag);
  const plans = o.sweep
    ? o.sweep.split(",").map((id) => {
        const m = all.find((x) => x.sweep === id);
        if (!m) throw new Error(`no completed drift sweep ${id}`);
        return m;
      })
    : EDITS.map((e) => all.filter((m) => m.edit === e).at(-1)).filter(Boolean);
  if (!plans.length) throw new Error("no completed drift sweep matches");
  const first = plans[0];
  for (const p of plans)
    for (const k of ["app", "pristine", "cpus", "reps", "bindings", "modes", "points"])
      if (JSON.stringify(p[k]) !== JSON.stringify(first[k]))
        throw new Error(`sweeps ${first.sweep} and ${p.sweep} differ in ${k}`);
  const app = join(APPS, first.app);
  if (appTreeHash(app) !== first.pristine)
    throw new Error(`${first.app} is not the tree the sweeps ran on`);
  let machine;
  const check = (r) => {
    if (!r.machine?.boot) throw new Error(`run ${r.id} has no machine fields`);
    machine ??= r.machine;
    if (JSON.stringify(r.machine) !== JSON.stringify(machine))
      throw new Error(`run ${r.id} ran on a different machine or boot than the record's first run`);
  };
  const out = plans.map((p) => series(p, check));
  const { boot, ...publicMachine } = machine;
  const { out: _, ...shape } = JSON.parse(readFileSync(join(app, "monolith.json"), "utf8"));
  const map = BINDING_MAP();
  const rec = {
    generator:
      "scripts/turbopack-gym/drift.mjs (bench.mjs builds: next build --experimental-build-mode=compile, cpuset-pinned systemd scope, one at a time)",
    bindingBuild:
      "next-napi-bindings from vercel/next.js v16.4.0 (gym/base) plus each binding's patches; cargo --release, CARGO_PROFILE_RELEASE_LTO=false, CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16",
    tag: first.tag,
    note: publicMachine.sharedBox
      ? "shared box: other tenants' processes ran beside these builds (outside their CPU set); compare within this record only"
      : "dedicated box",
    method: {
      warm: "the pristine tree's cold build output directory (with <distDir>/cache) restored, then a build of the edited tree into it, cache on",
      cold: "a fresh output directory, cache on (the cache starts empty and is written)",
      off: "a fresh output directory, Turbopack's persistent cache off (experimental.turbopackFileSystemCacheForBuild false)",
      env: "TURBO_ENGINE_IGNORE_DIRTY=1 for every build: patched bindings are built from a modified tree, and Turbopack otherwise keeps a dirty build's cache in a directory it deletes on the next build",
      edits: {
        label: `N feature modules each get "${MARK}" appended to their first table label (output changes, module graph shape does not)`,
        import:
          "label, plus a new import of a util the module did not import, used by a new export (one new module graph edge per edited module)",
        order: `pick k is feature k mod F, module slot (floor(k/F)*7 + k mod F) mod M (F = ${shape.features ?? "features"}, M = ${shape.featureModules ?? "modules per feature"})`,
      },
      order:
        "per rep, points ascending; within a point every binding x mode, rotated one place per point",
      cacheSize: "du -sb of <distDir>/cache before and after the build",
      split:
        "startup = run-turbopack's start offset; preEmit = emit start - run-turbopack start; afterCompile = wall - run-turbopack end; lowCoreS = whole seconds inside run-turbopack using under 1.5 cores (the scope's cpu.stat), leadLowCoreS = those from its start before the first busier second. A warm build emits no module-graph or write-entrypoints span for its recomputation, so its graph/entrypoints fields are null",
    },
    app: { name: first.app, appHash: first.pristine, ...shape },
    machine: publicMachine,
    cpus: first.cpus,
    reps: first.reps,
    bindings: Object.fromEntries(first.bindings.map((b) => [b, publishedBinding(map, b)])),
    series: out,
  };
  const path = o.out || join(REPO, "bench", "turbopack-graph-drift.json");
  writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${path}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const o = parseArgs(process.argv.slice(2), {
    app: 1,
    binding: 1,
    cpus: 1,
    points: 1,
    reps: 1,
    modes: 1,
    edit: 1,
    tag: 1,
    sweep: 1,
    out: 1,
  });
  if (o._[0] === "record") record(o);
  else if (o._.length) throw new Error(`unknown command ${o._[0]}`);
  else
    await sweep({
      app: o.app || "drift-monolith",
      binding: o.binding || "base,15+22",
      cpus: o.cpus || "0-23",
      points: o.points || "0,1,10,50,100,200,370,600,1000",
      reps: o.reps || "2",
      modes: o.modes || "warm,cold,off",
      edit: o.edit || "label",
      tag: o.tag,
    });
}

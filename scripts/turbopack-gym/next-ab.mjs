#!/usr/bin/env node
// Whole-build A/B of a candidate outside the native binding: bench.mjs builds of an app with
// some of its next/dist files replaced, on one side by Next.js's TypeScript sources as of
// v16.4.0 (base), on the other by those sources with the candidate's patch applied, so the only
// difference between the sides is the patch; or, with --candidate-node, the same app built by
// two node binaries (a Node.js candidate), with or without a patch.
//
//   node scripts/turbopack-gym/next-ab.mjs --patch <candidate.patch> [--app drift-monolith]
//     [--binding base] [--cpus 0-23] [--reps 3] [--modes cold,warm]
//     [--env K=V,...] [--reference-env K=V,...] [--node <node binary>]
//     [--candidate-node <node binary>] [--out <record.json>]
//
// Every file the patch changes must be in bench/turbopack-gym/sources (by file name; its
// README says where each comes from). Both sides are transpiled to CommonJS with the app's own
// typescript and loaded in place of the app's dist files by next-overlay.cjs, preloaded through
// NODE_OPTIONS (which Next.js passes on to its workers). Each build records how many processes
// loaded a replacement, and a build in which none did is an error.
//
// Builds run one at a time on --cpus, under the CPU locks, the sides rotating which goes first
// from rep to rep. cold: a fresh dist directory. warm: the side's own seed restored (a cold
// build of the same tree, its dist directory copied by reflink), then a build; nothing in the
// app changes between the seed and the build.
//
// --env sets environment variables for every side's builds.
//
// Output: every build of a side must have one fingerprint. The candidate's must equal base's,
// or with --reference-env a third side's: base with those environment variables. That is for a
// candidate that changes a default in the config, which is part of the build output: the
// reference is base given, by setting, the value the candidate computes.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { bench } from "./bench.mjs";
import { APPS, REPO, ROOT, ensureDir, publicMachine, median, parseArgs, withCpus } from "./lib.mjs";
import { transpile } from "./route-stats.mjs";

const HOOK = join(dirname(new URL(import.meta.url).pathname), "next-overlay.cjs");
export const SOURCES = join(REPO, "bench", "turbopack-gym", "sources");
export const SOURCES_NEXT = "16.4.0";
const SRC = "packages/next/src/";
const DIST = ".next-ab";
const WARM_OPTIONAL = ["turbopack-module-graph", "turbopack-write-entrypoints", "turbopack-emit"];

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const r2 = (x) => Math.round(x * 100) / 100;

// The files a patch changes, as repository paths under packages/next/src.
export function patchedFiles(text) {
  const files = [...text.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]);
  if (!files.length) throw new Error("the patch changes no file");
  for (const f of files)
    if (!f.startsWith(SRC) || !/\.tsx?$/.test(f))
      throw new Error(`${f}: next-ab.mjs replaces TypeScript sources under ${SRC} only`);
  return files;
}

// Base and candidate builds of every file the patch changes, each mapped to the real path of
// the app's dist file it replaces: { overlays: { base, candidate }, sources }.
export function buildOverlays({ app, patch, work }) {
  const files = patchedFiles(readFileSync(patch, "utf8"));
  const nextDir = dirname(
    realpathSync(createRequire(join(app, "package.json")).resolve("next/package.json")),
  );
  const version = JSON.parse(readFileSync(join(nextDir, "package.json"), "utf8")).version;
  if (version !== SOURCES_NEXT)
    throw new Error(`the app has next ${version}; the sources are from ${SOURCES_NEXT}`);
  const sources = {};
  for (const f of files) {
    const from = join(SOURCES, basename(f));
    if (!existsSync(from)) throw new Error(`${basename(f)} is not in ${SOURCES}`);
    const text = readFileSync(from, "utf8");
    sources[basename(f)] = sha(text);
    for (const side of ["base", "candidate"]) {
      mkdirSync(dirname(join(work, side, f)), { recursive: true });
      writeFileSync(join(work, side, f), text);
    }
  }
  execFileSync("patch", [
    "-p1",
    "--forward",
    "--silent",
    "-d",
    join(work, "candidate"),
    "-i",
    patch,
  ]);
  const overlays = { base: {}, candidate: {} };
  let changed = false;
  files.forEach((f, i) => {
    const target = join(nextDir, "dist", f.slice(SRC.length).replace(/\.tsx?$/, ".js"));
    if (!existsSync(target)) throw new Error(`the app's next has no ${target}`);
    const compiled = {};
    for (const side of ["base", "candidate"]) {
      compiled[side] = transpile(app, readFileSync(join(work, side, f), "utf8"), f);
      overlays[side][target] = join(work, `${side}-${i}.js`);
      writeFileSync(overlays[side][target], compiled[side]);
    }
    changed ||= compiled.base !== compiled.candidate;
  });
  if (!changed) throw new Error("the patch does not change what the sources compile to");
  return { overlays, sources };
}

export const overlayEnv = (overlay, log) => ({
  NODE_OPTIONS: `--require=${HOOK}`,
  GYM_NEXT_OVERLAY: JSON.stringify(overlay),
  GYM_NEXT_OVERLAY_LOG: log,
});

// A reflink copy, as drift.mjs makes: the restored cache starts with no cached pages.
function copyTree(from, to) {
  rmSync(to, { recursive: true, force: true });
  const r = spawnSync("cp", ["-a", "--reflink=always", from, to], { encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`cp --reflink=always ${from} ${to} (needs btrfs or xfs): ${r.stderr}`);
}

export function parseEnvList(s) {
  if (!s) return null;
  return Object.fromEntries(
    s.split(",").map((kv) => {
      const i = kv.indexOf("=");
      if (i < 1) throw new Error(`K=V pairs, comma separated (got ${kv})`);
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
}

export async function nextAb({
  patch,
  node,
  candidateNode,
  app = "drift-monolith",
  binding = "base",
  cpus = "0-23",
  reps = 3,
  modes = ["cold", "warm"],
  env = {},
  referenceEnv = null,
  out,
}) {
  if (!patch && !candidateNode) throw new Error("--patch or --candidate-node is required");
  for (const m of modes) if (!["cold", "warm"].includes(m)) throw new Error(`mode ${m}`);
  if (patch) patch = resolve(patch);
  [node, candidateNode] = [node, candidateNode].map((n) => n && resolve(n));
  const appDir = existsSync(app) ? resolve(app) : join(APPS, app);
  const work = mkdtempSync(join(ensureDir(join(ROOT, "tmp")), "next-ab-"));
  const dist = join(appDir, DIST);
  try {
    const { overlays, sources } = patch
      ? buildOverlays({ app: appDir, patch, work })
      : { overlays: {}, sources: {} };
    const sides = {
      base: { overlay: overlays.base, env, node },
      candidate: { overlay: overlays.candidate, env, node: candidateNode ?? node },
      ...(referenceEnv
        ? { reference: { overlay: overlays.base, env: { ...env, ...referenceEnv }, node } }
        : {}),
    };
    const names = Object.keys(sides);
    const log = join(work, "overlay.log");
    const snap = (side) => join(work, `snap-${side}`);
    const runs = [];
    const build = async (side, mode, rep) => {
      rmSync(dist, { recursive: true, force: true });
      if (mode === "warm") {
        copyTree(snap(side), dist);
        // trace files are outputs of the seed build, not cache state
        for (const t of ["trace", "trace-build", "trace-turbopack"])
          rmSync(join(dist, t), { force: true });
      }
      rmSync(log, { force: true });
      const r = await bench({
        binding,
        app: appDir,
        cpus,
        env: { ...(patch ? overlayEnv(sides[side].overlay, log) : {}), ...sides[side].env },
        node: sides[side].node,
        distDir: DIST,
        keep: mode === "seed",
        label: `next-ab-${side}-${mode}`,
        optional: mode === "warm" ? WARM_OPTIONAL : [],
      });
      const loads = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
      const processes = new Set(loads.map((l) => l.split(" ")[0])).size;
      if (patch && !processes)
        throw new Error(`${side} ${mode}: no process loaded the replacement files`);
      const run = {
        side,
        mode,
        rep,
        id: r.id,
        wall: r.wall,
        turbopack: r.turbopack.s,
        after: r2(r.wall - r.turbopack.s),
        output: r.output.sha,
        node: r.machine.buildNode,
        overlayProcesses: processes,
      };
      if (mode === "seed") {
        copyTree(dist, snap(side));
        rmSync(dist, { recursive: true, force: true });
      } else runs.push(run);
      console.log(
        `[next-ab] rep ${rep} ${mode} ${side}: wall ${run.wall}s run-turbopack ${run.turbopack}s after ${run.after}s, ${processes} processes loaded the overlay, out ${run.output}`,
      );
      return run;
    };

    const seeds = [];
    await withCpus(cpus, async () => {
      if (modes.includes("warm"))
        for (const side of names) seeds.push(await build(side, "seed", -1));
      for (let rep = 0; rep < reps; rep++) {
        const order = [...names.slice(rep % names.length), ...names.slice(0, rep % names.length)];
        for (const mode of modes) for (const side of order) await build(side, mode, rep);
      }
    });

    const outputs = {};
    for (const side of names) {
      const shas = new Set([...seeds, ...runs].filter((r) => r.side === side).map((r) => r.output));
      if (shas.size !== 1)
        throw new Error(`${side}: builds differ in output (${[...shas].join(", ")})`);
      outputs[side] = [...shas][0];
    }
    const against = referenceEnv ? "reference" : "base";
    if (outputs.candidate !== outputs[against])
      throw new Error(
        `the candidate's output ${outputs.candidate} differs from ${against}'s ${outputs[against]}`,
      );

    const medians = {};
    for (const mode of modes) {
      medians[mode] = {};
      for (const side of names) {
        const rs = runs.filter((r) => r.side === side && r.mode === mode);
        medians[mode][side] = {
          wall: median(rs.map((r) => r.wall)),
          turbopack: median(rs.map((r) => r.turbopack)),
          after: median(rs.map((r) => r.after)),
          overlayProcesses: median(rs.map((r) => r.overlayProcesses)),
        };
      }
      medians[mode].ratio =
        Math.round((medians[mode].candidate.wall / medians[mode].base.wall) * 1e4) / 1e4;
    }
    const record = {
      description:
        "whole builds (next build --experimental-build-mode=compile), base against a candidate: a patch to Next.js sources as of v16.4.0 loaded over the app's next/dist files, or another node binary; see scripts/turbopack-gym/next-ab.mjs",
      machine: publicMachine(),
      app: basename(appDir),
      binding,
      cpus,
      reps,
      modes,
      patch: patch ? { file: basename(patch), sha256: sha(readFileSync(patch)) } : null,
      sources,
      nodes: Object.fromEntries(names.map((n) => [n, runs.find((r) => r.side === n).node])),
      env,
      referenceEnv,
      outputs,
      sameOutput: true,
      against,
      median: medians,
      seeds,
      runs,
    };
    if (out) writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    for (const mode of modes)
      console.log(
        `[next-ab] ${mode}: wall ${medians[mode].base.wall}s -> ${medians[mode].candidate.wall}s (x${medians[mode].ratio}), output same as ${against}'s`,
      );
    return record;
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const a = parseArgs(process.argv.slice(2), {
    patch: 1,
    app: 1,
    binding: 1,
    cpus: 1,
    reps: 1,
    modes: 1,
    env: 1,
    "reference-env": 1,
    node: 1,
    "candidate-node": 1,
    out: 1,
  });
  await nextAb({
    patch: a.patch,
    app: a.app,
    binding: a.binding,
    cpus: a.cpus,
    reps: a.reps ? Number(a.reps) : undefined,
    modes: a.modes ? a.modes.split(",") : undefined,
    env: parseEnvList(a.env) ?? undefined,
    referenceEnv: parseEnvList(a["reference-env"]),
    node: a.node,
    candidateNode: a["candidate-node"],
    out: a.out,
  });
}

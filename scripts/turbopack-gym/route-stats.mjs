// Times Next.js's route bundle stats step (`writeRouteBundleStats`, the build's
// `write-route-bundle-stats` span, which runs on the main thread after `run-turbopack`) on one
// build's output: Next.js's own route-bundle-stats.ts against a candidate's version of it.
//
//   node scripts/turbopack-gym/route-stats.mjs --output <a run's output dir> --app <app dir>
//     --patch <candidate patch> [--reps 7] [--cpu 2] [--out <record.json>]
//
// Both sides are transpiled from TypeScript to CommonJS with the app's own `typescript`: base
// from bench/turbopack-gym/sources/route-bundle-stats.ts (the file as of v16.4.0, byte for
// byte) and the candidate from it with --patch applied, so the only difference between them
// is the patch. Each run is a fresh node process on one CPU (held under the CPU
// lock), alternating which side goes first. The output directory is copied once (reflink,
// without its cache) under the dist directory name the build used; every run writes
// diagnostics/route-bundle-stats.json there, and every run's file must equal base's first;
// base's must also equal the build's own file, which checks the inputs the child passes.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import {
  REPO,
  ROOT,
  checkAborted,
  ensureDir,
  median,
  onAbort,
  parseArgs,
  publicMachine,
  withCpus,
} from "./lib.mjs";

const STATS = join("diagnostics", "route-bundle-stats.json");
const CHILD = join(dirname(new URL(import.meta.url).pathname), "route-stats-child.cjs");
const TS_PATH = join("packages", "next", "src", "build", "route-bundle-stats.ts");
export const BASE_TS = join(REPO, "bench", "turbopack-gym", "sources", "route-bundle-stats.ts");

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// One sample: an awaited child process (so the event loop, and with it the SIGINT/SIGTERM
// handlers, keeps running), killed if the run is aborted. Resolves { status, stdout, stderr }.
export function runSample(cmd, args) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    const off = onAbort(() => child.kill("SIGKILL"));
    child.on("error", (e) => {
      off();
      fail(e);
    });
    child.on("close", (status) => {
      off();
      done({
        status,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

export function transpile(app, source, fileName) {
  const ts = createRequire(join(app, "package.json"))("typescript");
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
}

// The dist directory name the build used, from the paths in its own stats file.
function distName(buildStats) {
  const first = buildStats.find((r) => r.firstLoadChunkPaths?.length)?.firstLoadChunkPaths[0];
  if (!first || !first.includes("/static/"))
    throw new Error("cannot tell the build's dist directory name from its stats file");
  return first.slice(0, first.indexOf("/static/"));
}

// The client reference manifests the step reads: how many, and their total size.
function manifestStats(dir) {
  const files = readdirSync(dir, { recursive: true }).filter((f) =>
    f.endsWith("_client-reference-manifest.js"),
  );
  const bytes = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  return { files: files.length, mb: Math.round(bytes / 1e5) / 10 };
}

export async function routeStats({
  output,
  app,
  baseTs = BASE_TS,
  patch,
  reps = 7,
  cpu = "2",
  out,
}) {
  for (const [flag, v] of Object.entries({ output, app, baseTs, patch }))
    if (!v)
      throw new Error(`--${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  // `patch -d` changes directory before it opens the patch, so every path is made absolute
  [output, app, baseTs, patch] = [output, app, baseTs, patch].map((p) => resolve(p));
  const buildStatsText = readFileSync(join(output, STATS), "utf8");
  const work = mkdtempSync(join(ensureDir(join(ROOT, "tmp")), "route-stats-"));
  try {
    // the two sources: base, and base with the patch applied
    const baseSource = readFileSync(baseTs, "utf8");
    const src = (side) => join(work, side, TS_PATH);
    for (const side of ["base", "candidate"]) {
      mkdirSync(dirname(src(side)), { recursive: true });
      writeFileSync(src(side), baseSource);
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
    const compiled = {};
    for (const side of ["base", "candidate"]) {
      compiled[side] = join(work, `${side}.js`);
      writeFileSync(compiled[side], transpile(app, readFileSync(src(side), "utf8"), TS_PATH));
    }
    if (readFileSync(compiled.base, "utf8") === readFileSync(compiled.candidate, "utf8"))
      throw new Error("the patch does not change route-bundle-stats.ts");

    // the build's output under its dist directory name, without the cache
    const project = join(work, "project");
    const dist = join(project, distName(JSON.parse(buildStatsText)));
    mkdirSync(project);
    execFileSync("cp", ["-a", "--reflink=auto", output, dist]);
    rmSync(join(dist, "cache"), { recursive: true, force: true });

    const runs = [];
    let reference = null;
    await withCpus([cpu], async () => {
      for (let rep = 0; rep < reps; rep++) {
        const order = rep % 2 ? ["candidate", "base"] : ["base", "candidate"];
        for (const side of order) {
          checkAborted();
          rmSync(join(dist, STATS), { force: true });
          const r = await runSample("taskset", [
            "-c",
            cpu,
            process.execPath,
            CHILD,
            app,
            compiled[side],
            dist,
            project,
          ]);
          checkAborted();
          if (r.status !== 0)
            throw new Error(`${side} run ${rep} failed: ${r.stderr.slice(-2000)}`);
          const stats = readFileSync(join(dist, STATS), "utf8");
          reference ??= { side, stats };
          if (stats !== reference.stats)
            throw new Error(
              `${side} run ${rep} wrote different route-bundle-stats.json than ${reference.side}'s first`,
            );
          runs.push({ side, rep, ...JSON.parse(r.stdout.trim().split("\n").at(-1)) });
          console.log(`[route-stats] rep ${rep} ${side}: ${runs.at(-1).s}s`);
        }
      }
    });
    const med = (side, f) => median(runs.filter((r) => r.side === side).map((r) => r[f]));
    const record = {
      description:
        "writeRouteBundleStats on one build's output, Next.js's route-bundle-stats.ts against a candidate's, each run a fresh node process on one CPU; see scripts/turbopack-gym/route-stats.mjs",
      machine: publicMachine(),
      app: basename(app),
      cpu,
      reps,
      sources: {
        baseTs: sha(baseSource),
        patch: { file: basename(patch), sha256: sha(readFileSync(patch)) },
      },
      manifests: manifestStats(join(dist, "server", "app")),
      sameOutput: true,
      matchesBuild: reference.stats === buildStatsText,
      median: {
        base: { s: med("base", "s"), cpuS: med("base", "cpuS"), rssMiB: med("base", "rssMiB") },
        candidate: {
          s: med("candidate", "s"),
          cpuS: med("candidate", "cpuS"),
          rssMiB: med("candidate", "rssMiB"),
        },
      },
      runs,
    };
    record.ratio = Math.round((record.median.candidate.s / record.median.base.s) * 1e4) / 1e4;
    if (!record.matchesBuild)
      throw new Error("base's route-bundle-stats.json differs from the build's own");
    if (out) writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    console.log(
      `[route-stats] base ${record.median.base.s}s, candidate ${record.median.candidate.s}s (x${record.ratio}), same output, matches the build`,
    );
    return record;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const a = parseArgs(process.argv.slice(2), {
    output: 1,
    app: 1,
    patch: 1,
    reps: 1,
    cpu: 1,
    out: 1,
  });
  if (a.output && !existsSync(join(a.output, STATS))) throw new Error(`no ${STATS} in ${a.output}`);
  await routeStats({
    output: a.output,
    app: a.app,
    patch: a.patch,
    reps: a.reps ? Number(a.reps) : undefined,
    cpu: a.cpu,
    out: a.out,
  });
}

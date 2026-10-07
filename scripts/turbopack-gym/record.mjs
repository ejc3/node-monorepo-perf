#!/usr/bin/env node
// Turn raw gym logs (bench/raw/turbopack-gym/*.jsonl, gitignored) into the records of
// record that TURBOPACK-GRAPH.md cites.
//
//   node scripts/turbopack-gym/record.mjs scaling   # runs labeled "scale" -> bench/turbopack-graph-scaling.json
//   node scripts/turbopack-gym/record.mjs ab        # A/B verdicts -> bench/turbopack-graph-ab.json
//
// --labels a,b   restrict the ab record to these labels (default: every label, latest
//                verdict per label and host)
//
// Every row carries its machine fields (captured by bench.mjs at run time); a run
// without them is refused rather than guessed. Per-rep numbers for A/B rows come from
// the run directories under $GYM_ROOT/runs, so a record is written on the host whose
// runs it describes (remote A/B rows keep their verdict fields only).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { APPS, REPO, RESULTS, RUNS, parseArgs, readJsonl } from "./lib.mjs";
import { host, runRemote, sync } from "./hosts.mjs";

const argv = process.argv.slice(2);
const a = parseArgs(argv, { labels: 1, host: 1 });
const kind = a._[0];
const OUT = { scaling: "turbopack-graph-scaling.json", ab: "turbopack-graph-ab.json" }[kind];

// --host: write the record on the host whose runs it describes, then copy it back
if (a.host) {
  const h = host(a.host);
  sync(h, []);
  const fwd = argv.filter((x, i) => x !== "--host" && argv[i - 1] !== "--host");
  const { code } = await runRemote(h, "scripts/turbopack-gym/record.mjs", fwd);
  if (code === 0) {
    execFileSync(
      "scp",
      [...h.ssh, `${h.target}:${h.repoDir}/bench/${OUT}`, join(REPO, "bench", OUT)],
      { stdio: "inherit" },
    );
    console.log(`copied bench/${OUT} from ${a.host}`);
  }
  process.exit(code);
}

function appShape(name) {
  const p = join(APPS, name, "monolith.json");
  if (!existsSync(p)) throw new Error(`no ${p}: generate the app first (setup.mjs)`);
  const { out, ...shape } = JSON.parse(readFileSync(p, "utf8"));
  return shape;
}

const phases = (r) => ({
  wall: r.wall,
  cores: r.cores,
  memPeakGB: r.memPeakGB,
  graph: r.graph,
  entrypoints: r.entrypoints,
  emit: r.emit,
  turbopack: r.turbopack,
  persistence: r.persistence,
  outputFiles: r.output?.files,
});

function needMachine(r, what) {
  if (!r.machine)
    throw new Error(`${what} has no machine fields; re-run it with the current bench.mjs`);
  return r.machine;
}

const write = (file, rec) => {
  execFileSync("mkdir", ["-p", join(REPO, "bench")]);
  writeFileSync(join(REPO, "bench", file), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote bench/${file}`);
};

// What each binding name in a record is: vercel/next.js v16.4.0 plus these candidate
// patches (bench/turbopack-gym/bindings.json, checked by hash at record time).
function bindingsUsed(names) {
  const map = JSON.parse(
    readFileSync(join(REPO, "bench", "turbopack-gym", "bindings.json"), "utf8"),
  );
  const out = {};
  for (const n of new Set(names)) {
    if (!map[n])
      throw new Error(`binding "${n}" is not described in bench/turbopack-gym/bindings.json`);
    out[n] = map[n].map((f) => ({
      patch: `bench/turbopack-gym/candidates/${f}`,
      sha256: createHash("sha256")
        .update(readFileSync(join(REPO, "bench", "turbopack-gym", "candidates", f)))
        .digest("hex")
        .slice(0, 16),
    }));
  }
  return out;
}

const common = {
  generator:
    "scripts/turbopack-gym (bench.mjs: next build --experimental-build-mode=compile, cold, cpuset-pinned scope)",
  nextjsSource:
    "vercel/next.js tag v16.4.0, next-napi-bindings built with --release, CARGO_PROFILE_RELEASE_LTO=false, CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16",
};

if (kind === "scaling") {
  const runs = readJsonl(join(RESULTS, "runs.jsonl")).filter((r) => r.label === "scale");
  if (!runs.length) throw new Error("no runs labeled scale in runs.jsonl");
  write("turbopack-graph-scaling.json", {
    ...common,
    bindings: bindingsUsed(runs.map((r) => r.binding)),
    app: appShape("monolith"),
    rows: runs.map((r) => ({
      binding: r.binding,
      ncpu: r.ncpu,
      cpus: r.cpus,
      machine: needMachine(r, `run ${r.id}`),
      when: r.when,
      ...phases(r),
    })),
  });
} else if (kind === "ab") {
  const want = a.labels ? new Set(a.labels.split(",")) : null;
  const latest = new Map();
  for (const r of readJsonl(join(RESULTS, "ab.jsonl"))) {
    if (want && !want.has(r.label)) continue;
    latest.set(`${r.host || "local"}\t${r.label}`, r);
  }
  const rows = [...latest.values()].map((r) => {
    const reps = (r.runs || []).map(([ia, ib]) => {
      const load = (id) => {
        const p = join(RUNS, id, "run.json");
        return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
      };
      const [ra, rb] = [load(ia), load(ib)];
      if (!ra || !rb) return null;
      return { a: { cpus: ra.cpus, ...phases(ra) }, b: { cpus: rb.cpus, ...phases(rb) } };
    });
    const local = reps.every(Boolean) && reps.length;
    const m = local
      ? needMachine(
          JSON.parse(readFileSync(join(RUNS, r.runs[0][0], "run.json"), "utf8")),
          `A/B ${r.label}`,
        )
      : r.machine;
    if (!m)
      throw new Error(
        `A/B ${r.label} (${r.host}) has no machine fields and its runs are not on this host`,
      );
    const { runs, host, ...verdict } = r;
    return { ...verdict, machine: m, reps: local ? reps : undefined };
  });
  write("turbopack-graph-ab.json", {
    ...common,
    bindings: bindingsUsed(rows.flatMap((r) => [r.a.binding, r.b.binding])),
    apps: { monolith: appShape("monolith"), quick: appShape("quick") },
    rows,
  });
} else {
  console.error("usage: record.mjs scaling|ab [--labels a,b]");
  process.exit(1);
}

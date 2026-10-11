#!/usr/bin/env node
// The hill-climbing loop. Each candidate in bench/turbopack-gym/candidates/*.json is evaluated against the
// incumbent with a paired A/B; a winner becomes the new incumbent before the next
// candidate is tried, so later candidates are measured on top of earlier wins.
//
// Candidate file (candidates/<name>.json):
//   { "description": "...", "env": { "K": "V" } }            env-only knob
//   { "description": "...", "patch": "bench/turbopack-gym/candidates/x.patch" }  code change (built here)
//   { "description": "...", "worktree": true }               already edited in worktrees/<name>
//
//   node scripts/turbopack-gym/climb.mjs                    # every pending candidate, in name order
//   node scripts/turbopack-gym/climb.mjs --only a,b --reps 3 --lanes 0-31:32-63
//   node scripts/turbopack-gym/climb.mjs --host bigbox      # A/Bs on another machine (scripts/turbopack-gym/hosts.local.json)
//
// State: bench/turbopack-gym/candidates/<name>.json gets a "result" field once evaluated; the incumbent's
// accepted env is in bench/raw/turbopack-gym/incumbent.json; its code is branch gym/incumbent.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { build, worktreeFor } from "./build.mjs";
import {
  BINDINGS,
  CANDIDATES,
  INCUMBENT,
  NEXTJS,
  REPO,
  RESULTS,
  appendJsonl,
  parseArgs,
  sh,
  withLock,
} from "./lib.mjs";

const o = parseArgs(process.argv.slice(2), {
  only: 1,
  reps: 1,
  lanes: 1,
  app: 1,
  metric: 1,
  threshold: 1,
  "build-jobs": 1,
  smoke: "bool",
  host: 1,
});

// Each A/B runs as `node scripts/turbopack-gym/ab.mjs` so --host can send it to another machine.
function ab({ a, aEnv, b, bEnv, app, reps, metric, threshold, label }) {
  const args = [
    "scripts/turbopack-gym/ab.mjs",
    "--a",
    a,
    "--b",
    b,
    "--app",
    app,
    "--reps",
    String(reps),
    "--metric",
    metric,
    "--threshold",
    String(threshold),
    "--label",
    label,
  ];
  for (const [k, v] of Object.entries(aEnv)) args.push("--a-env", `${k}=${v}`);
  for (const [k, v] of Object.entries(bEnv)) args.push("--b-env", `${k}=${v}`);
  if (o.lanes) args.push("--lanes", o.lanes);
  if (o.host) args.push("--host", o.host);
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, { cwd: REPO, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").at(-1)));
      } catch (e) {
        reject(new Error(`ab.mjs printed no result for ${label}`));
      }
    });
  });
}
const reps = Number(o.reps || 6);

const loadIncumbent = () =>
  existsSync(INCUMBENT) ? JSON.parse(readFileSync(INCUMBENT, "utf8")) : { env: {}, accepted: [] };
// one climb at a time per machine: it moves gym/incumbent, its binding and its state
await withLock("climb", climb);

async function climb() {
  let inc = loadIncumbent();
  if (!existsSync(join(BINDINGS, "incumbent"))) await build("incumbent", { from: "gym/incumbent" });

  const names = readdirSync(CANDIDATES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .filter((n) => !o.only || o.only.split(",").includes(n))
    .sort();

  for (const name of names) {
    const path = join(CANDIDATES, `${name}.json`);
    const cand = JSON.parse(readFileSync(path, "utf8"));
    if (cand.result && !o.only) continue;
    console.error(`\n[climb] ${name}: ${cand.description || ""}`);

    let binding = "incumbent";

    if (cand.patch || cand.worktree) {
      // a worktree made before the incumbent moved must be measured on top of it:
      // commit its edits and rebase onto gym/incumbent first
      const wt = worktreeFor(name);
      const created = existsSync(wt);
      if (created) {
        if (sh("git", ["-C", wt, "status", "--porcelain"]).trim()) {
          sh("git", ["-C", wt, "add", "-A"]);

          sh("git", ["-C", wt, "commit", "-q", "-m", `gym: ${name}\n\n${cand.description || ""}`]);
        }

        try {
          sh("git", ["-C", wt, "rebase", "-q", "gym/incumbent"]);
        } catch (e) {
          sh("git", ["-C", wt, "rebase", "--abort"]);

          cand.result = { status: "rebase-conflict", error: String(e.message).slice(0, 500) };

          writeFileSync(path, JSON.stringify(cand, null, 2) + "\n");

          continue;
        }
      }

      try {
        await build(name, {
          from: "gym/incumbent",
          // a patch is applied once, when its worktree is created
          patches: cand.patch && !created ? [join(REPO, cand.patch)] : [],
          jobs: o["build-jobs"],
        });
        binding = name;
      } catch (e) {
        cand.result = { status: "build-failed", error: String(e.message).slice(0, 500) };
        writeFileSync(path, JSON.stringify(cand, null, 2) + "\n");
        continue;
      }
    }
    const bEnv = { ...inc.env, ...(cand.env || {}) };
    const common = {
      a: "incumbent",
      aEnv: inc.env,
      b: binding,
      bEnv,
      metric: o.metric || "graph",
      threshold: Number(o.threshold || 0.04),
      label: name,
    };
    if (o.smoke || cand.patch || cand.worktree) {
      // cheap gate first: the small app must build with identical output and not regress
      const s = await ab({ ...common, app: "quick", reps: 1 }).catch((e) => ({ error: e }));
      if (s.error) {
        cand.result = { status: "ab-failed", error: String(s.error.message).slice(0, 500) };
        writeFileSync(path, JSON.stringify(cand, null, 2) + "\n");
        continue;
      }
      if (!s.sameOutput || s.ratio > 1.1) {
        cand.result = { status: s.sameOutput ? "smoke-slower" : "output-differs", ratio: s.ratio };
        writeFileSync(path, JSON.stringify(cand, null, 2) + "\n");
        continue;
      }
    }
    const r = await ab({ ...common, app: o.app || "monolith", reps }).catch((e) => ({ error: e }));
    if (r.error) {
      cand.result = { status: "ab-failed", error: String(r.error.message).slice(0, 500) };
      writeFileSync(path, JSON.stringify(cand, null, 2) + "\n");
      continue;
    }
    cand.result = {
      status: r.win ? "accepted" : "rejected",
      ratio: r.ratio,
      guardRatio: r.guardRatio,
      sameOutput: r.sameOutput,
      a: r.aMedian,
      b: r.bMedian,
      when: r.when,
    };
    writeFileSync(path, JSON.stringify(cand, null, 2) + "\n");
    appendJsonl(join(RESULTS, "climb.jsonl"), {
      name,
      ...cand.result,
      description: cand.description,
    });

    if (r.win) {
      inc.env = bEnv;
      if (binding !== "incumbent") {
        // fold the candidate's code into gym/incumbent and rebuild the incumbent binding
        const wt = worktreeFor(name);
        if (sh("git", ["-C", wt, "status", "--porcelain"]).trim()) {
          sh("git", ["-C", wt, "add", "-A"]);
          sh("git", ["-C", wt, "commit", "-q", "-m", `gym: ${name}\n\n${cand.description || ""}`]);
        }
        sh("git", ["-C", NEXTJS, "branch", "-f", "gym/incumbent", `gym/cand/${name}`]);
        if (existsSync(worktreeFor("incumbent")))
          sh("git", ["-C", worktreeFor("incumbent"), "reset", "-q", "--hard", "gym/incumbent"]);
        await build("incumbent", { from: "gym/incumbent" });
      }
      inc.accepted.push({ name, ratio: r.ratio, when: r.when });
      writeFileSync(INCUMBENT, JSON.stringify(inc, null, 2) + "\n");
      console.error(`[climb] ACCEPTED ${name}: x${r.ratio}`);
    }
  }
}

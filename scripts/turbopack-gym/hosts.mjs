// Bench hosts. "local" is this machine; others come from scripts/turbopack-gym/hosts.local.json
// (gitignored: addresses, keys and paths are machine-specific). Example with
// placeholders:
//
//   { "bigbox": { "resolve": "<command printing the address>", "user": "ubuntu",
//                 "key": "~/.ssh/<key>", "root": "/path/to/scratch/turbopack-gym",
//                 "profile": "/path/to/env.sh",
//                 "lanes": ["0-23:24-47", "48-71:72-95", "96-119:120-143", "144-167:168-191"],
//                 "prepare": "<idempotent command run before each sync, e.g. mount scratch>" } }
//
// Keep each lane on one NUMA node: lanes on one box still differ (ab.mjs cancels a
// fixed lane offset by swapping lanes each rep), but a lane spanning nodes is noisy.
//
// `resolve` is a command printing the host's address (boxes that come and go get a
// new IP per launch); `address` can be given instead.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BINDINGS, DEFAULT_LANE_POOL, REPO } from "./lib.mjs";

export const LOCAL_LANES = process.env.GYM_LANE_POOL
  ? process.env.GYM_LANE_POOL.split(",")
  : DEFAULT_LANE_POOL;

export function hosts() {
  const p = join(REPO, "scripts", "turbopack-gym", "hosts.local.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

export function host(name) {
  const h = hosts()[name];
  if (!h)
    throw new Error(`unknown host "${name}" (define it in scripts/turbopack-gym/hosts.local.json)`);
  const address =
    h.address || execFileSync("bash", ["-lc", h.resolve], { encoding: "utf8" }).trim();
  if (!address) throw new Error(`host ${name}: "${h.resolve}" printed no address (is it up?)`);
  const key = h.key?.replace(/^~/, homedir());
  const ssh = [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "ConnectTimeout=10",
    ...(key ? ["-i", key] : []),
  ];
  return {
    name,
    ...h,
    address,
    target: `${h.user || "ubuntu"}@${address}`,
    ssh,
    repoDir: `${h.root}/repo`,
  };
}

function rsync(h, src, dest, extra = []) {
  execFileSync(
    "rsync",
    ["-a", "--delete", ...extra, "-e", `ssh ${h.ssh.join(" ")}`, src, `${h.target}:${dest}`],
    { stdio: "inherit" },
  );
}

// Copy the gym code and the named bindings to the host.
export function sync(h, bindings) {
  // a host's one-time preparation (e.g. mounting its scratch tmpfs), idempotent
  if (h.prepare) execFileSync("ssh", [...h.ssh, h.target, h.prepare], { stdio: "inherit" });
  // only what a remote run needs: the gym scripts, the app generator, the candidates
  execFileSync(
    "ssh",
    [...h.ssh, h.target, `mkdir -p '${h.repoDir}/scripts' '${h.root}/bindings'`],
    {
      stdio: "inherit",
    },
  );
  rsync(h, `${REPO}/scripts/turbopack-gym/`, `${h.repoDir}/scripts/turbopack-gym/`, [
    "--exclude",
    "hosts.local.json",
  ]);
  rsync(h, `${REPO}/scripts/monolith-gen.mjs`, `${h.repoDir}/scripts/monolith-gen.mjs`);
  // the candidate patches and the binding map record.mjs embeds
  execFileSync("ssh", [...h.ssh, h.target, `mkdir -p '${h.repoDir}/bench'`], { stdio: "inherit" });
  rsync(h, `${REPO}/bench/turbopack-gym/`, `${h.repoDir}/bench/turbopack-gym/`);
  for (const b of new Set(bindings)) {
    if (b === "stock") continue;
    rsync(h, `${join(BINDINGS, b)}/`, `${h.root}/bindings/${b}/`);
  }
}

// Run a gym script on the host with its lane pool; stderr streams through, stdout is
// returned (the scripts print one JSON record on stdout).
export function runRemote(h, script, args) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const envs = {
    GYM_ROOT: h.root,
    GYM_RESULTS: `${h.root}/results`,
    GYM_HOST: h.name,
    // the host's own pool; without one it splits its own CPUs (lib.DEFAULT_LANE_POOL)
    ...(h.lanes?.length ? { GYM_LANE_POOL: h.lanes.join(",") } : {}),
  };
  const cmd = [
    h.profile ? `source ${q(h.profile)} &&` : "",
    `cd ${q(h.repoDir)} &&`,
    ...Object.entries(envs).map(([k, v]) => `${k}=${q(v)}`),
    `node ${q(script)} ${args.map(q).join(" ")}`,
  ].join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [...h.ssh, h.target, cmd], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", reject);
  });
}

// argv without "--host <name>" / "--host=<name>", for re-running a script on the host
export function stripHost(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host") i++;
    else if (!argv[i].startsWith("--host=")) out.push(argv[i]);
  }
  return out;
}

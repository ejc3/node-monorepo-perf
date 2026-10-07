// Shared paths and helpers for the Turbopack graph gym (TURBOPACK-GRAPH.md).
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as nodeOs from "node:os";
import { availableParallelism } from "node:os";
const os = () => nodeOs;
import { join, resolve, dirname } from "node:path";

// The repository root (scripts/turbopack-gym/ -> ../..).
export const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
// Disposable state: the next.js clone and its worktrees, cargo target dirs (~15 GB
// each), built bindings, the generated apps, per-run outputs (~100 GB). Required, so it
// never lands on a small root disk by default; a reflink-capable filesystem (btrfs,
// xfs) makes seeding candidate target dirs instant.
if (!process.env.GYM_ROOT) {
  console.error("set GYM_ROOT to a scratch directory with ~100 GB free (see TURBOPACK-GRAPH.md)");
  process.exit(2);
}
export const ROOT = resolve(process.env.GYM_ROOT);
export const NEXTJS = join(ROOT, "next.js");
// CPU locks are per machine, not per GYM_ROOT: two gym roots on one box share its CPUs.
export const LOCKS = process.env.GYM_LOCKS || "/tmp/turbopack-gym-locks";
export const WORKTREES = join(ROOT, "worktrees");
export const TARGETS = join(ROOT, "target");
export const BINDINGS = join(ROOT, "bindings");
export const APPS = join(ROOT, "apps");
export const RUNS = join(ROOT, "runs");
// Raw run/A-B logs (gitignored); records of record are written to bench/ by record.mjs.
export const RESULTS = process.env.GYM_RESULTS || join(REPO, "bench", "raw", "turbopack-gym");
export const CANDIDATES = join(REPO, "bench", "turbopack-gym", "candidates");
export const INCUMBENT = join(RESULTS, "incumbent.json");
export const BINDING_FILE = `next-swc.${process.arch === "arm64" ? "linux-arm64-gnu" : "linux-x64-gnu"}.node`;

export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

export function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split("=", 2);
    if (spec[k] === "bool") out[k] = true;
    else if (spec[k] === "list") (out[k] ||= []).push(inline ?? argv[++i]);
    else if (spec[k]) out[k] = inline ?? argv[++i];
    else throw new Error(`unknown flag --${k}`);
  }
  return out;
}

// "0-31,64-95" -> 64
export function cpuCount(list) {
  return list.split(",").reduce((n, r) => {
    const [a, b] = r.split("-").map(Number);
    return n + (b === undefined ? 1 : b - a + 1);
  }, 0);
}

// Split [first, last] into `n` contiguous lanes of equal size.
export function lanes(n, first = 0, last = NCPU - 1) {
  const size = Math.floor((last - first + 1) / n);
  return Array.from({ length: n }, (_, i) => `${first + i * size}-${first + (i + 1) * size - 1}`);
}

export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function readJsonl(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function appendJsonl(p, rec) {
  ensureDir(dirname(p));
  appendFileSync(p, JSON.stringify(rec) + "\n");
}

// Cross-process locks are directories under LOCKS holding the owner's pid. A lock is
// created whole (a temp dir with the pid file, renamed into place), so no one ever sees
// a lock without its owner. A lock whose owner is gone is moved aside and removed only
// if it still names that dead owner; release removes only a lock this process owns.
function readPid(dir) {
  try {
    return Number(readFileSync(join(dir, "pid"), "utf8"));
  } catch {
    return null;
  }
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
let lockSeq = 0;
function acquireLockDir(path) {
  const tmp = `${path}.tmp-${process.pid}-${lockSeq++}`;
  mkdirSync(tmp);
  writeFileSync(join(tmp, "pid"), String(process.pid));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      renameSync(tmp, path); // fails if path exists (a non-empty directory)
      return true;
    } catch {
      const owner = readPid(path);
      if (owner === null || isAlive(owner)) break;
      const trash = `${path}.stale-${process.pid}-${lockSeq++}`;
      try {
        renameSync(path, trash);
      } catch {
        continue; // someone else moved it
      }
      if (readPid(trash) === owner) rmSync(trash, { recursive: true, force: true });
      else {
        try {
          renameSync(trash, path); // moved a live lock by accident: put it back
        } catch {
          rmSync(trash, { recursive: true, force: true });
        }
      }
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  return false;
}
function releaseLockDir(path) {
  if (readPid(path) !== process.pid) return;
  // move it aside first: emptying it in place would let another process rename its own
  // lock onto the empty directory (rename may replace an empty directory)
  const trash = `${path}.released-${process.pid}-${lockSeq++}`;
  renameSync(path, trash);
  rmSync(trash, { recursive: true, force: true });
}

// Exclusive named lock; given several names, takes whichever is free first and
// passes its name to fn.
export async function withLock(names, fn) {
  const list = Array.isArray(names) ? names : [names];
  const locks = ensureDir(LOCKS);
  let waited = false;
  for (;;) {
    for (const name of list) {
      const dir = join(locks, name);
      if (!acquireLockDir(dir)) continue;
      try {
        return await fn(name);
      } finally {
        releaseLockDir(dir);
      }
    }
    if (!waited) console.error(`[lock] waiting for ${list.join(" | ")}`);
    waited = true;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Default split of this machine: the first two thirds of the CPUs are one lane pair
// for A/B runs, the last third builds bindings. GYM_LANE_POOL / GYM_BUILD_CPUS override.
const NCPU = availableParallelism();
const third = Math.floor(NCPU / 3);
export const DEFAULT_LANE_POOL = [`0-${third - 1}:${third}-${2 * third - 1}`];
export const BUILD_CPUS = process.env.GYM_BUILD_CPUS || `${2 * third}-${NCPU - 1}`;

// What a record needs to say about the machine a run happened on. instanceType comes
// from the EC2 instance metadata service when there is one. sharedBox is a declaration
// (GYM_SHARED_BOX=1 marks a box with other users' processes on it); the repo never
// draws a ratio between a dedicated-box record and a shared-box one.
let machineCache;
export function machine() {
  if (machineCache) return machineCache;
  const { cpus, totalmem, arch } = os();
  let cpuModel = (cpus()[0]?.model || "").replace(/^unknown$/, "");
  try {
    const part = readFileSync("/proc/cpuinfo", "utf8").match(/^CPU part\s*:\s*(\S+)/m);
    if (!cpuModel && part)
      cpuModel =
        { "0xd4f": "Neoverse-V2", "0xd40": "Neoverse-V1", "0xd0c": "Neoverse-N1" }[part[1]] ||
        part[1];
  } catch {}
  let numaNodes = 1;
  try {
    numaNodes =
      readdirSync("/sys/devices/system/node").filter((d) => /^node\d+$/.test(d)).length || 1;
  } catch {}
  let instanceType = null;
  try {
    const curl = (args) =>
      execFileSync("curl", ["-s", "-m", "1", ...args], { encoding: "utf8" }).trim();
    const token = curl([
      "-X",
      "PUT",
      "-H",
      "X-aws-ec2-metadata-token-ttl-seconds: 60",
      "http://169.254.169.254/latest/api/token",
    ]);
    instanceType =
      curl([
        "-H",
        `X-aws-ec2-metadata-token: ${token}`,
        "http://169.254.169.254/latest/meta-data/instance-type",
      ]) || null;
  } catch {}
  machineCache = {
    arch: arch(),
    cpuModel,
    cores: cpus().length,
    numaNodes,
    memGiB: Math.round(totalmem() / 2 ** 30),
    instanceType,
    node: process.version,
    sharedBox: process.env.GYM_SHARED_BOX === "1",
  };
  return machineCache;
}

// Per-CPU locks: a run holds a lock for every CPU it uses, so any two runs whose CPU
// sets overlap exclude each other, whatever lanes they were given. Locks are taken in
// ascending CPU order and all released if one is busy (no deadlock, no partial hold).
export function expandCpus(list) {
  return [
    ...new Set(
      list.split(/[,:]/).flatMap((r) => {
        const [a, b = a] = r.split("-").map(Number);
        return Array.from({ length: b - a + 1 }, (_, i) => a + i);
      }),
    ),
  ].sort((x, y) => x - y);
}

export async function withCpus(choices, fn) {
  const locks = ensureDir(LOCKS);
  const list = Array.isArray(choices) ? choices : [choices];
  let waited = false;
  for (;;) {
    for (const choice of list) {
      const held = [];
      for (const cpu of expandCpus(choice)) {
        const dir = join(locks, `cpu-${cpu}`);
        if (!acquireLockDir(dir)) break;
        held.push(dir);
      }
      if (held.length === expandCpus(choice).length) {
        try {
          return await fn(choice);
        } finally {
          held.forEach(releaseLockDir);
        }
      }
      held.forEach(releaseLockDir);
    }
    if (!waited) console.error(`[lock] waiting for CPUs of ${list.join(" | ")}`);
    waited = true;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

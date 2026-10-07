// Shared paths and helpers for the Turbopack graph gym (TURBOPACK-GRAPH.md).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { availableParallelism, tmpdir } from "node:os";
const os = () => nodeOs;
import { join, resolve, dirname } from "node:path";

// The repository root (scripts/turbopack-gym/ -> ../..).
export const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
// Disposable state: the next.js clone and its worktrees, cargo target dirs (~15 GB
// each), built bindings, the generated apps, per-run outputs. Point GYM_ROOT at a
// large scratch disk.
export const ROOT = process.env.GYM_ROOT || join(tmpdir(), "turbopack-gym");
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

// Cross-process exclusive lock (mkdir is atomic). Stale locks whose holder pid is
// gone are broken. Lets several agents share the bench lanes without overlapping.
// Given several names, takes whichever is free first and passes its name to fn.
export async function withLock(names, fn) {
  const { mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const list = Array.isArray(names) ? names : [names];
  // lane-pair names ("lanes-0-31-32-63") are CPU locks now: route them to withCpus
  const lanePat = /^lanes-(\d+)-(\d+)-(\d+)-(\d+)$/;
  if (list.every((n) => lanePat.test(n))) {
    const toPair = (n) => n.replace(lanePat, "$1-$2:$3-$4");
    return withCpus(list.map(toPair), (pair) => fn(list.find((n) => toPair(n) === pair)));
  }
  const locks = ensureDir(LOCKS);
  const tryTake = (name) => {
    const dir = join(locks, name);
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      return dir;
    } catch {
      try {
        process.kill(Number(readFileSync(join(dir, "pid"), "utf8")), 0);
      } catch (e) {
        if (e.code === "ESRCH" || e.code === "ENOENT") {
          rmSync(dir, { recursive: true, force: true });
          return tryTake(name);
        }
      }
      return null;
    }
  };
  let waited = false;
  for (;;) {
    for (const name of list) {
      const dir = tryTake(name);
      if (!dir) continue;
      try {
        return await fn(name);
      } finally {
        rmSync(dir, { recursive: true, force: true });
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

// What a record needs to say about the machine a run happened on. GYM_SHARED_BOX=1
// marks a box with other users' processes on it (the repo never draws a ratio between
// a dedicated-box record and a shared-box one).
export function machine() {
  const { cpus, totalmem, arch } = os();
  let cpuModel = (cpus()[0]?.model || "").replace(/^unknown$/, "");
  try {
    const parts = readFileSync("/proc/cpuinfo", "utf8").match(/^CPU part\s*:\s*(\S+)/m);
    if (!cpuModel && parts)
      cpuModel =
        { "0xd4f": "Neoverse-V2", "0xd40": "Neoverse-V1", "0xd0c": "Neoverse-N1" }[parts[1]] ||
        parts[1];
  } catch {}
  return {
    arch: arch(),
    cpuModel,
    cores: cpus().length,
    memGB: Math.round(totalmem() / 2 ** 30),
    node: process.version,
    sharedBox: process.env.GYM_SHARED_BOX === "1",
  };
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
  const require_fs = await import("node:fs");
  const { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } = require_fs;
  // GYM_EXTRA_LOCK_DIRS: other lock dirs on this machine (an older gym root's) whose
  // holders must see our locks and whose locks we must honor.
  const dirs = [LOCKS, ...(process.env.GYM_EXTRA_LOCK_DIRS || "").split(":").filter(Boolean)].map(
    ensureDir,
  );
  const list = Array.isArray(choices) ? choices : [choices];
  const alive = (dir) => {
    try {
      process.kill(Number(readFileSync(join(dir, "pid"), "utf8")), 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  };
  const take = (locks, cpu) => {
    const dir = join(locks, `cpu-${cpu}`);
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      return dir;
    } catch {
      if (!alive(dir)) {
        rmSync(dir, { recursive: true, force: true });
        return take(locks, cpu);
      }
      return null;
    }
  };
  // a run from before per-CPU locks holds a "lanes-a-b-c-d" lock: treat its CPUs as busy
  const legacyBusy = () => {
    const busy = new Set();
    for (const locks of dirs) {
      for (const d of readdirSync(locks)) {
        const m = /^lanes-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(d);
        if (m && alive(join(locks, d)))
          for (const c of expandCpus(`${m[1]}-${m[2]},${m[3]}-${m[4]}`)) busy.add(c);
      }
    }
    return busy;
  };
  let waited = false;
  for (;;) {
    const legacy = legacyBusy();
    for (const choice of list) {
      const cpus = expandCpus(choice);
      if (cpus.some((c) => legacy.has(c))) continue;
      const held = [];
      let ok = true;
      for (const cpu of cpus) {
        for (const locks of dirs) {
          const dir = take(locks, cpu);
          if (!dir) {
            ok = false;
            break;
          }
          held.push(dir);
        }
        if (!ok) break;
      }
      if (ok) {
        try {
          return await fn(choice);
        } finally {
          for (const d of held) rmSync(d, { recursive: true, force: true });
        }
      }
      for (const d of held) rmSync(d, { recursive: true, force: true });
    }
    if (!waited) console.error(`[lock] waiting for CPUs of ${list.join(" | ")}`);
    waited = true;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

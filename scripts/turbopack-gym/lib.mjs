// Shared paths and helpers for the Turbopack graph gym (TURBOPACK-GRAPH.md).
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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

// Cross-process locks are fcntl locks on files under LOCKS, held by a small python3
// helper that blocks on its stdin: when the owner releases, exits or is killed, the
// helper's stdin closes, it exits, and the kernel drops its locks. There is no lock a
// dead owner leaves behind, so nothing ever has to decide that a lock is stale. The
// helper takes all of a choice's locks or none.
const LOCK_HELPER = `
import fcntl, os, sys
fds = []
for p in sys.argv[1:]:
    fd = os.open(p, os.O_RDWR | os.O_CREAT, 0o666)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("BUSY", flush=True)
        sys.exit(0)
    fds.append(fd)
print("OK", flush=True)
sys.stdin.read()
`;

// Try to take every lock file in `paths` at once; resolves to a release function, or
// null if any is held.
function tryLockFiles(paths) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", LOCK_HELPER, ...paths], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.on("error", reject);
    child.stdout.on("data", (d) => {
      out += d;
      if (!out.includes("\n")) return;
      if (out.startsWith("OK")) {
        const exited = new Promise((r) => child.on("close", r));
        resolve(async () => {
          child.stdin.end();
          await exited;
        });
      } else resolve(null);
    });
    child.on("close", (code) => {
      if (!out.includes("\n")) reject(new Error(`lock helper exited ${code} without an answer`));
    });
  });
}

// Wait for the first choice whose locks are all free, run fn(choice) holding them.
async function withLockFiles(choices, pathsOf, fn, what) {
  let waited = false;
  for (;;) {
    for (const choice of choices) {
      checkAborted();
      const release = await tryLockFiles(pathsOf(choice));
      if (!release) continue;
      try {
        return await fn(choice);
      } finally {
        await release();
      }
    }
    if (!waited) console.error(`[lock] waiting for ${what(choices)}`);
    waited = true;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Exclusive named lock; given several names, takes whichever is free first and
// passes its name to fn.
export async function withLock(names, fn) {
  const list = Array.isArray(names) ? names : [names];
  const locks = ensureDir(LOCKS);
  return withLockFiles(
    list,
    (n) => [join(locks, `${n}.lock`)],
    fn,
    (l) => l.join(" | "),
  );
}

// SIGINT/SIGTERM: mark the process aborted (lock waits throw, abort hooks stop
// in-flight builds) so every caller's finally runs; a second signal exits at once.
const abortHooks = new Set();
let aborted = null;
export function onAbort(hook) {
  abortHooks.add(hook);
  return () => abortHooks.delete(hook);
}
export function checkAborted() {
  if (aborted) throw new Error(`aborted by ${aborted}`);
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (aborted) process.exit(sig === "SIGINT" ? 130 : 143);
    aborted = sig;
    process.exitCode = sig === "SIGINT" ? 130 : 143;
    console.error(`[gym] ${sig}: stopping in-flight work`);
    for (const h of abortHooks) {
      try {
        h();
      } catch {}
    }
  });
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
    // raw logs only (record.mjs checks it and does not publish it): one boot of one machine
    boot: (() => {
      try {
        return execFileSync("sha256sum", ["/proc/sys/kernel/random/boot_id"], {
          encoding: "utf8",
        }).slice(0, 16);
      } catch {
        return null;
      }
    })(),
  };
  return machineCache;
}

// Per-CPU locks: a run holds a lock for every CPU it uses, so any two runs whose CPU
// sets overlap exclude each other, whatever lanes they were given.
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
  return withLockFiles(
    list,
    (c) => expandCpus(c).map((cpu) => join(locks, `cpu-${cpu}.lock`)),
    fn,
    (l) => `CPUs of ${l.join(" | ")}`,
  );
}

// Shared paths and helpers for the route-planner bench (ROUTE-PLANNER.md).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cpus, totalmem, arch, loadavg } from "node:os";
import { brotliDecompressSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";

// The repository root (scripts/route-planner/ -> ../..) and the bench's subject.
export const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
export const PLANNER = join(REPO, "route-planner");
export const SPEC = JSON.parse(readFileSync(join(PLANNER, "trips.json"), "utf8"));

// Disposable state: the Hermes sources and builds (~2 GB), the cargo target directory, the
// Scriptc library, every engine's per-trip build. Required, so it never lands on a small root
// disk by default.
export function root() {
  if (!process.env.ROUTE_ROOT) {
    console.error("set ROUTE_ROOT to a scratch directory with ~5 GB free (see ROUTE-PLANNER.md)");
    process.exit(2);
  }
  return resolve(process.env.ROUTE_ROOT);
}

/** The pack's JSON text, decompressed, and its hash. */
export function pack() {
  const text = brotliDecompressSync(readFileSync(join(PLANNER, SPEC.pack))).toString("utf8");
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}

/** A trip's plan request as JSON text: what every engine is given (area.ts's planRequest). */
export function planRequest(trip) {
  const r = SPEC.request;
  return JSON.stringify({
    from: trip.from,
    to: trip.to,
    goal: { arriveByMinute: trip.arriveByMinute, ...r.goal },
    runs: r.runs,
    windowMinutes: r.windowMinutes,
    stepMinutes: r.stepMinutes,
  });
}

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// What every engine is built from, under route-planner/: a ROUTE_ROOT built from other sources
// would time old programs against today's TypeScript in Node (whose parity a speed-only change
// keeps), so bench.mjs and fixes.mjs refuse it.
const SOURCES = ["engine", "engine-rs", "native", "hermes", "area.ts", "plan.ts", "package.json", "pnpm-lock.yaml"];

/** One hash over the build's sources: every tracked or untracked, not ignored, file's path and bytes. */
export function sourcesSha256(planner = PLANNER) {
  const files = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", ...SOURCES], {
    cwd: planner,
    encoding: "utf8",
  })
    .split("\0")
    .filter((f) => f && existsSync(join(planner, f)))
    .sort();
  const h = createHash("sha256");
  for (const f of files) h.update(`${f}\0`).update(readFileSync(join(planner, f))).update("\0");
  return h.digest("hex");
}

// Everything built that bench.mjs and fixes.mjs run or load: the Rust probe and WebAssembly
// glue (in engine-rs/pkg/, which every build overwrites), and under ROUTE_ROOT the pack Node,
// Rust and Scriptc load, the Scriptc probe, the Hermes binaries and every trip's programs. build.json records each file's hash.
function builtFiles(root) {
  const files = [];
  const add = (dir) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir, { recursive: true, withFileTypes: true }))
      if (f.isFile()) files.push(join(f.parentPath, f.name));
  };
  add(join(PLANNER, "engine-rs", "pkg"));
  add(join(root, "trips"));
  for (const f of [
    join(root, "pack.json"),
    join(root, "scriptc", "probe"),
    join(root, "hermes", "classic", "bin", "hermes"),
    join(root, "hermes", "v1", "bin", "hermes"),
  ])
    if (existsSync(f)) files.push(f);
  return files.sort();
}

/** Each built file's hash, by its path under the repository or under ROUTE_ROOT. */
export function builtSha256(root) {
  const name = (f) => (f.startsWith(root + "/") ? `ROUTE_ROOT/${f.slice(root.length + 1)}` : f.slice(REPO.length + 1));
  return Object.fromEntries(builtFiles(root).map((f) => [name(f), sha256(readFileSync(f))]));
}

/**
 * Throws unless ROUTE_ROOT's build.json was built from today's pack and sources, and every
 * built file is the one that build wrote: the same set of files, each with the same bytes.
 */
export function checkBuild(build, root) {
  if (pack().sha256 !== build.packSha256) throw new Error("ROUTE_ROOT was built from another area pack: run build.mjs again");
  if (sourcesSha256() !== build.sourcesSha256)
    throw new Error("ROUTE_ROOT was built from other route-planner sources: run build.mjs again");
  const now = builtSha256(root);
  const then = build.builtSha256 ?? {};
  for (const f of new Set([...Object.keys(now), ...Object.keys(then)]))
    if (now[f] !== then[f])
      throw new Error(`${f} is not the file ROUTE_ROOT's build wrote (another build overwrote it?): run build.mjs again`);
}

/** A command's first line of output, or null when it is missing or fails. */
export function version(cmd, args = ["--version"], opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts })
      .trim()
      .split("\n")[0];
  } catch {
    return null;
  }
}

// What a record says about the machine a run happened on: the instance type from the EC2
// instance metadata service, never a host name or address. sharedBox is a declaration
// (ROUTE_SHARED_BOX=1 marks a box with other users' processes on it); nothing measured on a
// shared box is published.
export function machine() {
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
  return {
    arch: arch(),
    cpuModel,
    cores: cpus().length,
    numaNodes,
    memGiB: Math.round(totalmem() / 2 ** 30),
    instanceType,
    node: process.version,
    sharedBox: process.env.ROUTE_SHARED_BOX === "1",
  };
}

/** The 1-minute load average before a run: a record refuses a busy box unless told otherwise. */
export function preRunLoad(limit = 1.5) {
  const load1 = +loadavg()[0].toFixed(2);
  if (load1 > limit && process.env.ROUTE_ALLOW_BUSY !== "1")
    throw new Error(
      `load average ${load1} > ${limit}: something else is running (ROUTE_ALLOW_BUSY=1 overrides)`,
    );
  return load1;
}

/** Within this relative difference two doubles are the same number with a different last bit or two. */
export const LAST_BITS = 1e-12;
/** An answer against Node's: throws on any difference beyond the bounds; counts the last-bit ones. */
export function compare(ref, got, place, key, acc) {
  if (typeof ref === "number" && typeof got === "number") {
    acc.numbers++;
    if (Object.is(ref, got)) return;
    acc.differ++;
    const rel = Math.abs(ref - got) / Math.max(Math.abs(ref), Math.abs(got));
    acc.maxRel = Math.max(acc.maxRel, rel);
    if (key === "line") throw new Error(`${place}: the route differs (${ref} against ${got})`);
    if (!(rel <= LAST_BITS)) throw new Error(`${place}: ${ref} against ${got} (relative ${rel})`);
    return;
  }
  if (Array.isArray(ref) !== Array.isArray(got))
    throw new Error(`${place}: an array against an object`);
  if (Array.isArray(ref) && Array.isArray(got)) {
    if (ref.length !== got.length) throw new Error(`${place}: ${ref.length} items against ${got.length}`);
    ref.forEach((x, i) => compare(x, got[i], `${place}[${i}]`, key, acc));
    return;
  }
  if (ref && got && typeof ref === "object" && typeof got === "object") {
    const a = Object.keys(ref).join(","), b = Object.keys(got).join(",");
    if (a !== b) throw new Error(`${place}: keys ${a} against ${b}`);
    for (const k of Object.keys(ref)) compare(ref[k], got[k], `${place}.${k}`, k, acc);
    return;
  }
  if (ref !== got) throw new Error(`${place}: ${JSON.stringify(ref)} against ${JSON.stringify(got)}`);
}

export const exists = existsSync;

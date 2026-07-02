#!/usr/bin/env node
// Filesystem IOPS comparison: the working-tree filesystem vs the btrfs scratch NVMe.
//
// Companion to fs-bench.mjs. fs-bench measures the WARM relink (store -> node_modules) and finds
// ext4-hardlink vs btrfs-reflink times equal within noise (2.9s vs 3.1s) — because that path is
// buffered (page cache + one flush). This bench measures the layer underneath:
//   - 4k random read/write at queue depth 16 with O_DIRECT (device-level IOPS: no OS page cache;
//     the 1 GiB working set is sized to exceed a small controller cache, though O_DIRECT does not
//     bypass on-device DRAM, so read figures are device+controller, not platter-only)
//   - a small-file burst (5,000 x 512B), the metadata shape a node_modules materialization is:
//     buffered create-only (page cache, what an install actually pays) and a per-file fsync variant
//     (durable, isolated to the target device — no global sync)
// so a doc can state both cases honestly.
//
//   node scripts/fs-iops-bench.mjs
//   FS_TARGETS="home:/home/ubuntu btrfs:/mnt/fcvm-btrfs" node scripts/fs-iops-bench.mjs
//   FS_IOPS_ALLOW_BUSY=1 ...   # override the loaded-box refusal
//
// Requires `fio` and `findmnt`. Each target needs write access under <root> and ~1 GiB free for the
// fio test file (removed on exit). Reads/writes only under a per-run temp dir; cleans up on exit.

import { spawnSync } from "node:child_process";
import {
  rmSync,
  mkdirSync,
  writeFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  existsSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import os from "node:os";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");

// --- prerequisites (fail loud, never silently degrade) -------------------------------------------
const have = (cmd) =>
  spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
for (const cmd of ["fio", "findmnt"]) {
  if (!have(cmd)) throw new Error(`fs-iops-bench requires \`${cmd}\` on PATH`);
}

// --- targets: "label:root label:root"; default = working tree vs the btrfs scratch mount ----------
const TARGETS = (process.env.FS_TARGETS || `home:${os.homedir()} btrfs:/mnt/fcvm-btrfs`)
  .trim()
  .split(/\s+/)
  .map((s) => {
    const i = s.indexOf(":");
    if (i < 1) throw new Error(`FS_TARGETS entry must be "label:root"; got "${s}"`);
    return { label: s.slice(0, i), root: s.slice(i + 1) };
  });

// IO-bound bench: concurrent IO on the same devices biases it, and loadavg is only a coarse proxy
// (it counts runnable + D-state tasks but misses in-flight async/O_DIRECT IO that saturates the device
// queue without blocking a thread), yet it still catches an obviously busy box. Mirror the core-bound
// benches' half-cores refusal; override with FS_IOPS_ALLOW_BUSY=1.
const CORES = os.cpus().length;
const LOAD1 = os.loadavg()[0];
if (LOAD1 > CORES / 2 && process.env.FS_IOPS_ALLOW_BUSY !== "1") {
  throw new Error(
    `1-min load ${LOAD1.toFixed(2)} > ${CORES / 2} (half of ${CORES} cores); IO contention would bias this bench. Set FS_IOPS_ALLOW_BUSY=1 to override.`,
  );
}

// fio knobs (shared across targets so the comparison is like-for-like).
const FIO = { bs: "4k", size: "1G", iodepth: 16, runtimeS: 6 };
const SMALL = { count: 5000, bytes: 512 };

// --- temp-dir lifecycle: clean up every probe dir on exit, even on throw or signal ----------------
const tmpDirs = [];
process.on("exit", () => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130)); // fire the exit handler

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 27, ...opts });

const findmnt = (path, field) => {
  const r = sh("findmnt", ["-no", field, "--target", path]);
  const v = (r.stdout || "").trim();
  // The doc cites exact device names and fstypes; a blank result must fail, not become "unknown".
  if (!v)
    throw new Error(
      `findmnt could not resolve ${field} for ${path} (exit ${r.status}); the device/fstype claims require it`,
    );
  return v;
};

// One fio random-IO run. Prefer libaio (real queue depth); fall back to psync if libaio is absent.
// Throws on a run that neither engine can complete, parse, or that reports an IO error / 0 IOPS — a
// failed or degraded probe never becomes a clean number.
function fioRand(dir, mode) {
  const base = [
    `--name=${mode}`,
    `--directory=${dir}`,
    `--rw=${mode}`,
    `--bs=${FIO.bs}`,
    `--size=${FIO.size}`,
    "--numjobs=1",
    `--runtime=${FIO.runtimeS}`,
    "--time_based",
    "--direct=1",
    "--group_reporting",
    "--output-format=json",
  ];
  let lastErr = "";
  for (const engine of ["libaio", "psync"]) {
    const depth = engine === "libaio" ? FIO.iodepth : 1; // psync is synchronous; depth is moot
    const r = sh("fio", [...base, `--ioengine=${engine}`, `--iodepth=${depth}`]);
    if (r.status !== 0) {
      lastErr = `fio ${mode}/${engine} exit ${r.status}: ${(r.stderr || "").trim().slice(-300)}`;
      continue;
    }
    let j;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      lastErr = `fio ${mode}/${engine}: unparseable JSON`;
      continue;
    }
    const jb = j.jobs && j.jobs[0];
    const o = jb && (mode === "randread" ? jb.read : jb.write);
    if (jb && jb.error) {
      lastErr = `fio ${mode}/${engine}: job error ${jb.error}`;
      continue;
    }
    if (!o || !Number.isFinite(o.iops) || o.iops <= 0) {
      lastErr = `fio ${mode}/${engine}: no positive ${mode} IOPS in output`;
      continue;
    }
    const p99 = o.clat_ns && o.clat_ns.percentile ? o.clat_ns.percentile["99.000000"] : null;
    return {
      engine,
      qd: depth,
      iops: Math.round(o.iops),
      bwMiBs: +(o.bw / 1024).toFixed(1), // fio bw is KiB/s
      p99us: p99 == null ? null : Math.round(p99 / 1000),
    };
  }
  throw new Error(lastErr || `fio ${mode} failed`);
}

// Small-file burst — the metadata shape a node_modules materialization is. Two cases:
//   create: buffered tiny writes through the page cache (what an install actually pays).
//   fsync:  open+write+fsync+close each file — durable, isolated to THIS device (no global sync),
//           i.e. the fsync-barrier throughput (git objects, sqlite, etc.).
function smallFiles(dir) {
  const buf = Buffer.alloc(SMALL.bytes, 0x78);
  const hr = () => Number(process.hrtime.bigint());
  let t0 = hr();
  for (let i = 0; i < SMALL.count; i++) writeFileSync(join(dir, `c${i}`), buf);
  const createMs = (hr() - t0) / 1e6;
  t0 = hr();
  for (let i = 0; i < SMALL.count; i++) {
    const fd = openSync(join(dir, `f${i}`), "w");
    writeSync(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
  }
  const fsyncMs = (hr() - t0) / 1e6;
  return {
    files: SMALL.count,
    bytes: SMALL.bytes,
    createMs: +createMs.toFixed(1),
    createFilesPerSec: Math.round(SMALL.count / (createMs / 1000)),
    fsyncMs: +fsyncMs.toFixed(1),
    fsyncFilesPerSec: Math.round(SMALL.count / (fsyncMs / 1000)),
  };
}

const out = {
  generatedBy: "scripts/fs-iops-bench.mjs",
  measuredAt: new Date().toISOString(),
  host: {
    cores: CORES,
    loadavg1: +LOAD1.toFixed(2),
    kernel: os.release(),
    totalMemGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
  },
  fio: { ...FIO, direct: true },
  smallFiles: { count: SMALL.count, bytes: SMALL.bytes },
  targets: [],
};

for (const { label, root } of TARGETS) {
  if (!existsSync(root)) throw new Error(`target root does not exist: ${root}`);
  const probe = join(root, `.fs-iops-probe.${process.pid}.${label}`);
  rmSync(probe, { recursive: true, force: true });
  mkdirSync(probe, { recursive: true });
  tmpDirs.push(probe);

  const fstype = findmnt(root, "FSTYPE");
  const device = findmnt(root, "SOURCE");
  console.log(`\n# ${label}: ${root}  (${fstype} on ${device})`);

  const randread = fioRand(probe, "randread");
  rmSync(probe, { recursive: true, force: true });
  mkdirSync(probe, { recursive: true });
  const randwrite = fioRand(probe, "randwrite");
  rmSync(probe, { recursive: true, force: true });
  mkdirSync(probe, { recursive: true });
  const sf = smallFiles(probe);

  console.log(
    `  randread  4k qd${randread.qd} (${randread.engine},direct): ${randread.iops.toLocaleString()} IOPS  ${randread.bwMiBs} MiB/s  p99=${randread.p99us}us`,
  );
  console.log(
    `  randwrite 4k qd${randwrite.qd} (${randwrite.engine},direct): ${randwrite.iops.toLocaleString()} IOPS  ${randwrite.bwMiBs} MiB/s  p99=${randwrite.p99us}us`,
  );
  console.log(
    `  small-files ${sf.files}x${sf.bytes}B: create ${sf.createFilesPerSec.toLocaleString()}/s buffered, fsync ${sf.fsyncFilesPerSec.toLocaleString()}/s durable`,
  );

  out.targets.push({ label, root, fstype, device, randread, randwrite, smallFiles: sf });
}

// Like-for-like guard: the IOPS comparison is only valid if every target ran the SAME engine + queue
// depth (a libaio->psync fallback on one mount would compare qd16 against qd1). Mark it rather than
// hide it: only emit ratios when comparable, and warn loudly otherwise.
const engineSet = new Set(
  out.targets.flatMap((t) => [
    `${t.randread.engine}/qd${t.randread.qd}`,
    `${t.randwrite.engine}/qd${t.randwrite.qd}`,
  ]),
);
out.likeForLike = engineSet.size === 1;
if (!out.likeForLike) {
  console.warn(
    `[fs-iops] WARNING: fio engine/qd differed across runs (${[...engineSet].join(", ")}); ratios omitted — the IOPS comparison would not be like-for-like.`,
  );
}

// engineSet.size === 1 also holds if EVERY target fell back to psync/qd1 — internally comparable, but
// the doc's headline cites libaio queue depth 16. So when the headline ratios would be emitted, fail
// rather than publish qd1 numbers under a qd16 claim.
const headlineIsLibaio = out.targets.every(
  (t) =>
    t.randread.engine === "libaio" &&
    t.randwrite.engine === "libaio" &&
    t.randread.qd === FIO.iodepth &&
    t.randwrite.qd === FIO.iodepth,
);
if (out.targets.length === 2 && out.likeForLike && !headlineIsLibaio) {
  throw new Error(
    `fio fell back below libaio/qd${FIO.iodepth} on all targets (${[...engineSet].join(", ")}); the doc's queue-depth-16 headline would be unbacked`,
  );
}

// Distinct-device guard: a two-filesystem comparison is only meaningful if the targets live on
// DIFFERENT devices. If /mnt/fcvm-btrfs is an unmounted leftover dir, findmnt resolves the enclosing
// mount = the same SOURCE as the working tree, fio runs the same workload twice, every ratio
// collapses to ~1.0, and likeForLike passes vacuously. Fail loud before emitting ratios.
if (out.targets.length === 2) {
  const [a, b] = out.targets;
  out.distinctDevices = a.device !== b.device;
  if (!out.distinctDevices) {
    throw new Error(
      `both targets resolve to ${a.device} (${a.fstype}); is ${b.root} actually mounted? a same-device comparison records ratios of ~1.0`,
    );
  }
}

// Ratios between the first two targets (the doc's headline), only when there are exactly two AND the
// runs are comparable. For IOPS/throughput >1 favors the second target; for p99 latency lower is
// better, so a/b is used so that >1 still favors the second target — consistent with the note.
if (out.targets.length === 2 && out.likeForLike) {
  const [a, b] = out.targets;
  const p99 = (x, y) => (x != null && y != null ? +(x / y).toFixed(1) : null);
  out.ratios = {
    note: `${b.label}-over-${a.label}: >1 favors ${b.label} (p99 uses a/b since lower latency is better)`,
    randreadIops: +(b.randread.iops / a.randread.iops).toFixed(1),
    randwriteIops: +(b.randwrite.iops / a.randwrite.iops).toFixed(1),
    smallFileCreate: +(b.smallFiles.createFilesPerSec / a.smallFiles.createFilesPerSec).toFixed(2),
    smallFileFsync: +(b.smallFiles.fsyncFilesPerSec / a.smallFiles.fsyncFilesPerSec).toFixed(2),
    randreadP99: p99(a.randread.p99us, b.randread.p99us),
    randwriteP99: p99(a.randwrite.p99us, b.randwrite.p99us),
  };
}

mkdirSync(join(REPO, "bench"), { recursive: true });
const dest = join(REPO, "bench", "fs-iops-bench.json");
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${dest}`);

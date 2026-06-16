#!/usr/bin/env node
// Compare pnpm install link-time and node_modules footprint across filesystems
// (e.g. ext4 vs btrfs). The FS-sensitive operation is materializing node_modules
// from a WARM store: with `package-import-method: auto` pnpm reflinks (CoW clone)
// on btrfs and hardlinks on ext4. Network fetch is FS-independent, so we warm the
// store first and time only the relink.
//
// Footprint is reported three ways because they diverge on CoW filesystems:
//   - apparent: sum of file sizes (`du -sb`)
//   - du-actual: blocks `du` counts (dedupes hardlinks, NOT reflinks)
//   - btrfs exclusive/shared: from `btrfs filesystem du` (reflink-aware), btrfs only
//
//   node scripts/fs-bench.mjs
//   FS_TARGETS="ext4:/tmp btrfs:/mnt/fcvm-btrfs" node scripts/fs-bench.mjs 300:100
//
// Each target needs ~3.5 TB-free scratch space and write access under <root>.

import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const [a, l] = (process.argv[2] || "300:100").split(":");
const APPS = +a;
const LIBS = +l;
if (!Number.isInteger(APPS) || !Number.isInteger(LIBS) || APPS < 1 || LIBS < 1) {
  throw new Error(`scale must be "<apps>:<libs>" with positive integers; got "${process.argv[2]}"`);
}
// "label:root label:root" — default ext4 (repo's / mount) vs the btrfs mount.
const TARGETS = (process.env.FS_TARGETS || "ext4:/tmp btrfs:/mnt/fcvm-btrfs")
  .trim()
  .split(/\s+/)
  .map((s) => {
    const i = s.indexOf(":");
    if (i < 1) throw new Error(`FS_TARGETS entry must be "label:root"; got "${s}"`);
    return { label: s.slice(0, i), root: s.slice(i + 1) };
  });

const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", TURBO_TELEMETRY_DISABLED: "1" };

// Run a command, throw with stderr tail on non-zero. Returns stdout.
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 27, env, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.code || r.error.message}`);
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")} failed (status ${r.status}):\n${(r.stderr || "").slice(-800)}`,
    );
  return r.stdout || "";
}
// Timed run (ms), same throw-on-failure contract.
function timed(cmd, args, opts = {}) {
  const t0 = process.hrtime.bigint();
  sh(cmd, args, opts);
  return Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
}
// Strict integer from a shell scriptlet under pipefail (rejects non-numeric).
function statInt(script, cwd) {
  const out = sh("bash", ["-c", `set -o pipefail; ${script}`], { cwd }).trim();
  if (!/^\d+$/.test(out)) throw new Error(`stat did not return an integer: "${out}" (${script})`);
  return parseInt(out, 10);
}

const fsType = (path) => sh("findmnt", ["-no", "FSTYPE", "--target", path]).trim() || "unknown";

// Walk up from a package dir resolving a dependency, stopping at the workspace
// root. Mirrors install-bench/axis-bench so a partial install fails loud.
function resolvesFrom(dir, dep, stop) {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, "node_modules", dep, "package.json"))) return true;
    if (d === stop) return false;
    const u = dirname(d);
    if (u === d) return false;
    d = u;
  }
}
function verifyComplete(ws) {
  const missing = [];
  for (const group of ["apps", "packages"]) {
    const gd = join(ws, group);
    if (!existsSync(gd)) continue;
    for (const name of readdirSync(gd)) {
      const pkgDir = join(gd, name);
      const pj = join(pkgDir, "package.json");
      if (!existsSync(pj)) continue;
      const pkg = JSON.parse(readFileSync(pj, "utf8"));
      const deps = [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ];
      for (const dep of deps) {
        if (!resolvesFrom(pkgDir, dep, ws) && missing.length < 20)
          missing.push(`${pkgDir} -> ${dep}`);
      }
    }
  }
  if (missing.length) throw new Error(`INCOMPLETE install:\n${missing.slice(0, 10).join("\n")}`);
}

function setup(ws) {
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  sh(
    "node",
    [
      join(REPO, "scripts/generate.mjs"),
      "--apps",
      String(APPS),
      "--libs",
      String(LIBS),
      "--modules",
      "12",
      "--clean",
    ],
    { cwd: ws },
  );
  for (const dir of ["apps", "packages"]) {
    sh(
      "node",
      [
        join(REPO, "scripts/rewrite-protocols.mjs"),
        "--dir",
        dir,
        "--catalog",
        join(REPO, "pnpm-workspace.yaml"),
      ],
      { cwd: ws },
    );
  }
  writeFileSync(join(ws, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  writeFileSync(
    join(ws, "package.json"),
    JSON.stringify({ name: "fs-bench", private: true }) + "\n",
  );
}

// Detect how pnpm materialized node_modules by inspecting a real file under the
// virtual store: hardlink (shared inode, link count > 1) vs reflink (distinct
// inode, shared extents — confirmed on btrfs via the exclusive-bytes check in the
// caller) vs copy.
function importMethod(ws) {
  // pick a concrete file under the virtual store's package dir. `-print -quit`
  // stops find at the first match with no downstream pipe (no SIGPIPE).
  const pnpmDir = join(ws, "node_modules", ".pnpm");
  const find = sh("bash", [
    "-c",
    `find ${JSON.stringify(pnpmDir)} -type f -name '*.js' -print -quit 2>/dev/null`,
  ]).trim();
  if (!find) return "unknown (no .pnpm files found)";
  const nlinks = parseInt(sh("stat", ["-c", "%h", find]).trim(), 10);
  if (nlinks > 1) return `hardlink (link count ${nlinks})`;
  // single link → reflink or copy. filefrag shows shared flag on reflinked extents.
  const frag = sh("bash", ["-c", `filefrag -v ${JSON.stringify(find)} 2>/dev/null || true`]);
  if (/shared/.test(frag)) return "reflink (CoW, shared extents)";
  return "copy (or reflink not detectable via filefrag)";
}

const out = { apps: APPS, libs: LIBS, targets: [] };
for (const { label, root } of TARGETS) {
  if (!existsSync(root)) {
    console.error(`! skipping ${label}: root ${root} does not exist`);
    continue;
  }
  const base = join(root, `fsbench-${process.pid}`);
  const ws = join(base, "ws");
  const store = join(base, "store");
  const STORE = ["--config.store-dir=" + store, "--config.confirm-modules-purge=false"];
  try {
    rmSync(base, { recursive: true, force: true });
    mkdirSync(store, { recursive: true });
    const fstype = fsType(root);
    console.log(`\n# ${label} (${fstype}) at ${root}`);

    setup(ws);
    // Warm the store (fetch + first materialize). Discarded — network is FS-independent.
    sh("pnpm", ["install", "--config.node-linker=isolated", ...STORE], { cwd: ws });
    verifyComplete(ws);

    // Remove node_modules only (keep store + lockfile), then TIME the warm relink:
    // store -> node_modules materialization, the FS-sensitive operation.
    sh("bash", [
      "-c",
      `set -euo pipefail; find ${JSON.stringify(ws)} -name node_modules -type d -prune -exec rm -rf {} +`,
    ]);
    // --offline proves the timed step is pure store->node_modules materialization,
    // not network (the store was warmed above).
    const relinkMs = timed(
      "pnpm",
      ["install", "--offline", "--config.node-linker=isolated", ...STORE],
      { cwd: ws },
    );
    verifyComplete(ws);

    // Footprint of the root node_modules — its .pnpm virtual store holds all the
    // real files; per-app node_modules are symlinks into it. All three metrics use
    // the SAME path so apparent / du-actual / btrfs-exclusive are comparable.
    const nm = JSON.stringify(join(ws, "node_modules"));
    const apparentBytes = statInt(`du -sb ${nm} | awk '{print $1}'`);
    const duActualBytes = statInt(`du -s --block-size=1 ${nm} | awk '{print $1}'`);

    // btrfs reflink-aware accounting (Exclusive = bytes unique to node_modules, not
    // shared with the store). Fail loud on a btrfs target rather than swallow.
    let btrfsExclusiveBytes = null;
    if (fstype === "btrfs") {
      const du = sh("bash", ["-c", `btrfs filesystem du -s --raw ${nm}`]);
      const m = du.match(/^\s*(\d+)\s+(\d+)/m); // Total Exclusive
      if (!m) throw new Error(`could not parse \`btrfs filesystem du\` output:\n${du}`);
      btrfsExclusiveBytes = parseInt(m[2], 10);
    }

    // Classify how node_modules was materialized. Hardlink: shared inode (link
    // count > 1), detected by importMethod. Reflink: distinct inode but ~all
    // extents shared with the store — on btrfs that is near-zero `btrfs
    // filesystem du` exclusive bytes, which is more reliable than filefrag flags.
    let method = importMethod(ws);
    if (
      fstype === "btrfs" &&
      btrfsExclusiveBytes != null &&
      btrfsExclusiveBytes < apparentBytes * 0.1
    ) {
      method = `reflink (CoW; ${(btrfsExclusiveBytes / 1e6).toFixed(1)}MB exclusive of ${(apparentBytes / 1e6).toFixed(0)}MB apparent → shared with store)`;
    }
    const storeBytes = statInt(`du -sb ${JSON.stringify(store)} | awk '{print $1}'`);

    const rec = {
      label,
      root,
      fstype,
      relinkMs,
      importMethod: method,
      apparentBytes,
      duActualBytes,
      btrfsExclusiveBytes,
      storeBytes,
    };
    out.targets.push(rec);
    console.log(
      `  ${label} (${fstype}): relink ${(relinkMs / 1000).toFixed(1)}s · ${method} · ` +
        `nm apparent ${(apparentBytes / 1e6).toFixed(0)}MB · du-actual ${(duActualBytes / 1e6).toFixed(0)}MB` +
        (btrfsExclusiveBytes != null
          ? ` · btrfs-exclusive ${(btrfsExclusiveBytes / 1e6).toFixed(0)}MB`
          : "") +
        ` · store ${(storeBytes / 1e6).toFixed(0)}MB`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

mkdirSync(join(REPO, "bench"), { recursive: true });
writeFileSync(join(REPO, "bench/fs-bench.json"), JSON.stringify(out, null, 2));
console.log("\n→ bench/fs-bench.json");

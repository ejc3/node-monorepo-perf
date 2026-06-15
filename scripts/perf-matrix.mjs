#!/usr/bin/env node
// Controlled install benchmark to answer: which dependency-spec / linker choices
// actually move install perf? Runs the SAME scale under three variants and
// records install time + lockfile size + node_modules footprint.
//
//   node scripts/perf-matrix.mjs --apps 1000 --libs 200
//
// Variants:
//   baseline   workspace:*        · node-linker=isolated  (the repo default)
//   versioned  workspace:^x.y.z   · node-linker=isolated  (does the spec form / guard cost anything?)
//   hoisted    workspace:*        · node-linker=hoisted   (does the linker matter?)

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const APPS = opt("apps", "1000"),
  LIBS = opt("libs", "200"),
  MODULES = opt("modules", "16");
const ROOT = process.cwd();
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1" };

const VARIANTS = [
  { label: "baseline", versioned: false, linker: "isolated", note: "workspace:* · isolated" },
  { label: "versioned", versioned: true, linker: "isolated", note: "workspace:^x.y.z · isolated" },
  { label: "hoisted", versioned: false, linker: "hoisted", note: "workspace:* · hoisted" },
];

const sh = (cmd) =>
  execSync(cmd, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 30,
    env,
  }).toString();
const num = (script) => {
  // strict full-tree stat: pipefail + reject non-numeric so a failed find/du
  // surfaces instead of silently becoming 0.
  const r = spawnSync("bash", ["-c", `set -o pipefail; ${script}`], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (r.error || r.status !== 0) {
    throw new Error(`stat failed: ${r.error?.message || r.stderr || `status ${r.status}`}`);
  }
  const v = parseInt((r.stdout || "").trim(), 10);
  if (!Number.isFinite(v)) throw new Error(`stat non-numeric from: ${script}`);
  return v;
};

const results = [];
for (const v of VARIANTS) {
  console.log(`\n=== ${v.label} (${v.note}) @ ${APPS} apps / ${LIBS} libs ===`);
  sh(
    `node scripts/generate.mjs --apps ${APPS} --libs ${LIBS} --modules ${MODULES} ${v.versioned ? "--versioned" : ""} --clean`,
  );
  rmSync(join(ROOT, "node_modules"), { recursive: true, force: true });
  rmSync(join(ROOT, "pnpm-lock.yaml"), { force: true });
  const t0 = process.hrtime.bigint();
  sh(`pnpm install --config.node-linker=${v.linker} --config.confirm-modules-purge=false`);
  const installMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const lock = existsSync(join(ROOT, "pnpm-lock.yaml"))
    ? readFileSync(join(ROOT, "pnpm-lock.yaml"))
    : Buffer.from("");
  const rec = {
    label: v.label,
    note: v.note,
    apps: +APPS,
    libs: +LIBS,
    linker: v.linker,
    versioned: v.versioned,
    installMs,
    lockfileBytes: lock.length,
    lockfileLines: lock.toString().split("\n").length,
    nmEntries: num(`find . -path '*/node_modules/*' -printf '.' | wc -c`),
    nmSymlinks: num(`find . -path '*/node_modules/*' -type l -printf '.' | wc -c`),
    nmDiskBytes: num(
      `find . -name node_modules -type d -prune -exec du -sb {} + | awk '{s+=$1} END {print s+0}'`,
    ),
  };
  console.log(
    `  install ${installMs}ms · lockfile ${rec.lockfileLines} lines · nm ${rec.nmEntries} entries (${rec.nmSymlinks} symlinks)`,
  );
  results.push(rec);
}

mkdirSync(join(ROOT, "bench"), { recursive: true });
writeFileSync(join(ROOT, "bench", "perf-matrix.json"), JSON.stringify(results, null, 2));

const base = results[0];
const pct = (a, b) => (b ? ((a - b) / b) * 100 : null);
const fmtPct = (v) => (v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);
console.log("\n=== verdict (delta vs baseline) ===");
for (const r of results) {
  console.log(
    `${r.label.padEnd(10)} install ${String(r.installMs).padStart(7)}ms (${fmtPct(pct(r.installMs, base.installMs))})  nm ${String(r.nmEntries).padStart(8)} (${fmtPct(pct(r.nmEntries, base.nmEntries))})`,
  );
}
console.log("\n→ bench/perf-matrix.json");

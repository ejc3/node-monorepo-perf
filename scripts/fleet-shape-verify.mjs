#!/usr/bin/env node
// Verifies that a generated workspace's dependency-graph shape matches the
// measured production-fleet metric vector behind `--preset fleet` (FLEET.md).
//
//   node scripts/generate.mjs --preset fleet --clean
//   node scripts/fleet-shape-verify.mjs --expect fleet
//
// It recomputes every metric from the generated package.json files on disk —
// not from the generator's own formulas — so a generator regression that
// changes the emitted graph fails here even if the generator "believes" its
// parameters. Without --expect it just prints the metric vector for whatever
// tree is present. With --expect fleet it asserts each metric against the
// measured target within a tolerance and writes bench/fleet-shape.json.
//
// Tolerances are deliberately loose on distribution metrics (the generator is
// a statistical model of the fleet, not a copy) and tight on the exact ones
// (package counts, median fanout, the >50% adoption count).

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const EXPECT = argv.includes("--expect") ? argv[argv.indexOf("--expect") + 1] : null;
if (EXPECT && EXPECT !== "fleet") {
  console.error(`unknown --expect "${EXPECT}" (only: fleet)`);
  process.exit(1);
}

// The measured fleet vector (the design target for --preset fleet), with the
// per-metric tolerance the generated tree must land inside. `pct` tolerances
// are relative; `abs` are absolute.
// Fleet-side context measured alongside the targets (recorded here so FLEET.md's
// divergence notes trace to this JSON; none of these are asserted against the
// generated tree — they describe what the preset deliberately does NOT model).
const FLEET_CONTEXT = {
  presetParams: { modulesPerLib: 13, appModulesPerApp: 28, approxFilesFullScale: 1027360 },
  externalDepUnion: 1430, // distinct external runtime deps across the fleet
  externalDepUnionWithDev: 1710,
  frameworkVersionSplitPct: [73, 25], // two ranges dominate the framework dep
  appsWithLintScriptPct: 98.7, // eslint 9 flat config, near-universal
  appsWithTestScriptPct: 11.7, // vitest where present (300-app sample)
  libsWithTestConfigPct: 36.3, // vitest.config.*/jest.config.* at lib root
  libsPointingMainAtSrc: 421, // of 460: apps consume lib TS source directly
  perAppLockfiles: true, // the fleet is ~30k independent installs today, not one workspace
  libGraphCycles: 3, // small cycles (largest <= 6 nodes) a workspace conversion must break
  duplicatePackageNames: 2, // name collisions a workspace conversion must resolve
};

const FLEET_TARGETS = {
  apps: { v: 30000, abs: 0 },
  libs: { v: 460, abs: 0 },
  appDepsMedian: { v: 14, abs: 1 },
  appDepsP90: { v: 17, abs: 3 },
  closureMedian: { v: 43, pct: 15 },
  closureP25: { v: 41, pct: 15 },
  closureP75: { v: 44, pct: 20 },
  libDepsMean: { v: 1.71, pct: 15 },
  sinkPct: { v: 40.4, abs: 5 },
  depthMax: { v: 15, abs: 0 }, // DEPTH_CAP makes this exact by construction
  depthMedian: { v: 2, abs: 2 },
  covGt50: { v: 13, abs: 2 },
  covGt25: { v: 16, abs: 3 },
  covGt10: { v: 21, abs: 5 },
  libInDegreeTop: { v: 130, pct: 40 },
};

const readPkg = (dir, name) =>
  JSON.parse(readFileSync(join(ROOT, dir, name, "package.json"), "utf8"));
const listDirs = (dir) =>
  existsSync(join(ROOT, dir))
    ? readdirSync(join(ROOT, dir), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    : [];

const libDirs = listDirs("packages");
const appDirs = listDirs("apps");
if (!libDirs.length || !appDirs.length) {
  console.error("no generated tree found (run scripts/generate.mjs first)");
  process.exit(1);
}

// lib graph from disk
const libDeps = new Map(); // pkg name -> [pkg names]
for (const d of libDirs) {
  const pkg = readPkg("packages", d);
  libDeps.set(
    pkg.name,
    Object.keys(pkg.dependencies || {}).filter((k) => k.startsWith("@demo/")),
  );
}
const appDeps = appDirs.map((d) =>
  Object.keys(readPkg("apps", d).dependencies || {}).filter((k) => k.startsWith("@demo/")),
);

// nearest-rank floor(p*n) — the same quantile convention the fleet measurement
// used, so target-vs-generated comparisons are like-for-like.
const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const dist = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    min: s[0],
    p25: q(s, 0.25),
    median: q(s, 0.5),
    mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) / 100,
    p75: q(s, 0.75),
    p90: q(s, 0.9),
    max: s[s.length - 1],
  };
};

// closures + depth over the lib graph (generated graphs are DAGs; the memo's
// in-progress marker still terminates if a cycle ever appears, and the cycle
// check below reports it as a hard failure rather than a wrong number).
const closureMemo = new Map();
const depthMemo = new Map();
let cycles = 0;
function closure(lib) {
  if (closureMemo.has(lib)) return closureMemo.get(lib);
  closureMemo.set(lib, new Set([lib])); // in-progress marker
  const s = new Set([lib]);
  for (const d of libDeps.get(lib) || []) for (const x of closure(d)) s.add(x);
  closureMemo.set(lib, s);
  return s;
}
const inStack = new Set();
function depth(lib) {
  if (depthMemo.has(lib)) return depthMemo.get(lib);
  if (inStack.has(lib)) {
    cycles++; // back-edge: reported as a hard failure below
    return 0;
  }
  inStack.add(lib);
  let r = 0;
  for (const d of libDeps.get(lib) || []) r = Math.max(r, 1 + depth(d));
  inStack.delete(lib);
  depthMemo.set(lib, r);
  return r;
}
for (const lib of libDeps.keys()) depth(lib);

const libDepCounts = [...libDeps.values()].map((d) => d.length);
const appDepCounts = appDeps.map((d) => d.length);
const appClosures = appDeps.map((deps) => {
  const s = new Set();
  for (const d of deps) for (const x of closure(d)) s.add(x);
  return s.size;
});
const coverage = new Map();
for (const deps of appDeps) for (const d of deps) coverage.set(d, (coverage.get(d) || 0) + 1);
const covPct = [...coverage.values()].map((c) => (100 * c) / appDeps.length);
const inDeg = new Map();
for (const deps of libDeps.values()) for (const d of deps) inDeg.set(d, (inDeg.get(d) || 0) + 1);

const generated = {
  apps: appDeps.length,
  libs: libDeps.size,
  appDepsMedian: dist(appDepCounts).median,
  appDepsP90: dist(appDepCounts).p90,
  closureMedian: dist(appClosures).median,
  closureP25: dist(appClosures).p25,
  closureP75: dist(appClosures).p75,
  libDepsMean: dist(libDepCounts).mean,
  sinkPct:
    Math.round(((100 * libDepCounts.filter((c) => c === 0).length) / libDeps.size) * 10) / 10,
  depthMax: Math.max(...depthMemo.values()),
  depthMedian: dist([...depthMemo.values()]).median,
  covGt50: covPct.filter((p) => p > 50).length,
  covGt25: covPct.filter((p) => p > 25).length,
  covGt10: covPct.filter((p) => p > 10).length,
  libInDegreeTop: inDeg.size ? Math.max(...inDeg.values()) : 0,
};
const detail = {
  appDeps: dist(appDepCounts),
  appClosure: dist(appClosures),
  libDeps: dist(libDepCounts),
  libDepth: dist([...depthMemo.values()]),
};

if (cycles > 0) {
  console.error(`generated lib graph contains a cycle (${cycles} back-edges) — must be a DAG`);
  process.exit(1);
}

if (!EXPECT) {
  console.log(JSON.stringify({ generated, detail }, null, 2));
  process.exit(0);
}

let failed = 0;
const rows = [];
for (const [k, t] of Object.entries(FLEET_TARGETS)) {
  const g = generated[k];
  const tol = t.pct != null ? (Math.abs(t.v) * t.pct) / 100 : t.abs;
  const ok = Math.abs(g - t.v) <= tol;
  if (!ok) failed++;
  rows.push(
    `  ${ok ? "ok  " : "FAIL"} ${k.padEnd(16)} target ${String(t.v).padStart(7)}  generated ${String(g).padStart(7)}  (±${tol})`,
  );
}
console.log(`# fleet shape verify: ${appDeps.length} apps / ${libDeps.size} libs`);
console.log(rows.join("\n"));

mkdirSync(join(ROOT, "bench"), { recursive: true });
writeFileSync(
  join(ROOT, "bench/fleet-shape.json"),
  JSON.stringify(
    {
      preset: "fleet",
      targets: Object.fromEntries(Object.entries(FLEET_TARGETS).map(([k, t]) => [k, t.v])),
      generated,
      detail,
      fleetContext: FLEET_CONTEXT,
      pass: failed === 0,
    },
    null,
    2,
  ) + "\n",
);
console.log(`--- bench/fleet-shape.json written (${failed === 0 ? "pass" : `${failed} FAIL`}) ---`);
process.exit(failed === 0 ? 0 : 1);

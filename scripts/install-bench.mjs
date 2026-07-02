#!/usr/bin/env node
// Install benchmark: pnpm (isolated + hoisted) vs bun vs yarn 4 (node-modules + PnP),
// across workspace sizes.
//
//   node scripts/install-bench.mjs                     # canonical "200:100 1000:200 2000:300"
//   node scripts/install-bench.mjs "300:100 1500:300"  # any other scales -> install-bench.partial.json
//
// Robustness (so the benchmark can't quietly cheat):
//   - failures THROW with the install log tail (never swallowed)
//   - child output goes to a log FILE and resource stats to a stats FILE via
//     `/usr/bin/time -v -o`, so nothing is buffered in memory (no ENOBUFS abort
//     misreported as an install failure at large scale)
//   - every install is verified COMPLETE: every app and lib must resolve all
//     its declared deps — in node_modules for the node_modules layouts, via the
//     .pnp.cjs resolver API (mapped back to on-disk zips/dirs) for yarn PnP
//   - layout controlled: pnpm-isolated (pnpm's default), pnpm-hoisted (flat),
//     bun (its own workspace default — the ISOLATED layout since bun 1.3, a
//     node_modules/.bun store; its entry counts sit near pnpm-isolated's),
//     yarn-nm (`nodeLinker: node-modules`, flat — the layout match for
//     pnpm-hoisted), and yarn-pnp (yarn's default — no node_modules; resolution
//     table in .pnp.cjs, packages read from global-cache zips, native packages
//     unplugged)
//   - cold = no lockfile present, full resolve + link against the warm global
//     content store (no network download); warm = lockfile present,
//     node_modules removed, relink only
//   - one truly-cold pass per tool redirects its content store AND registry
//     metadata to a fresh scratch dir (pnpm: --store-dir + --config.cache-dir;
//     bun: BUN_INSTALL_CACHE_DIR; yarn: YARN_GLOBAL_FOLDER), real network, host
//     caches untouched; every fresh dir is asserted populated afterward so a
//     silently-ignored flag/env can't let a metadata-warm number read as cold
//   - host stats: CPU% (cores) and peak RSS per install
//   - results persisted after each scale
//
// bun and yarn ignore pnpm-workspace.yaml and the pnpm catalog: protocol, so we run in
// an isolated per-run temp dir with a decataloged workspace carrying both a
// pnpm-workspace.yaml (read by pnpm) and a package.json "workspaces" field (read by bun
// and yarn) — the same dependency set for all three tools.
//
// Lifecycle scripts: pnpm 10 and yarn 4 block dependency build scripts by default
// (yarn 4.17 `enableScripts` defaults to false; the bench pins it to the same value);
// bun blocks them except for its built-in allowlist.
//
// yarn is the pinned standalone CLI from the @yarnpkg/cli-dist npm tarball, run as
// `node yarn.js` directly (no corepack indirection), so /usr/bin/time measures the
// yarn process itself and the version can't drift with the host.

import { spawnSync } from "node:child_process";
import {
  rmSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  copyFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir, cpus, tmpdir } from "node:os";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
// Per-run temp root: the workspace, the /usr/bin/time stats file, and the install log
// all live under one mkdtemp dir, so two install-bench runs in parallel git worktrees
// (the project's encouraged pattern) can't overwrite each other's workspace config
// (.yarnrc.yml linker flips mid-measurement) or truncate each other's stats/logs.
const RUN_DIR = mkdtempSync(join(tmpdir(), "pm-bench-"));
const DIR = join(RUN_DIR, "ws");
const BUN = join(homedir(), ".bun/bin/bun");
const YARN_VERSION = "4.17.0";
const CORES = cpus().length;
const TIMEFILE = join(RUN_DIR, "time.txt");
const LOGFILE = join(RUN_DIR, "install.log");
// Best-effort cleanup of every temp dir this run created, on any exit path — a thrown
// assertion is this bench's designed failure mode, and a stranded truly-cold store is
// a full workspace's downloaded content (hundreds of MB) per failed run. On a FAILED
// exit the install log is copied out first: the error message embeds only the last
// 1,500 characters, and the context above them is what a post-mortem needs. SIGINT/
// SIGTERM handlers route through process.exit so the 'exit' cleanup actually fires
// when a long run is interrupted (node otherwise dies without emitting 'exit').
const TEMP_DIRS = [RUN_DIR];
process.on("exit", (code) => {
  if (code !== 0 && existsSync(LOGFILE)) {
    const keep = join(tmpdir(), `pm-bench-failed-${process.pid}.log`);
    try {
      copyFileSync(LOGFILE, keep);
      console.error(`install log preserved at ${keep}`);
    } catch {
      /* best-effort */
    }
  }
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
// The canonical scale matrix is the one every doc figure and the comparison chart's
// hard-coded scale keys cite. A run at any other scales only ever writes
// install-bench.partial.json, and even a canonical run persists its per-scale progress
// there, promoting to install-bench.json only on COMPLETION — so neither an exploratory
// run nor a failed canonical run can leave the data of record overwritten/truncated.
const CANONICAL_SCALES = "200:100 1000:200 2000:300";
const SCALES_ARG = (process.argv[2] || CANONICAL_SCALES).trim();
const PROGRESS_JSON = "bench/install-bench.partial.json";
const FINAL_JSON = SCALES_ARG === CANONICAL_SCALES ? "bench/install-bench.json" : PROGRESS_JSON;
const SCALES = SCALES_ARG.split(/\s+/).map((s) => {
  const [a, l] = s.split(":");
  return { apps: +a, libs: +l };
});

function node(args) {
  const r = spawnSync("node", args, { cwd: DIR, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0)
    throw new Error(`node ${args.join(" ")} failed:\n${(r.stderr || "").slice(-1000)}`);
}
// timed install via `/usr/bin/time -v -o STATS`; child output -> LOG file (no
// in-memory buffering). Throws on failure with the log tail. Returns {ms,cpuPct,rssMB}.
// `env`, when given, is the COMPLETE child environment (not merged over process.env) —
// yarn runs pass a scrubbed env, and a merge would silently re-add the ambient YARN_*
// vars the scrub exists to remove.
function timedInstall(cmd, args, env) {
  const logFd = openSync(LOGFILE, "w");
  const t0 = process.hrtime.bigint();
  const r = spawnSync("/usr/bin/time", ["-v", "-o", TIMEFILE, cmd, ...args], {
    cwd: DIR,
    stdio: ["ignore", logFd, logFd],
    ...(env ? { env } : {}),
  });
  closeSync(logFd);
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (r.error) {
    throw new Error(
      `cannot spawn /usr/bin/time (${r.error.code}): ${r.error.message}\n` +
        "the benchmark requires GNU time at /usr/bin/time; install it (e.g. `apt-get install time`).",
    );
  }
  if (r.status !== 0)
    throw new Error(
      `INSTALL FAILED (status ${r.status}): ${cmd} ${args.join(" ")}\n${(existsSync(LOGFILE) ? readFileSync(LOGFILE, "utf8") : "").slice(-1500)}`,
    );
  const stats = existsSync(TIMEFILE) ? readFileSync(TIMEFILE, "utf8") : "";
  const cpu = (stats.match(/Percent of CPU[^:]*:\s*(\d+)/) || [])[1];
  const rss = (stats.match(/Maximum resident set size[^:]*:\s*(\d+)/) || [])[1];
  return { ms, cpuPct: cpu ? +cpu : null, rssMB: rss ? Math.round(+rss / 1024) : null };
}
function entries() {
  // full-tree node_modules footprint: the root virtual store (.pnpm) AND every
  // per-package node_modules. The isolated linker's per-app symlink trees live
  // under apps/*/node_modules, so counting only the root dir undercounts it.
  // pipefail + strict parse so a failed find surfaces instead of becoming 0.
  const r = spawnSync(
    "bash",
    ["-c", "set -o pipefail; find . -path '*/node_modules/*' -printf '.' | wc -c"],
    { cwd: DIR, encoding: "utf8", maxBuffer: 1 << 28 },
  );
  if (r.error || r.status !== 0) {
    throw new Error(
      `node_modules entry count failed: ${r.error?.message || r.stderr || `status ${r.status}`}`,
    );
  }
  const n = parseInt((r.stdout || "").trim(), 10);
  if (!Number.isFinite(n)) throw new Error(`node_modules entry count was non-numeric: ${r.stdout}`);
  return n;
}
// Resolve `dep` from `dir` by walking node_modules upward, STOPPING at the
// benchmark workspace root (DIR) — an ambient /tmp/node_modules or parent
// node_modules must not satisfy verification for an incomplete install.
function resolvesFrom(dir, dep) {
  let d = dir;
  for (;;) {
    if (existsSync(join(d, "node_modules", dep, "package.json"))) return true;
    if (d === DIR) return false;
    const u = dirname(d);
    if (u === d) return false;
    d = u;
  }
}
// Every package under apps/* and packages/* with its declared dependency AND
// devDependency edges (a partial/prod-mode install that dropped typescript/types
// would otherwise pass as "complete"). This is the ONE edge enumeration both
// verifiers consume, so their coverage is identical by construction — a walk bug
// can't make the PnP verifier silently weaker than the node_modules one.
function collectEdges() {
  const edges = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = join(DIR, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, name);
      if (!existsSync(join(pkgDir, "package.json"))) continue;
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      for (const dep of [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ])
        edges.push([pkgDir, dep]);
    }
  }
  // an empty walk would let every verifier pass vacuously — that is a wrong tree,
  // never a verified install
  if (edges.length === 0)
    throw new Error(`collectEdges found no dependency edges under ${DIR} — wrong/missing tree`);
  return edges;
}
function verifyComplete() {
  // Every package must resolve all its declared deps, not just a single sample app.
  const missing = [];
  const edges = collectEdges();
  for (const [pkgDir, dep] of edges) {
    if (!resolvesFrom(pkgDir, dep)) {
      if (missing.length < 20) missing.push(`${pkgDir} -> ${dep}`);
    }
  }
  if (missing.length) {
    throw new Error(`INCOMPLETE install, unresolved deps:\n${missing.slice(0, 10).join("\n")}`);
  }
  return edges.length;
}
// Fetch the pinned yarn 4 standalone CLI from the @yarnpkg/cli-dist npm tarball into a
// per-run temp dir and assert `node yarn.js --version` reports exactly YARN_VERSION —
// a wrong or corrupt CLI must fail here, not produce numbers attributed to 4.x.
function fetchYarn() {
  const dir = mkdtempSync(join(tmpdir(), "pm-bench-yarncli-"));
  TEMP_DIRS.push(dir);
  const pack = spawnSync("npm", ["pack", `@yarnpkg/cli-dist@${YARN_VERSION}`, "--silent"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (pack.error)
    throw new Error(
      `cannot spawn npm (${pack.error.code || pack.error.message}) — npm is required to fetch the pinned yarn CLI`,
    );
  if (pack.status !== 0)
    throw new Error(
      `npm pack @yarnpkg/cli-dist@${YARN_VERSION} failed (status ${pack.status}):\n${(pack.stderr || "").slice(-1000)}`,
    );
  const tgz = (pack.stdout || "").trim().split("\n").pop();
  if (!tgz || !tgz.endsWith(".tgz"))
    throw new Error(
      `npm pack printed no tarball filename (got "${tgz}") — cannot extract the yarn CLI`,
    );
  const tar = spawnSync("tar", ["-xzf", tgz], { cwd: dir, encoding: "utf8" });
  if (tar.error) throw new Error(`cannot spawn tar (${tar.error.code || tar.error.message})`);
  if (tar.status !== 0)
    throw new Error(`extracting ${tgz} failed:\n${(tar.stderr || "").slice(-1000)}`);
  const js = join(dir, "package", "bin", "yarn.js");
  const v = spawnSync("node", [js, "--version"], { cwd: dir, encoding: "utf8" });
  const reported = (v.stdout || "").trim();
  if (v.error || v.status !== 0 || reported !== YARN_VERSION)
    throw new Error(
      `yarn CLI verification failed: expected ${YARN_VERSION}, got "${reported}" (status ${v.status})`,
    );
  return js;
}
// yarn reads only .yarnrc.yml (not .npmrc / pnpm-workspace.yaml) — but ambient YARN_*
// env vars OVERRIDE the project .yarnrc.yml, so every yarn invocation also runs under
// yarnEnv() below. The rc pins every measurement-critical knob explicitly rather than
// trusting defaults: enableImmutableInstalls off (cold runs delete yarn.lock, and yarn
// auto-enables immutable in CI); enableHardenedMode off (yarn 4 auto-enables it — an
// implicit --check-resolutions --refresh-lockfile with per-package registry traffic —
// on public-repo GitHub PR jobs); enableGlobalCache on (its default: zips live in the
// shared global cache, yarn's analogue of the pnpm store — project-local zips would be
// deleted by rmNM and turn every run network-cold); enableScripts false (yarn 4's own
// default, and the same block-dependency-build-scripts posture as pnpm 10's default);
// telemetry off.
const writeYarnRc = (linker) =>
  writeFileSync(
    join(DIR, ".yarnrc.yml"),
    [
      `nodeLinker: ${linker}`,
      "enableTelemetry: false",
      "enableImmutableInstalls: false",
      "enableHardenedMode: false",
      "enableGlobalCache: true",
      "enableScripts: false",
      "",
    ].join("\n"),
  );
// Ambient tool config env silently flips a tool's measured regime: YARN_* overrides even
// an explicit .yarnrc.yml (verified on 4.17: YARN_NODE_LINKER beats the rc), a stray
// BUN_INSTALL_CACHE_DIR redirects bun's cache, and pnpm/bun both read npm_config_* —
// e.g. YARN_ENABLE_GLOBAL_CACHE=false would make every yarn run network-cold while
// pnpm/bun stay warm-store, with nothing throwing. Every timed install therefore runs
// under an env stripped of its tool's config vars, plus only the overrides the bench
// itself sets. (File-based config — .npmrc, .yarnrc.yml — is controlled by the bench's
// per-run workspace dir instead.)
const scrubEnv = (prefixes, overrides) => ({
  ...Object.fromEntries(
    // case-insensitive: npm-config env handling accepts NPM_CONFIG_* as well as
    // npm_config_*, so an uppercase ambient var must not slip through the scrub
    Object.entries(process.env).filter(
      ([k]) => !prefixes.some((p) => k.toUpperCase().startsWith(p.toUpperCase())),
    ),
  ),
  ...overrides,
});
const yarnEnv = (overrides) => scrubEnv(["YARN_"], overrides);
const bunEnv = (overrides) => scrubEnv(["BUN_", "npm_config_"], overrides);
const pnpmEnv = (overrides) => scrubEnv(["PNPM_", "npm_config_"], overrides);
// PnP has no per-package node_modules to walk — resolution is a table in .pnp.cjs. Verify
// completeness through that table in a child node process: every edge from collectEdges()
// (the same list the node_modules verifier checks) must resolve via resolveToUnqualified,
// and the resolved location — mapped back through resolveVirtual, since peer-dep packages
// resolve to __virtual__ paths that never exist literally on disk — must be an on-disk,
// non-empty zip or a workspace dir. A dangling table entry (zip missing or truncated to
// zero bytes) therefore fails verification, same as a missing node_modules dir would for
// the other layouts. The edge list rides on STDIN: at 2,000 apps it is ~1.5 MB of JSON,
// past Linux's 128 KB per-argument limit, so it can't be embedded in the -e script.
function verifyCompletePnp() {
  const pnpFile = join(DIR, ".pnp.cjs");
  if (!existsSync(pnpFile)) throw new Error("PnP install left no .pnp.cjs — nothing to verify");
  const edges = collectEdges();
  const script = `
    const { existsSync, statSync, readFileSync } = require("fs");
    const pnp = require(${JSON.stringify(pnpFile)});
    const edges = JSON.parse(readFileSync(0, "utf8"));
    const missing = [];
    for (const [pkgDir, dep] of edges) {
      try {
        const loc = pnp.resolveToUnqualified(dep, pkgDir + "/");
        // null = Node builtin name (considerBuiltins) — nothing installed to verify, so
        // fail closed with a message naming the cause rather than a bare null deref
        if (loc === null) throw new Error("resolved to null (Node-builtin name?)");
        const phys =
          typeof pnp.resolveVirtual === "function" ? pnp.resolveVirtual(loc) || loc : loc;
        const zi = phys.indexOf(".zip/");
        const target = zi === -1 ? phys : phys.slice(0, zi + 4);
        if (!existsSync(target)) throw new Error("resolved target missing on disk: " + target);
        if (zi !== -1 && statSync(target).size === 0)
          throw new Error("cache zip is empty: " + target);
      } catch (e) {
        if (missing.length < 20)
          missing.push(pkgDir + " -> " + dep + " (" + String(e.message || e).slice(0, 120) + ")");
      }
    }
    if (missing.length) {
      console.error(missing.slice(0, 10).join("\\n"));
      process.exit(1);
    }
    console.log("EDGES " + edges.length);
  `;
  const r = spawnSync("node", ["-e", script], {
    cwd: DIR,
    encoding: "utf8",
    input: JSON.stringify(edges),
    maxBuffer: 1 << 26,
  });
  if (r.error)
    throw new Error(
      `PnP verifier child failed to run (${r.error.code || r.error.message}) — a harness fault, not a yarn result`,
    );
  if (r.status !== 0)
    throw new Error(
      `INCOMPLETE PnP install, unresolved deps:\n${((r.stderr || "") + (r.stdout || "")).slice(-1500)}`,
    );
  const m = (r.stdout || "").match(/EDGES (\d+)/);
  if (!m || +m[1] !== edges.length)
    throw new Error(
      `PnP verifier checked ${m ? m[1] : "no"} edges, expected ${edges.length}:\n${((r.stdout || "") + (r.stderr || "")).slice(-500)}`,
    );
  return edges.length;
}
function setup(apps, libs) {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  node([
    join(REPO, "scripts/generate.mjs"),
    "--apps",
    String(apps),
    "--libs",
    String(libs),
    "--modules",
    "12",
    "--clean",
  ]);
  node([
    join(REPO, "scripts/rewrite-protocols.mjs"),
    "--dir",
    "apps",
    "--catalog",
    join(REPO, "pnpm-workspace.yaml"),
  ]);
  node([
    join(REPO, "scripts/rewrite-protocols.mjs"),
    "--dir",
    "packages",
    "--catalog",
    join(REPO, "pnpm-workspace.yaml"),
  ]);
  writeFileSync(join(DIR, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  writeFileSync(
    join(DIR, "package.json"),
    JSON.stringify({ name: "pm-bench", private: true, workspaces: ["apps/*", "packages/*"] }) +
      "\n",
  );
}
// Remove EVERY manager's project-local materialized state: the root virtual store and
// every per-package node_modules (the isolated linker symlinks apps/*/node_modules and
// packages/*/node_modules; leaving them lets a later linker/manager reuse stale links
// and time a partial no-op), plus yarn's out-of-node_modules state — the .pnp.* runtime
// files and .yarn/ (install-state.gz resolution memo, unplugged native packages). One
// helper clears all of it so no reset site can forget a manager's piece — a surviving
// install-state.gz would make a "cold" yarn run silently warm-fast, the exact
// failure-reads-as-success class this bench guards against. "Warm = lockfile + global
// cache only" holds for every tool. (yarn's global zip cache is NOT under .yarn/:
// enableGlobalCache is pinned on.)
const rmNM = () => {
  const r = spawnSync(
    "bash",
    ["-c", "find . -name node_modules -type d -prune -exec rm -rf {} +"],
    {
      cwd: DIR,
      encoding: "utf8",
    },
  );
  if (r.error || r.status !== 0) {
    throw new Error(
      `node_modules cleanup failed (a stale tree would let the next install time a no-op): ${r.error?.message || r.stderr || `status ${r.status}`}`,
    );
  }
  for (const f of [".pnp.cjs", ".pnp.data.json", ".pnp.loader.mjs"])
    rmSync(join(DIR, f), { force: true });
  rmSync(join(DIR, ".yarn"), { recursive: true, force: true });
};
const rmLocks = () => {
  for (const f of ["pnpm-lock.yaml", "bun.lock", "bun.lockb", "yarn.lock"])
    rmSync(join(DIR, f), { force: true });
};
const PI = ["install", "--config.confirm-modules-purge=false"];

const out = {
  hostCores: CORES,
  yarnVersion: YARN_VERSION,
  // single samples measured in this fixed order within every scale — recorded so an
  // order effect (page cache, thermals) is at least attributable, not invisible
  perScaleOrder: ["pnpmIsolated", "pnpmHoisted", "bun", "yarnNm", "yarnPnp"],
  scales: [],
  trulyCold: null,
};
const persist = () => writeFileSync(join(REPO, PROGRESS_JSON), JSON.stringify(out, null, 2));
const promote = () => {
  writeFileSync(join(REPO, FINAL_JSON), JSON.stringify(out, null, 2));
  if (FINAL_JSON !== PROGRESS_JSON) rmSync(join(REPO, PROGRESS_JSON), { force: true });
};

console.log(`host: ${CORES} cores`);
const YARNJS = fetchYarn();
console.log(`yarn ${YARN_VERSION} standalone CLI: ${YARNJS}`);
// pre-warm the global content store so every per-scale "cold" (no lockfile) is a
// genuine warm-store install (no network), as documented — not a cache-order
// artifact of whichever scale ran first. The truly-cold pass below uses its own
// fresh --store-dir to measure the network-cold case.
setup(SCALES[0].apps, SCALES[0].libs);
timedInstall("pnpm", [...PI, "--config.node-linker=isolated"], pnpmEnv()); // warm pnpm store (discard)
rmNM();
rmLocks();
timedInstall(BUN, ["install"], bunEnv()); // warm bun cache (discard)
rmNM();
rmLocks();
writeYarnRc("node-modules");
timedInstall("node", [YARNJS, "install"], yarnEnv()); // warm yarn global cache (discard; PnP shares it)

for (const { apps, libs } of SCALES) {
  setup(apps, libs);

  rmNM();
  rmLocks();
  const piC = timedInstall("pnpm", [...PI, "--config.node-linker=isolated"], pnpmEnv());
  const depEdgesVerified = verifyComplete();
  const piNm = entries();
  rmNM();
  const piW = timedInstall("pnpm", [...PI, "--config.node-linker=isolated"], pnpmEnv());
  verifyComplete();

  rmNM();
  rmLocks();
  const phC = timedInstall("pnpm", [...PI, "--config.node-linker=hoisted"], pnpmEnv());
  verifyComplete();
  const phNm = entries();
  rmNM();
  const phW = timedInstall("pnpm", [...PI, "--config.node-linker=hoisted"], pnpmEnv());
  verifyComplete();

  rmNM();
  rmLocks();
  const bC = timedInstall(BUN, ["install"], bunEnv());
  verifyComplete();
  const bNm = entries();
  rmNM();
  const bW = timedInstall(BUN, ["install"], bunEnv());
  verifyComplete();

  // yarn, node-modules linker (flat — the layout match for pnpm-hoisted)
  writeYarnRc("node-modules");
  rmNM();
  rmLocks();
  const ynC = timedInstall("node", [YARNJS, "install"], yarnEnv());
  verifyComplete();
  const ynNm = entries();
  rmNM();
  const ynW = timedInstall("node", [YARNJS, "install"], yarnEnv());
  verifyComplete();

  // yarn, PnP linker (yarn's default: no node_modules — a .pnp.cjs resolution table over
  // global-cache zips; only native packages are materialized, under .yarn/unplugged)
  writeYarnRc("pnp");
  rmNM();
  rmLocks();
  const ypC = timedInstall("node", [YARNJS, "install"], yarnEnv());
  verifyCompletePnp();
  const ypNm = entries(); // PnP materializes only unplugged native packages
  const ypPnpBytes = statSync(join(DIR, ".pnp.cjs")).size;
  rmNM();
  const ypW = timedInstall("node", [YARNJS, "install"], yarnEnv());
  verifyCompletePnp();

  // one shared record shape per tool, so a future stat field can't be added to some
  // tools and silently missed in others (the chart resolves a missing key to a blank)
  const stat = (cold, warm, nmEntries) => ({
    coldMs: cold.ms,
    coldCpuPct: cold.cpuPct,
    coldRssMB: cold.rssMB,
    warmMs: warm.ms,
    nmEntries,
  });
  out.scales.push({
    apps,
    libs,
    depEdgesVerified,
    pnpmIsolated: stat(piC, piW, piNm),
    pnpmHoisted: stat(phC, phW, phNm),
    bun: stat(bC, bW, bNm),
    yarnNm: stat(ynC, ynW, ynNm),
    // yarnPnp.nmEntries counts only the unplugged native packages — PnP writes no
    // per-package node_modules (the full dependency set lives as zips in the shared
    // global cache, resolved through .pnp.cjs)
    yarnPnp: { ...stat(ypC, ypW, ypNm), pnpCjsBytes: ypPnpBytes },
  });
  persist();
  console.log(`${apps}/${libs} (dep edges verified: ${depEdgesVerified} (all packages))`);
  console.log(
    `  pnpm-isolated cold ${piC.ms}ms ${piC.cpuPct}%cpu warm ${piW.ms}ms  nm ${piNm}  rss ${piC.rssMB}MB`,
  );
  console.log(
    `  pnpm-hoisted  cold ${phC.ms}ms ${phC.cpuPct}%cpu warm ${phW.ms}ms  nm ${phNm}  rss ${phC.rssMB}MB`,
  );
  console.log(
    `  bun           cold ${bC.ms}ms ${bC.cpuPct}%cpu warm ${bW.ms}ms  nm ${bNm}  rss ${bC.rssMB}MB`,
  );
  console.log(
    `  yarn-nm       cold ${ynC.ms}ms ${ynC.cpuPct}%cpu warm ${ynW.ms}ms  nm ${ynNm}  rss ${ynC.rssMB}MB`,
  );
  console.log(
    `  yarn-pnp      cold ${ypC.ms}ms ${ypC.cpuPct}%cpu warm ${ypW.ms}ms  nm ${ypNm} (unplugged only)  rss ${ypC.rssMB}MB`,
  );
}

const { apps: fa, libs: fl } = SCALES[0];
setup(fa, fl);
// Truly-cold: every tool gets the SAME treatment — a per-run fresh scratch dir for its
// content store AND its registry metadata (pnpm: --store-dir + --config.cache-dir; bun:
// BUN_INSTALL_CACHE_DIR, one dir holding both its tarball cache and .npm manifests; yarn:
// YARN_GLOBAL_FOLDER, one dir holding its zip cache and metadata store), real network.
// The host's real caches are never touched. Each cold claim hinges on the redirect
// taking effect — a silently-ignored flag/env would let the install read the warm host
// cache and record a metadata-warm number as cold — so every fresh dir is asserted
// populated after the timed install.
const freshDir = (label) => {
  const d = mkdtempSync(join(tmpdir(), `pm-bench-${label}-`));
  TEMP_DIRS.push(d);
  return d;
};
const assertPopulated = (dir, what) => {
  if (!existsSync(dir) || readdirSync(dir).length === 0)
    throw new Error(
      `${what} wrote nothing to its fresh dir ${dir} — the redirect was not honored; ` +
        `the truly-cold number would be cache-warm, not cold.`,
    );
};
const coldStore = freshDir("store");
const coldCache = freshDir("cache");
rmNM();
rmLocks();
const tcPnpm = timedInstall(
  "pnpm",
  [
    ...PI,
    "--config.node-linker=hoisted",
    "--store-dir",
    coldStore,
    `--config.cache-dir=${coldCache}`,
  ],
  pnpmEnv(),
);
verifyComplete();
assertPopulated(coldStore, "pnpm (--store-dir)");
assertPopulated(coldCache, "pnpm (--config.cache-dir)");
const coldBunCache = freshDir("bun-cache");
rmNM();
rmLocks();
const tcBun = timedInstall(BUN, ["install"], bunEnv({ BUN_INSTALL_CACHE_DIR: coldBunCache }));
verifyComplete();
assertPopulated(coldBunCache, "bun (BUN_INSTALL_CACHE_DIR)");
// node-modules linker — the same matched-layout choice as the pnpm-hoisted pass.
const coldYarnGlobal = freshDir("yarn-global");
writeYarnRc("node-modules");
rmNM();
rmLocks();
const tcYarn = timedInstall(
  "node",
  [YARNJS, "install"],
  yarnEnv({ YARN_GLOBAL_FOLDER: coldYarnGlobal }),
);
verifyComplete();
assertPopulated(join(coldYarnGlobal, "cache"), "yarn zip cache (YARN_GLOBAL_FOLDER)");
assertPopulated(join(coldYarnGlobal, "metadata"), "yarn metadata store (YARN_GLOBAL_FOLDER)");
// yarn PnP — yarn's default linker and its faster one at every measured scale; skipping
// it here would exclude exactly one tool's best configuration from this regime.
const coldYarnGlobalPnp = freshDir("yarn-global-pnp");
writeYarnRc("pnp");
rmNM();
rmLocks();
const tcYarnPnp = timedInstall(
  "node",
  [YARNJS, "install"],
  yarnEnv({ YARN_GLOBAL_FOLDER: coldYarnGlobalPnp }),
);
verifyCompletePnp();
assertPopulated(join(coldYarnGlobalPnp, "cache"), "yarn-pnp zip cache (YARN_GLOBAL_FOLDER)");
assertPopulated(
  join(coldYarnGlobalPnp, "metadata"),
  "yarn-pnp metadata store (YARN_GLOBAL_FOLDER)",
);
out.trulyCold = {
  apps: fa,
  libs: fl,
  pnpmHoistedMs: tcPnpm.ms,
  bunMs: tcBun.ms,
  yarnNmMs: tcYarn.ms,
  yarnPnpMs: tcYarnPnp.ms,
  // single network-bound samples, downloaded sequentially in this fixed order — a warmed
  // CDN edge or intermediate proxy can favor the later tools
  order: ["pnpm-hoisted", "bun", "yarn-nm", "yarn-pnp"],
};
promote();
console.log(
  `truly-cold (fresh per-tool store+metadata dirs, network) @ ${fa}/${fl}: pnpm-hoisted ${tcPnpm.ms}ms, bun ${tcBun.ms}ms, yarn-nm ${tcYarn.ms}ms, yarn-pnp ${tcYarnPnp.ms}ms`,
);
console.log(`--- ${FINAL_JSON} written ---`);

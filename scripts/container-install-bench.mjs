#!/usr/bin/env node
// The CI-runner install, measured in true isolation: a FROZEN install from the COMMITTED
// lockfile — what a real clean checkout / fresh CI runner actually pays, which
// install-bench's cold column (no lockfile, full re-resolve) deliberately does not
// measure — per tool, each sample in a FRESH podman container.
//
//   node scripts/container-install-bench.mjs             # canonical "1000:200"
//   node scripts/container-install-bench.mjs "200:100"   # other scales -> container-install-bench.partial.json
//   CONTAINER_INSTALL_SAMPLES=7 ...                      # samples per cell (default 5; non-default -> partial)
//
// Tools: pnpm (--frozen-lockfile), bun (--frozen-lockfile), yarn 4 under node-modules and
// under PnP (--immutable), npm (npm ci). npm has no `workspace:` protocol, so its tree is
// a copy with internal deps rewritten `workspace:*` -> `*`; the authored package-lock.json
// is then ASSERTED to link every internal dep to the local workspace (not the registry).
//
// Variants per tool:
//   freshRunner   — empty caches, hermetic container env, real network (downloads +
//                   registry metadata): the brand-new CI runner.
//   cacheRestored — the tool's per-tool work volume keeps its cache/ subdir across
//                   samples (pre-warmed once, asserted non-empty); each sample's runner
//                   resets only ws/: the runner with a restored dependency cache.
//
// Isolation and honesty:
//   - every sample runs in a fresh container (podman run --rm, --http-proxy=false so
//     host proxy env cannot leak) with only the env the bench sets
//   - SAME-MOUNT geometry: each sample's workspace (ws/) and the tool's store/cache
//     (cache/) are SUBDIRECTORIES OF ONE NAMED VOLUME mounted at /work — link(2) and
//     FICLONE fail EXDEV across two mounts even on one backing filesystem, so two
//     volumes (or a bind/overlay tree) would force pnpm and bun into their per-file
//     copy fallback, a geometry artifact a real CI runner (cache restored onto the
//     workspace disk, one mount) does not pay. The tree is copied in untimed from a
//     read-only mount, and pnpm's own copy-fallback warning is captured as evidence
//     the link path was actually taken
//   - lockfiles are authored IN-CONTAINER by the pinned tools (no host tool versions,
//     no host rc files can shape them)
//   - the fail-closed contract is MEASURED, not assumed: a drift rung mutates a
//     manifest and records whether each tool's frozen command actually rejects it
//   - samples are taken in a ROUND-ROTATED tool order; the default 5 samples complete
//     the rotation over 5 tools, so every tool takes every position exactly once
//   - the timed window is measured INSIDE the container (GNU time wraps only the
//     install; the tree copy, verification, and lock hashing sit outside it) and the
//     runner emits ONE JSON line — no shell-parsing layer between measurement and host
//   - every sample is verified complete in-container via the shared verifier
//     (scripts/_verify-install.cjs — the same contract install-bench gates on), the
//     lockfile hash is asserted unchanged, and bun's layout is recorded from evidence
//     (node_modules/.bun present), not assumed
//   - true median per cell with every sample kept in the JSON (freshRunner is
//     network-live; the spread is the honesty signal), cores/load recorded at start
//     and per sample so a contended run stays visible
//   - a run at a non-canonical scale OR non-default sample count writes
//     container-install-bench.partial.json; the canonical file is promoted on
//     completion only, and a leftover partial file refuses a second concurrent run
//
// Self-contained: scaffolds under the OS temp dir, builds a digest-pinned local image,
// removes volumes and (on success) scratch on exit — on failure the scratch dir is kept
// and named for post-mortem. Needs no git worktree; touches no turbo state.

import { spawnSync } from "node:child_process";
import {
  rmSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  cpSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PNPM_VERSION, BUN_VERSION, YARN_VERSION, NODE_IMAGE } from "./_pins.mjs";
import {
  median,
  benchOutput,
  loadGuard,
  load1Now,
  scaffoldWorkspace,
  writeYarnRc,
} from "./_pm-bench-lib.mjs";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const IMAGE_TAG = `localhost/pm-container-install-bench:pnpm${PNPM_VERSION}-bun${BUN_VERSION}-yarn${YARN_VERSION}`;

const DEFAULT_SAMPLES = 5; // = tool count: the rotation completes, every tool takes every position
// Number(), not parseInt: "5x" must be rejected, not silently read as 5 on a canonical run
const SAMPLES =
  process.env.CONTAINER_INSTALL_SAMPLES === undefined
    ? DEFAULT_SAMPLES
    : Number(process.env.CONTAINER_INSTALL_SAMPLES);
if (!Number.isInteger(SAMPLES) || SAMPLES < 2)
  throw new Error(
    `CONTAINER_INSTALL_SAMPLES must be an integer >= 2, got "${process.env.CONTAINER_INSTALL_SAMPLES}"`,
  );
const CANONICAL_SCALE = "1000:200";
const SCALE_ARG = (process.argv[2] || CANONICAL_SCALE).trim();
const CANONICAL_RUN = SCALE_ARG === CANONICAL_SCALE && SAMPLES === DEFAULT_SAMPLES;
const { persist, promote, progressPath } = benchOutput(
  REPO,
  "bench/container-install-bench.partial.json",
  CANONICAL_RUN
    ? "bench/container-install-bench.json"
    : "bench/container-install-bench.partial.json",
);
const [APPS, LIBS] = SCALE_ARG.split(":").map(Number);
if (!Number.isInteger(APPS) || !Number.isInteger(LIBS) || APPS < 1 || LIBS < 1)
  throw new Error(`scale must be "<apps>:<libs>"; got "${SCALE_ARG}"`);
// two concurrent runs would interleave writes into one partial file and the canonical
// run's promotion would delete the other's output — refuse instead
if (existsSync(progressPath))
  throw new Error(
    `${progressPath} exists — another run is in progress (or a crashed run left it); ` +
      `remove it to proceed`,
  );

const LOAD = loadGuard("CONTAINER_INSTALL_ALLOW_BUSY");

// podman is the harness — fail with a named cause, not a spawn error mid-run
if (spawnSync("podman", ["--version"]).status !== 0)
  throw new Error("podman is required (rootless is fine) — install it and re-run");

const RUN_DIR = mkdtempSync(join(tmpdir(), "pm-cib-"));
const WS = join(RUN_DIR, "ws"); // pnpm/bun/yarn tree (workspace:* specifiers)
const WS_NPM = join(RUN_DIR, "ws-npm"); // npm tree (workspace:* -> *)
const CTX = join(RUN_DIR, "ctx"); // empty build context (a remote builder must not tar the trees)
const VOL_PREFIX = `pmcib-${process.pid}`;
const TEMP_VOLUMES = [];
process.on("exit", (code) => {
  const leftover = [];
  for (const v of TEMP_VOLUMES) {
    // a container interrupted mid-sample can still hold its volume; report what
    // could not be reclaimed instead of leaking it silently
    if (spawnSync("podman", ["volume", "rm", "-f", v]).status !== 0) leftover.push(v);
  }
  if (leftover.length)
    console.error(
      `podman volumes not reclaimed (remove with \`podman volume rm -f\`): ${leftover.join(" ")}`,
    );
  if (code !== 0) console.error(`scratch kept for post-mortem: ${RUN_DIR}`);
  else rmSync(RUN_DIR, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 27, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.code || r.error.message}`);
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.join(" ")} (status ${r.status}):\n${((r.stderr || "") + (r.stdout || "")).slice(-2000)}`,
    );
  return (r.stdout || "").trim();
}
// every container: no host env, no host proxy vars, only what the bench sets. A hard
// per-container timeout bounds a wedged registry connection (network-live samples) —
// without it a stalled TCP stream would hang spawnSync, and the whole bench, forever.
const CONTAINER_TIMEOUT_MS = 30 * 60 * 1000;
function podmanRun(mounts, envs, cmdArgs) {
  const args = ["run", "--rm", "--http-proxy=false"];
  for (const m of mounts) args.push("-v", m);
  for (const [k, v] of Object.entries(envs)) args.push("-e", `${k}=${v}`);
  args.push(IMAGE_TAG, ...cmdArgs);
  return spawnSync("podman", args, {
    encoding: "utf8",
    maxBuffer: 1 << 27,
    timeout: CONTAINER_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}
const podmanRunOk = (mounts, envs, cmdArgs, what) => {
  const r = podmanRun(mounts, envs, cmdArgs);
  if (r.error) throw new Error(`podman run (${what}) failed to spawn: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(
      `${what} failed (exit ${r.status}):\n${((r.stdout || "") + (r.stderr || "")).slice(-1500)}`,
    );
  return (r.stdout || "").trim();
};

// --- 1. image first: static and failure-prone (network pulls), so it must fail before
// any scaffold work is spent ---------------------------------------------------------------------
console.log(`scale ${APPS}:${LIBS}, ${SAMPLES} samples/cell, image ${IMAGE_TAG}`);
mkdirSync(CTX, { recursive: true });
writeFileSync(
  join(RUN_DIR, "Containerfile"),
  `FROM ${NODE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends time ca-certificates curl unzip \\
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@${PNPM_VERSION} && pnpm --version | grep -qx "${PNPM_VERSION}"
RUN curl -fsSL https://bun.sh/install | bash -s -- "bun-v${BUN_VERSION}" \\
 && ln -s /root/.bun/bin/bun /usr/local/bin/bun && bun --version | grep -qx "${BUN_VERSION}"
RUN mkdir -p /opt/yarn && cd /opt/yarn && npm pack @yarnpkg/cli-dist@${YARN_VERSION} \\
 && tar -xzf yarnpkg-cli-dist-${YARN_VERSION}.tgz && rm *.tgz \\
 && node /opt/yarn/package/bin/yarn.js --version | grep -qx "${YARN_VERSION}"
`,
);
console.log("building image (cached layers make repeats fast)...");
sh("podman", ["build", "-t", IMAGE_TAG, "-f", join(RUN_DIR, "Containerfile"), CTX]);
const IMAGE_ID = sh("podman", ["inspect", "--format", "{{.Id}}", IMAGE_TAG]).slice(0, 12);
const IMG_NODE = podmanRunOk([], {}, ["node", "--version"], "node version probe");
const IMG_NPM = podmanRunOk([], {}, ["npm", "--version"], "npm version probe");
const NETWORK_BACKEND = sh("podman", ["info", "--format", "{{.Host.NetworkBackend}}"]);

// --- 2. scaffold the workspace on the host ---------------------------------------------------------
mkdirSync(WS, { recursive: true });
scaffoldWorkspace(REPO, WS, { apps: APPS, libs: LIBS, name: "cib" });
// the rc pins the measurement-critical yarn knobs; the linker is selected per variant
// via YARN_NODE_LINKER (env overrides the rc), and --immutable is passed explicitly
writeYarnRc(WS, "node-modules");

// npm tree: same workspace with internal `workspace:*` specifiers rewritten to `*`
// (npm has no workspace: protocol; a `*` range resolves to the local workspace package —
// asserted against the authored lockfile below, not assumed)
cpSync(WS, WS_NPM, { recursive: true });
let npmRewrites = 0;
for (const group of ["apps", "packages"]) {
  for (const name of readdirSync(join(WS_NPM, group))) {
    const p = join(WS_NPM, group, name, "package.json");
    if (!existsSync(p)) continue;
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    let touched = false;
    for (const field of ["dependencies", "devDependencies"]) {
      for (const [dep, spec] of Object.entries(pkg[field] || {})) {
        if (typeof spec === "string" && spec.startsWith("workspace:")) {
          pkg[field][dep] = "*";
          touched = true;
          npmRewrites++;
        }
      }
    }
    if (touched) writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
  }
}
if (npmRewrites === 0)
  throw new Error("npm tree rewrite found no workspace:* specifiers — wrong tree");
rmSync(join(WS_NPM, "pnpm-workspace.yaml"), { force: true });
rmSync(join(WS_NPM, ".yarnrc.yml"), { force: true });

// --- 3. author each tool's lockfile IN-CONTAINER (pinned tools; no host rc can shape
// them), untimed — the committed-lockfile premise -------------------------------------------------
console.log("authoring lockfiles (in-container, untimed)...");
const AUTHOR = [
  { cmd: "cd /ws && pnpm install --lockfile-only --config.confirm-modules-purge=false", tree: WS },
  { cmd: "cd /ws && bun install --lockfile-only", tree: WS },
  { cmd: "cd /ws && node /opt/yarn/package/bin/yarn.js install --mode=update-lockfile", tree: WS },
  { cmd: "cd /ws && npm install --package-lock-only --ignore-scripts", tree: WS_NPM },
];
for (const a of AUTHOR) podmanRunOk([`${a.tree}:/ws`], {}, ["bash", "-c", a.cmd], a.cmd);

const TOOLS = [
  {
    key: "pnpm",
    tree: WS,
    lock: "pnpm-lock.yaml",
    verify: "nm",
    install:
      "pnpm install --frozen-lockfile --config.confirm-modules-purge=false --store-dir /work/cache/store --config.cache-dir=/work/cache/meta",
    env: {},
  },
  {
    key: "bun",
    tree: WS,
    lock: "bun.lock",
    verify: "nm",
    install: "bun install --frozen-lockfile",
    env: { BUN_INSTALL_CACHE_DIR: "/work/cache" },
  },
  {
    key: "yarnNm",
    tree: WS,
    lock: "yarn.lock",
    verify: "nm",
    install: "node /opt/yarn/package/bin/yarn.js install --immutable",
    env: { YARN_NODE_LINKER: "node-modules", YARN_GLOBAL_FOLDER: "/work/cache" },
  },
  {
    key: "yarnPnp",
    tree: WS,
    lock: "yarn.lock",
    verify: "pnp",
    install: "node /opt/yarn/package/bin/yarn.js install --immutable",
    env: { YARN_NODE_LINKER: "pnp", YARN_GLOBAL_FOLDER: "/work/cache" },
  },
  {
    key: "npm",
    tree: WS_NPM,
    lock: "package-lock.json",
    verify: "nm",
    install: "npm ci --no-audit --no-fund --cache /work/cache",
    env: {},
  },
];
for (const t of TOOLS) {
  const p = join(t.tree, t.lock);
  if (!existsSync(p) || statSync(p).size < 1000)
    throw new Error(`${t.key} lockfile ${t.lock} missing/trivial after authoring`);
}
// authoring must leave no node_modules / yarn state behind (the trees are the copy source)
for (const tree of [WS, WS_NPM]) {
  sh("bash", ["-c", "find . -name node_modules -type d -prune -exec rm -rf {} +"], { cwd: tree });
  rmSync(join(tree, ".yarn"), { recursive: true, force: true });
  for (const f of [".pnp.cjs", ".pnp.data.json", ".pnp.loader.mjs"])
    rmSync(join(tree, f), { force: true });
}
// npm's `*` internal specifiers must have resolved to WORKSPACE LINKS, not the registry —
// @demo/* is an unowned public scope, so a registry resolution would silently install
// foreign packages and still pass the completeness verifier
{
  const lock = JSON.parse(readFileSync(join(WS_NPM, "package-lock.json"), "utf8"));
  const bad = [];
  for (const [path, entry] of Object.entries(lock.packages || {})) {
    const m = path.match(/^node_modules\/(@demo\/[^/]+)$/);
    if (m && !(entry.link === true && entry.resolved && !entry.resolved.startsWith("http")))
      bad.push(`${m[1]}: ${JSON.stringify(entry).slice(0, 120)}`);
  }
  if (bad.length)
    throw new Error(
      `npm lockfile resolved internal deps to the registry, not workspace links:\n${bad.slice(0, 5).join("\n")}`,
    );
}

// --- 4. the in-container runner: copy tree -> timed frozen install -> verify -> hash,
// one JSON line out (no shell-parsing layer) --------------------------------------------------------
cpSync(join(REPO, "scripts", "_verify-install.cjs"), join(RUN_DIR, "verify.cjs"));
writeFileSync(
  join(RUN_DIR, "runner.cjs"),
  `// One sample: ws/ is RESET inside the persistent-or-fresh /work volume and populated
// UNTIMED from /src (host tree, ro); the tool's store/cache lives at /work/cache in the
// SAME MOUNT, so store->node_modules hardlink/reflink works (two mounts would EXDEV).
// Then the frozen install runs under GNU time, and the shared verifier + lockfile-hash
// check run OUTSIDE the timed window. Output contract: one "CIB_RESULT {json}" line.
const { spawnSync } = require("child_process");
const { readFileSync, existsSync, rmSync, mkdirSync } = require("fs");
const { createHash } = require("crypto");
const verify = require("/verify.cjs");
const fail = (stage, detail) => {
  console.log("CIB_RESULT " + JSON.stringify({ ok: false, stage, detail: String(detail).slice(-1200) }));
  process.exit(1);
};
const INSTALL = process.env.CIB_INSTALL;
const LOCK = process.env.CIB_LOCK;
const MODE = process.env.CIB_VERIFY;
if (!INSTALL || !LOCK || !["nm", "pnp"].includes(MODE)) fail("config", "missing CIB_* env");
const WS = "/work/ws";
rmSync(WS, { recursive: true, force: true });
mkdirSync(WS, { recursive: true });
mkdirSync("/work/cache", { recursive: true });
let r = spawnSync("cp", ["-a", "/src/.", WS], { encoding: "utf8" });
if (r.status !== 0) fail("copy", r.stderr);
const sha = (p) => createHash("sha256").update(readFileSync(WS + "/" + p)).digest("hex");
const h0 = sha(LOCK);
r = spawnSync("/usr/bin/time", ["-v", "-o", "/tmp/t.txt", "sh", "-c", INSTALL], {
  cwd: WS,
  encoding: "utf8",
  maxBuffer: 1 << 26,
});
if (r.status !== 0) fail("install", (r.stdout || "") + (r.stderr || ""));
const t = readFileSync("/tmp/t.txt", "utf8");
// GNU time's Elapsed label itself contains colons ("(h:mm:ss or m:ss)"), so the value
// is parsed as the line's LAST whitespace token, then split on ":" — h:mm:ss or m:ss.cc
const eline = t.split("\\n").find((l) => l.includes("Elapsed (wall clock) time"));
const wparts = eline ? eline.trim().split(/\\s+/).pop().split(":").map(Number) : [];
const cpu = t.match(/Percent of CPU this job got: (\\d+)%/);
const rss = t.match(/Maximum resident set size[^:]*: (\\d+)/);
if (
  wparts.length < 2 ||
  wparts.length > 3 ||
  wparts.some((n) => !Number.isFinite(n)) ||
  !cpu ||
  !rss
)
  fail("time-parse", t);
const ms = Math.round(
  (wparts.length === 3
    ? wparts[0] * 3600 + wparts[1] * 60 + wparts[2]
    : wparts[0] * 60 + wparts[1]) * 1000,
);
let edges;
try {
  edges = (MODE === "nm" ? verify.verifyNm : verify.verifyPnp)(WS);
} catch (e) {
  fail("verify", e.message || e);
}
if (sha(LOCK) !== h0) fail("lock-rewritten", LOCK);
console.log(
  "CIB_RESULT " +
    JSON.stringify({
      ok: true,
      ms,
      cpuPct: +cpu[1],
      rssMB: Math.round(+rss[1] / 1024),
      edges,
      bunStoreDir: existsSync(WS + "/node_modules/.bun"),
      // pnpm prints this when hardlink/reflink from the store fails and it copies
      // instead — direct evidence the same-mount geometry held (false) or broke (true)
      copyFallback: /Falling back to copying/i.test((r.stdout || "") + (r.stderr || "")),
    }),
);
`,
);

let volSeq = 0;
const freshVolume = (label) => {
  const v = `${VOL_PREFIX}-${label}-${volSeq++}`;
  sh("podman", ["volume", "create", v]);
  TEMP_VOLUMES.push(v);
  return v;
};
const rmVolume = (v) => {
  // only untrack on a SUCCESSFUL rm — a failed rm (a container still holding the
  // volume) must stay tracked so the exit handler retries and reports it
  if (spawnSync("podman", ["volume", "rm", "-f", v]).status === 0) {
    const i = TEMP_VOLUMES.indexOf(v);
    if (i !== -1) TEMP_VOLUMES.splice(i, 1);
  }
};
const volumeEntries = (v) => {
  const outp = podmanRunOk(
    [`${v}:/work`],
    {},
    ["bash", "-c", "find /work/cache 2>/dev/null | wc -l"],
    `volume census ${v}`,
  );
  const n = parseInt(outp.trim().split("\n").pop(), 10);
  if (!Number.isFinite(n)) throw new Error(`volume census for ${v} was non-numeric: "${outp}"`);
  return n;
};

function runSample(tool, workVolume) {
  const r = podmanRun(
    [
      `${workVolume}:/work`,
      `${tool.tree}:/src:ro`,
      `${join(RUN_DIR, "runner.cjs")}:/runner.cjs:ro`,
      `${join(RUN_DIR, "verify.cjs")}:/verify.cjs:ro`,
    ],
    { ...tool.env, CIB_INSTALL: tool.install, CIB_LOCK: tool.lock, CIB_VERIFY: tool.verify },
    ["node", "/runner.cjs"],
  );
  if (r.error) throw new Error(`podman run failed to spawn: ${r.error.message}`);
  const line = ((r.stdout || "") + (r.stderr || ""))
    .split("\n")
    .find((l) => l.startsWith("CIB_RESULT "));
  if (!line)
    throw new Error(
      `${tool.key} sample produced no CIB_RESULT (exit ${r.status}):\n${((r.stdout || "") + (r.stderr || "")).slice(-1000)}`,
    );
  const res = JSON.parse(line.slice("CIB_RESULT ".length));
  if (!res.ok) throw new Error(`${tool.key} sample failed at ${res.stage}:\n${res.detail}`);
  return res;
}

// --- 5. the fail-closed contract, measured: mutate a manifest, expect the frozen
// command to reject it (recorded per tool — a fail-open frozen flag would make that
// tool's cells resolve-included while the others are link-only) ------------------------------------
console.log("fail-closed drift rung (untimed)...");
const failClosed = {};
for (const t of TOOLS) {
  const workVol = freshVolume("drift");
  const script = `
const { spawnSync } = require("child_process");
const { readFileSync, writeFileSync } = require("fs");
const { createHash } = require("crypto");
const WS = "/work/ws";
require("fs").rmSync(WS, { recursive: true, force: true });
require("fs").mkdirSync(WS, { recursive: true });
require("fs").mkdirSync("/work/cache", { recursive: true });
let r = spawnSync("cp", ["-a", "/src/.", WS], { encoding: "utf8" });
if (r.status !== 0) { console.log("DRIFT {\\"setup\\":false}"); process.exit(0); }
const mf = JSON.parse(readFileSync(WS + "/package.json", "utf8"));
mf.dependencies = { ...(mf.dependencies || {}), "left-pad": "1.3.0" };
writeFileSync(WS + "/package.json", JSON.stringify(mf, null, 2));
const sha = (p) => createHash("sha256").update(readFileSync(WS + "/" + p)).digest("hex");
const h0 = sha(${JSON.stringify(t.lock)});
r = spawnSync("sh", ["-c", ${JSON.stringify(t.install)}], { cwd: WS, encoding: "utf8", maxBuffer: 1 << 26 });
console.log("DRIFT " + JSON.stringify({ setup: true, exit: r.status, lockUnchanged: sha(${JSON.stringify(t.lock)}) === h0, tail: ((r.stdout||"")+(r.stderr||"")).slice(-300) }));
`;
  writeFileSync(join(RUN_DIR, "drift.cjs"), script);
  const out = podmanRunOk(
    [`${workVol}:/work`, `${t.tree}:/src:ro`, `${join(RUN_DIR, "drift.cjs")}:/drift.cjs:ro`],
    { ...t.env },
    ["node", "/drift.cjs"],
    `${t.key} drift rung`,
  );
  rmVolume(workVol);
  const m = out.split("\n").find((l) => l.startsWith("DRIFT "));
  if (!m) throw new Error(`${t.key} drift rung produced no DRIFT line:\n${out.slice(-500)}`);
  const d = JSON.parse(m.slice(6));
  if (!d.setup) throw new Error(`${t.key} drift rung could not set up`);
  failClosed[t.key] = { rejected: d.exit !== 0, exit: d.exit, lockUnchanged: d.lockUnchanged };
  console.log(
    `  ${t.key}: drifted manifest -> exit ${d.exit} (${d.exit !== 0 ? "fail-closed" : "FAIL-OPEN"}), lock unchanged=${d.lockUnchanged}`,
  );
}

// --- 6. samples -------------------------------------------------------------------------------------
const out = {
  scale: { apps: APPS, libs: LIBS },
  measures:
    "frozen install from the committed lockfile, each sample in a fresh podman container (hermetic env, --http-proxy=false; workspace and store/cache are subdirs of one mounted volume — same mount, so store links work; timed inside the container)",
  image: { ref: NODE_IMAGE, tag: IMAGE_TAG, id: IMAGE_ID, node: IMG_NODE, npm: IMG_NPM },
  versions: { pnpm: PNPM_VERSION, bun: BUN_VERSION, yarn: YARN_VERSION },
  host: { ...LOAD, networkBackend: NETWORK_BACKEND },
  samplesPerCell: SAMPLES,
  rotation:
    "round-robin across the tool list; the exact per-sample order is recorded in sampleOrder",
  notes: [
    "lifecycle scripts run at each tool's default: npm ci RUNS dependency scripts; pnpm 10 and yarn 4 block them; bun runs only its built-in allowlist — npm's cells include any script work (--no-audit/--no-fund strip only npm's advisory network add-ons, which are not part of installing)",
    "npm has no workspace: protocol; its tree rewrites internal workspace:* specifiers to * and the authored package-lock.json is asserted to link them to the local workspace (npmTreeRewrites)",
    "freshRunner is network-live through rootless podman's user-mode network stack (host.networkBackend); samples after the first fetch of a tarball ride a warmed CDN edge, so the recorded spread understates a genuinely different network path — not directly comparable to install-bench's host-network truly-cold pass",
    "cacheRestored keeps the tool's cache/ subdir across samples in a persistent per-tool volume (pre-warmed once, asserted non-empty, entry count recorded); the lockfile is present in both variants",
    "pnpm runs its default isolated linker; install-bench's warm rows show the hoisted linker relinks faster at this scale — not measured in containers",
    "workspace and store/cache are subdirectories of ONE mounted volume: link(2)/FICLONE fail EXDEV across separate mounts even on one filesystem, so a two-volume or bind-mount geometry would force pnpm/bun into their per-file copy fallback — pnpm's copy-fallback warning is captured per cell (copyFallbackSeen) as evidence the link path held",
  ],
  npmTreeRewrites: npmRewrites,
  failClosed,
  sampleOrder: [],
  tools: Object.fromEntries(TOOLS.map((t) => [t.key, {}])),
};

let expectedEdges = null;
for (const variant of ["freshRunner", "cacheRestored"]) {
  const workVols = {};
  if (variant === "cacheRestored") {
    // pre-warm each tool's persistent work volume once (untimed) — populating its
    // cache/ subdir — then assert the cache was actually populated: a silently-ignored
    // cache env/flag would leave it empty and every "cacheRestored" sample would be a
    // second network-live fresh run. Later samples reset only ws/ inside the volume.
    for (const t of TOOLS) {
      workVols[t.key] = freshVolume(`work-${t.key}`);
      console.log(`  pre-warming ${t.key} cache (persistent work volume)...`);
      runSample(t, workVols[t.key]);
      const entries = volumeEntries(workVols[t.key]);
      if (entries < 10)
        throw new Error(
          `${t.key} cache has ${entries} entries after pre-warm — its cache redirection was not honored; cacheRestored would be a fresh run in disguise`,
        );
      out.tools[t.key].cacheVolumeEntries = entries;
    }
  }
  const cells = Object.fromEntries(TOOLS.map((t) => [t.key, []]));
  for (let s = 0; s < SAMPLES; s++) {
    const order = TOOLS.map((_, i) => TOOLS[(i + s) % TOOLS.length]);
    out.sampleOrder.push({ variant, sample: s + 1, order: order.map((t) => t.key) });
    for (const t of order) {
      // freshRunner: a NEW empty work volume per sample (empty cache by construction,
      // same-mount ws/ + cache/ geometry); cacheRestored: the tool's persistent volume
      const workVol = variant === "freshRunner" ? freshVolume("fresh") : workVols[t.key];
      const r = runSample(t, workVol);
      if (variant === "freshRunner") rmVolume(workVol);
      if (expectedEdges === null) expectedEdges = r.edges;
      if (r.edges !== expectedEdges)
        throw new Error(`${t.key} verified ${r.edges} edges, expected ${expectedEdges}`);
      cells[t.key].push({ ...r, load1: load1Now() });
      console.log(
        `  ${variant} s${s + 1} ${t.key}: ${r.ms}ms ${r.cpuPct}%cpu ${r.rssMB}MB (${r.edges} edges)`,
      );
    }
    persist(out);
  }
  for (const t of TOOLS) {
    const xs = cells[t.key];
    out.tools[t.key][variant] = {
      medianMs: median(xs.map((x) => x.ms)),
      samplesMs: xs.map((x) => x.ms),
      cpuPct: median(xs.map((x) => x.cpuPct)),
      rssMB: median(xs.map((x) => x.rssMB)),
      load1PerSample: xs.map((x) => x.load1),
      copyFallbackSeen: xs.some((x) => x.copyFallback),
      ...(t.key === "bun" ? { bunStoreDirSeen: xs.every((x) => x.bunStoreDir) } : {}),
    };
  }
  persist(out);
}
out.depEdgesVerified = expectedEdges;
// a cell short of its samples must never promote as the record
for (const t of TOOLS)
  for (const variant of ["freshRunner", "cacheRestored"]) {
    const cell = out.tools[t.key][variant];
    if (!cell || cell.samplesMs.length !== SAMPLES || !Number.isFinite(cell.medianMs))
      throw new Error(`${t.key}/${variant} is incomplete — refusing to write a final record`);
  }
promote(out);
console.log(
  `--- ${CANONICAL_RUN ? "bench/container-install-bench.json" : progressPath} written ---`,
);
for (const t of TOOLS) {
  const f = out.tools[t.key].freshRunner;
  const c = out.tools[t.key].cacheRestored;
  console.log(
    `${t.key.padEnd(8)} fresh ${f.medianMs}ms (${f.samplesMs.join("/")})  cache-restored ${c.medianMs}ms (${c.samplesMs.join("/")})`,
  );
}

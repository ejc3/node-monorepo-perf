// Shared internals for the install benches (install-bench.mjs, container-install-bench.mjs).
// These carry the measurement-critical discipline that was drifting as per-file copies:
// the ambient-env scrub, the yarn rc knob list, the workspace scaffold, the pinned yarn
// CLI fetch, the partial→promote record protection, and the load guard.

import { spawnSync } from "node:child_process";
import { rmSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, cpus, loadavg } from "node:os";

// Ambient tool config env silently changes what a tool's run measures: YARN_* overrides even
// an explicit .yarnrc.yml (verified on 4.17: YARN_NODE_LINKER beats the rc), a stray
// BUN_INSTALL_CACHE_DIR redirects bun's cache, and pnpm/bun both read npm_config_*.
// Case-insensitive: npm-config env handling accepts NPM_CONFIG_* as well as npm_config_*.
// `overrides`, when given, are re-added AFTER the scrub.
export const scrubEnv = (prefixes, overrides) => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !prefixes.some((p) => k.toUpperCase().startsWith(p.toUpperCase())),
    ),
  ),
  ...overrides,
});
export const yarnEnv = (overrides) => scrubEnv(["YARN_"], overrides);
export const bunEnv = (overrides) => scrubEnv(["BUN_", "npm_config_"], overrides);
export const pnpmEnv = (overrides) => scrubEnv(["PNPM_", "npm_config_"], overrides);

// yarn reads only .yarnrc.yml — but every measurement-critical knob is pinned explicitly
// rather than trusting defaults: npmRegistryServer (yarn ignores .npmrc, so a user-level
// ~/.yarnrc.yml registry would otherwise silently retarget every scaffold);
// enableImmutableInstalls (yarn auto-enables immutable in
// CI — an env-dependent hard failure when a bench deletes the lockfile; benches that DO
// want immutable pass --immutable explicitly; yarn-rollout-bench's determinism rung sets
// pinImmutable:false because yarn's own CI default IS its measurement); enableHardenedMode
// (yarn 4 auto-enables it
// — an implicit --check-resolutions --refresh-lockfile with per-package registry traffic
// — on public-repo GitHub PR jobs); enableGlobalCache (its default: zips live in the
// shared global cache, yarn's analogue of the pnpm store); enableScripts false (yarn 4's
// own default, the same block-dependency-build-scripts posture as pnpm 10); telemetry off.
export const yarnRcLines = (linker, { pinImmutable = true, extraLines = [] } = {}) => [
  `nodeLinker: ${linker}`,
  'npmRegistryServer: "https://registry.npmjs.org"',
  "enableTelemetry: false",
  ...(pinImmutable ? ["enableImmutableInstalls: false"] : []),
  "enableHardenedMode: false",
  "enableGlobalCache: true",
  "enableScripts: false",
  ...extraLines,
];
export const writeYarnRc = (dir, linker, opts) =>
  writeFileSync(join(dir, ".yarnrc.yml"), [...yarnRcLines(linker, opts), ""].join("\n"));

// The generated benchmark workspace: N apps + M libs (generate.mjs), decataloged
// against the repo's pnpm-workspace.yaml so tools without the pnpm catalog: protocol
// read the same dependency set, with a pnpm-workspace.yaml (read by pnpm) AND a
// package.json "workspaces" field (read by bun, yarn, and npm).
export function scaffoldWorkspace(
  repoRoot,
  dir,
  { apps, libs, modules = 12, name = "bench", extraArgs = [] },
) {
  const node = (args) => {
    const r = spawnSync("node", args, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26 });
    if (r.status !== 0)
      throw new Error(`node ${args.join(" ")} failed:\n${(r.stderr || "").slice(-1000)}`);
  };
  node([
    join(repoRoot, "scripts/generate.mjs"),
    "--apps",
    String(apps),
    "--libs",
    String(libs),
    "--modules",
    String(modules),
    "--clean",
    ...extraArgs,
  ]);
  for (const group of ["apps", "packages"])
    node([
      join(repoRoot, "scripts/rewrite-protocols.mjs"),
      "--dir",
      group,
      "--catalog",
      join(repoRoot, "pnpm-workspace.yaml"),
    ]);
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, private: true, workspaces: ["apps/*", "packages/*"] }) + "\n",
  );
}

// Fetch the pinned yarn standalone CLI from the @yarnpkg/cli-dist npm tarball and assert
// `node yarn.js --version` reports exactly `version` — a wrong or corrupt CLI must fail
// here, not produce numbers attributed to the pin. The temp dir is created under
// `parentDir` so the caller's cleanup owns it.
export function fetchYarnCli(parentDir, version) {
  const dir = mkdtempSync(join(parentDir, "yarncli-"));
  const pack = spawnSync("npm", ["pack", `@yarnpkg/cli-dist@${version}`, "--silent"], {
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
      `npm pack @yarnpkg/cli-dist@${version} failed (status ${pack.status}):\n${(pack.stderr || "").slice(-1000)}`,
    );
  const tgz = (pack.stdout || "").trim().split("\n").pop();
  if (!tgz || !tgz.endsWith(".tgz"))
    throw new Error(`npm pack printed no tarball filename (got "${tgz}")`);
  const tar = spawnSync("tar", ["-xzf", tgz], { cwd: dir, encoding: "utf8" });
  if (tar.error) throw new Error(`cannot spawn tar (${tar.error.code || tar.error.message})`);
  if (tar.status !== 0)
    throw new Error(`extracting ${tgz} failed:\n${(tar.stderr || "").slice(-1000)}`);
  const js = join(dir, "package", "bin", "yarn.js");
  const v = spawnSync("node", [js, "--version"], { cwd: dir, encoding: "utf8" });
  const reported = (v.stdout || "").trim();
  if (v.error || v.status !== 0 || reported !== version)
    throw new Error(`yarn CLI verification failed: expected ${version}, got "${reported}"`);
  return js;
}

export const median = (xs) => {
  if (!xs.length) throw new Error("median of an empty sample set");
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Record protection: in-progress state and non-canonical runs only ever write the
// gitignored partial file; the canonical file is written on COMPLETION of a canonical
// run only — so neither an exploratory run nor a failed canonical run can leave the
// data of record overwritten/truncated.
export function benchOutput(repoRoot, progressRel, finalRel) {
  return {
    progressPath: join(repoRoot, progressRel),
    persist(out) {
      writeFileSync(join(repoRoot, progressRel), JSON.stringify(out, null, 2));
    },
    promote(out) {
      writeFileSync(join(repoRoot, finalRel), JSON.stringify(out, null, 2));
      if (finalRel !== progressRel) rmSync(join(repoRoot, progressRel), { force: true });
    },
  };
}

// Refuse a loaded box (results would be contended) unless the caller's override env var
// is set; returns the {cores, preRunLoadAvg1} record the output JSON must carry so a
// forced contended run stays visible in the data.
export function loadGuard(allowEnvVar) {
  const cores = cpus().length;
  const load1 = loadavg()[0];
  if (load1 > cores / 2 && process.env[allowEnvVar] !== "1")
    throw new Error(
      `box is busy (1-min load ${load1.toFixed(1)} on ${cores} cores) — results would be ` +
        `contended; set ${allowEnvVar}=1 to override`,
    );
  return { cores, preRunLoadAvg1: +load1.toFixed(2) };
}

export const load1Now = () => +loadavg()[0].toFixed(2);

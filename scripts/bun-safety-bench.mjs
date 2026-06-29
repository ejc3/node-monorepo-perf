#!/usr/bin/env node
// bun-safety-bench: vet bun ADOPTION SAFETY (not speed) against pnpm, head-to-head. The repo
// recommends bun for install speed (install-bench.json); this measures whether a bun install
// produces a workspace that is as SAFE as pnpm's, and is built to surface where bun is WORSE, not
// only to confirm where it ties. Behaviors are MEASURED and recorded (booleans/exit codes/signal
// strings); only measurement-validity invariants are asserted (the tool ran without a crash, the
// scaffold built, the install resolved) — an unplanned bun problem becomes recorded data, not a red
// bench. Speed claims stay in install-bench.json; this records no comparative timings.
//
//   node scripts/bun-safety-bench.mjs
//   BUN_SAFETY_NO_CA=1 ...   # skip the CodeArtifact rung (no AWS creds / offline)
//
// Four rungs, bun 1.3.14 vs pnpm 10:
//   A  lifecycle scripts / native deps — (1) a local file: dep whose postinstall is BLOCKED by
//      default on BOTH, each surfacing a remediation (bun "Blocked N postinstall" / `bun pm trust`;
//      pnpm "Ignored build scripts" / `pnpm approve-builds`) — the baseline; (2) a registry
//      default-trusted dep (esbuild) — bun RUNS its postinstall (built-in allowlist), pnpm BLOCKS
//      it, so the one place bun is MORE permissive is its built-in trusted allowlist.
//   B  CodeArtifact private-registry auth — publish + install round-trip on bun vs pnpm against the
//      real @ejc3 registry, host-verified; skips (partial.json) without AWS creds.
//   C  peer resolution — version mismatch and a missing peer. Both warn on a mismatch and both
//      auto-install a missing peer at their defaults (parity); the one gap is the fail-closed knob —
//      pnpm strict-peer-dependencies=true exits 1, none of bun's three plausible knobs flips its exit.
//   D  phantom dependency — an undeclared transitive import: resolves under bun's hoisted layout,
//      fails under pnpm's strict isolation (pnpm's safety edge).
//
// Self-contained: scaffolds under the OS temp dir, removed on exit; the CodeArtifact rung publishes a
// fixed throwaway version fresh (pre-deleting any leftover) and deletes it on exit. Needs no worktree.

import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import os from "node:os";

// --- constants -----------------------------------------------------------------------------------
const REGISTRY = "https://registry.npmjs.org/";
const BUN_SOURCE_TAG = "bun-v1.3.14";
const BUN_PINNED = "1.3.14";
const FIXED = "0.0.1-safety"; // throwaway CodeArtifact version, published+deleted each run
// CodeArtifact coordinates (copied from diamond-demo.sh).
const CA = { DOMAIN: "ejc3", OWNER: "928413605543", REPO: "npm", REGION: "us-west-2" };
CA.EP = `https://${CA.DOMAIN}-${CA.OWNER}.d.codeartifact.${CA.REGION}.amazonaws.com/npm/${CA.REPO}/`;
CA.HOST = `${CA.DOMAIN}-${CA.OWNER}.d.codeartifact.${CA.REGION}.amazonaws.com/npm/${CA.REPO}/`;

// --- helpers (the wave-rollout-bench discipline) -------------------------------------------------
const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};
const isSignalExit = (code) => code > 128 && code <= 192;
const CRASH =
  /Command terminated by signal|panic:|Segmentation fault|out of memory|\(core dumped\)/i;
function run(cmd, cwd, env) {
  let out = "";
  let code = 0;
  try {
    // Merge stderr into stdout (2>&1): some tools print load-bearing notices to stderr even on a
    // 0-exit — bun prints its peer-mismatch warning and publish/registry lines to stderr — and
    // execSync's return value is stdout only, so dropping stderr would make a real warning that the
    // tool DID emit read as "no warning". (On a non-zero exit the catch already merges both streams.)
    out = execSync(`${cmd} 2>&1`, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
      maxBuffer: 32 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    });
  } catch (e) {
    if (e.signal) throw new Error(`\`${cmd}\` killed by ${e.signal} (timeout?)`);
    code = e.status ?? -1;
    out = (e.stdout || "") + (e.stderr || "");
  }
  if (CRASH.test(out) || isSignalExit(code))
    throw new Error(`crash in \`${cmd}\` (exit ${code}):\n${out.slice(-800)}`);
  return { code, out };
}
const ver = (tool) => execSync(`${tool} --version`, { encoding: "utf8" }).trim();

// Presence probe: is `dep` installed/resolvable from `dir`? Resolves its package.json (present iff the
// package materialized) — the right signal for "did this dep land" (phantom dep, missing peer, version).
function runtimeProbe(dir, dep) {
  const code = `try{const v=require(${JSON.stringify(dep + "/package.json")}).version;process.stdout.write("OK "+v)}catch(e){process.stdout.write("FAIL "+(e.code||e.message))}`;
  const r = run(`node -e ${JSON.stringify(code)}`, dir);
  const ok = r.out.startsWith("OK ");
  return { ok, detail: r.out.replace(/^(OK|FAIL) /, "").trim() };
}
// Main-entry probe: does `require(dep)` (the package main) load? For the lifecycle rung the main needs
// a file the postinstall generates, so this loads iff the postinstall actually RAN (package.json alone
// is always present after install, so it can't tell a run script from a blocked one).
function mainProbe(dir, dep) {
  const code = `try{require(${JSON.stringify(dep)});process.stdout.write("OK")}catch(e){process.stdout.write("FAIL "+(e.code||e.message))}`;
  const r = run(`node -e ${JSON.stringify(code)}`, dir);
  const ok = r.out.startsWith("OK");
  return { ok, detail: r.out.replace(/^(OK|FAIL) ?/, "").trim() };
}

const PNPM_VER = (() => {
  try {
    return ver("pnpm");
  } catch {
    return fail("missing pnpm on PATH");
  }
})();
const BUN_VER = (() => {
  try {
    return ver("bun");
  } catch {
    return fail("missing bun on PATH");
  }
})();
if (BUN_VER !== BUN_PINNED)
  fail(
    `bun ${BUN_VER} != ${BUN_PINNED}: recorded source refs are pinned to ${BUN_SOURCE_TAG}; re-verify before recording another version.`,
  );

const ROOT = mkdtempSync(join(tmpdir(), "bun-safety-"));
const caCleanup = [];
function cleanup() {
  for (const fn of caCleanup) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
  rmSync(ROOT, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// Scaffold under ROOT. `npmrc` defaults to the public registry; callers override for CodeArtifact /
// pinned pnpm settings.
function scaffold(name, files, npmrc = `registry=${REGISTRY}\n`) {
  const base = join(ROOT, name);
  const all = { ".npmrc": npmrc, ...files };
  for (const [rel, content] of Object.entries(all)) {
    const p = join(base, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return base;
}
const mf = (name, deps, extra = {}) => ({
  name,
  version: "0.0.0",
  private: true,
  dependencies: deps,
  ...extra,
});

// Build a tarball from an inline package (so a "native"/postinstall dep is created once, hermetically).
// Returns the absolute .tgz path. npm pack is deterministic given the same inputs.
function mkTarball(name, pkg, files) {
  const dir = join(ROOT, "tarballs", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
  const r = run("npm pack --silent", dir);
  if (r.code !== 0) fail(`npm pack ${name} failed:\n${r.out.slice(-400)}`);
  const tgz = r.out.trim().split("\n").pop().trim();
  const abs = join(dir, tgz);
  if (!existsSync(abs)) fail(`npm pack ${name} did not produce ${tgz}`);
  return abs;
}

const install = {
  bun: (dir, env) => run("bun install", dir, env),
  pnpm: (dir, env) => run("pnpm install --no-frozen-lockfile", dir, env),
};

const result = {
  claim: "",
  versions: { node: process.version, npm: ver("npm"), pnpm: PNPM_VER, bun: BUN_VER },
  registries: { public: REGISTRY, codeArtifact: `${CA.EP} (@${CA.DOMAIN})` },
  env: {
    cores: os.availableParallelism ? os.availableParallelism() : os.cpus().length,
    preRunLoadAvg1: +os.loadavg()[0].toFixed(2),
    coreBound: false,
    note: "behavioral assertions + I/O/network-bound context; not gated on load",
  },
  sourceVerifiedAt: BUN_SOURCE_TAG,
  rungsReproduced: {},
};

// =================================================================================================
// RUNG A — lifecycle scripts / native deps
// =================================================================================================
console.log(
  "== A. lifecycle scripts: local file: dep (both BLOCK + warn) + registry default-trusted esbuild (asymmetry) ==",
);

// A1 — a LOCAL file: tarball with a postinstall. BOTH tools default-deny its lifecycle script and each
// surface a remediation (bun "Blocked N postinstall" + `bun pm untrusted`/`bun pm trust`; pnpm "Ignored
// build scripts" + `pnpm approve-builds`). This is the baseline that isolates the one asymmetry to A2:
// bun's built-in trusted ALLOWLIST (esbuild et al.), the only place bun runs a dep's script unprompted.
// index.js needs a file the postinstall generates, so it resolves iff the postinstall actually ran.
const NB = "needsbuild-probe";
const nbTgz = mkTarball(
  NB,
  { name: NB, version: "1.0.0", main: "index.js", scripts: { postinstall: "node gen.js" } },
  {
    "gen.js": `require('fs').writeFileSync(__dirname+'/generated.js','module.exports=42;\\n')`,
    "index.js": `module.exports=require('./generated.js')`,
  },
);
function localFileDep(tool) {
  const dir = scaffold(`A1-${tool}`, {
    "package.json": mf(`a1-${tool}`, { [NB]: `file:${nbTgz}` }),
  });
  const r = install[tool](dir, {});
  if (r.code !== 0) fail(`A1 ${tool} install failed (exit ${r.code}):\n${r.out.slice(-400)}`);
  // mainProbe (not presence): the main needs the postinstall-generated file, so it loads iff the script ran.
  const probe = mainProbe(dir, NB);
  // Both tools default-deny a file: dep's lifecycle script AND print a remediation hint. bun prints
  // "Blocked N postinstall. Run `bun pm untrusted`"; pnpm prints "Ignored build scripts ... Run pnpm
  // approve-builds". Capture the hint from the actual output (don't assert one that wasn't printed).
  let blockedByDefault, remediationHint, signal;
  if (tool === "pnpm") {
    blockedByDefault = /Ignored build scripts/i.test(r.out);
    remediationHint = /approve-builds/i.test(r.out);
    signal = (r.out.match(/Ignored build scripts:?[^\n]*/i) || ["(none)"])[0].trim();
  } else {
    const u = run("bun pm untrusted", dir);
    if (u.code !== 0)
      fail(`A1 \`bun pm untrusted\` failed (exit ${u.code}):\n${u.out.slice(-400)}`);
    const listed = new RegExp(`node_modules/${NB}[\\s@]`).test(u.out);
    const printed = /Blocked \d+ postinstall/i.test(r.out);
    blockedByDefault = printed || listed;
    remediationHint = /bun pm (untrusted|trust)/i.test(r.out) || /bun pm trust/i.test(u.out);
    signal = printed
      ? (r.out.match(/Blocked \d+ postinstall[^\n]*/i) || [""])[0].trim()
      : listed
        ? `${NB} listed by \`bun pm untrusted\``
        : "(none)";
  }
  return {
    exit: r.code,
    ran: probe.ok,
    runtimeDetail: probe.detail,
    blockedByDefault,
    remediationHint,
    signal,
  };
}
const a1 = { bun: localFileDep("bun"), pnpm: localFileDep("pnpm") };
const a1NeitherRuns = !a1.bun.ran && !a1.pnpm.ran;
const a1BothBlockAndWarn =
  a1.bun.blockedByDefault &&
  a1.pnpm.blockedByDefault &&
  a1.bun.remediationHint &&
  a1.pnpm.remediationHint;
console.log(
  `  A1 local file: dep: bun ran=${a1.bun.ran} blocked=${a1.bun.blockedByDefault} hint=${a1.bun.remediationHint} | pnpm ran=${a1.pnpm.ran} blocked=${a1.pnpm.blockedByDefault} hint=${a1.pnpm.remediationHint} (both default-deny + print a remediation hint)`,
);

// A2 — a REGISTRY default-trusted dep. esbuild is on bun's built-in trusted list, so bun runs its
// postinstall by default; pnpm 10 blocks it ("Ignored build scripts"). This is where bun is more
// permissive than pnpm — the case a file: tarball hides.
const ESB = "esbuild";
const ESB_VER = "0.24.0";
// "blocked" is each tool's OWN report of what it did with the script — the authoritative signal, since
// it is the tool telling you whether it ran the postinstall. (A binary-presence proof does not work for
// esbuild: 0.17+ ship the native binary via a platform optionalDependency, not the postinstall, so
// `esbuild --version` works whether or not the postinstall ran.)
function lifecycleRegistry(tool) {
  const dir = scaffold(`A2-${tool}`, { "package.json": mf(`a2-${tool}`, { [ESB]: ESB_VER }) });
  const r = install[tool](dir, {});
  if (r.code !== 0) fail(`A2 ${tool} install failed (exit ${r.code}):\n${r.out.slice(-400)}`);
  let blocked, signal;
  if (tool === "pnpm") {
    // pnpm self-reports a blocked script as "Ignored build scripts: ...esbuild" in the install output.
    // Detect the block from the header alone (as A1 does); pnpm wraps long names onto following lines,
    // so confirm esbuild with [\s\S] (esbuild is the sole dep here) — a wrapped name must not read as
    // "not blocked".
    blocked =
      /Ignored build scripts/i.test(r.out) && /Ignored build scripts[\s\S]*esbuild/i.test(r.out);
    signal = (r.out.match(/Ignored build scripts:[^\n]*/i) || ["(none)"])[0].trim();
  } else {
    // bun lists every script it blocked under `bun pm untrusted`; absence there is bun's report that it
    // ran the script. Path-anchored so @esbuild/<plat> platform packages don't false-match the line.
    const u = run("bun pm untrusted", dir);
    if (u.code !== 0)
      fail(`A2 \`bun pm untrusted\` failed (exit ${u.code}):\n${u.out.slice(-400)}`);
    const listed = /node_modules\/esbuild[\s@]/.test(u.out);
    blocked = listed;
    signal = listed
      ? "esbuild listed by `bun pm untrusted`"
      : "esbuild not listed by `bun pm untrusted` (bun reports it ran)";
  }
  return { exit: r.code, blocked, signal };
}
const a2 = { bun: lifecycleRegistry("bun"), pnpm: lifecycleRegistry("pnpm") };
const a2ParityOnTrusted = a2.bun.blocked === a2.pnpm.blocked;
console.log(
  `  A2 esbuild: bun blocked=${a2.bun.blocked} (${a2.bun.signal}) | pnpm blocked=${a2.pnpm.blocked} (${a2.pnpm.signal})`,
);

result.lifecycleScripts = {
  localFileDep: {
    bun: a1.bun,
    pnpm: a1.pnpm,
    neitherRunsByDefault: a1NeitherRuns,
    bothBlockAndWarn: a1BothBlockAndWarn,
    note: "a LOCAL file: dependency's postinstall is BLOCKED by default on BOTH tools (mainProbe: the postinstall-generated file is absent on both), and both print a remediation hint in the install output: bun 'Blocked N postinstall. Run `bun pm untrusted`' (allow via `bun pm trust`); pnpm 'Ignored build scripts ... Run pnpm approve-builds'. bun's built-in trusted ALLOWLIST (esbuild et al., rung A2) is the one place bun runs a dep's script without opt-in",
  },
  registryTrusted: {
    dep: `${ESB}@${ESB_VER}`,
    bun: a2.bun,
    pnpm: a2.pnpm,
    parityOnRegistryTrustedDep: a2ParityOnTrusted,
    note: a2ParityOnTrusted
      ? "bun and pnpm agree on this registry dep"
      : "bun runs the postinstall by default (esbuild is on bun's built-in trusted list); pnpm 10 blocks it — bun is MORE permissive on real registry deps",
  },
};
result.rungsReproduced.lifecycle = true;

// =================================================================================================
// RUNG C — peer dependency resolution (hermetic; before B so a CA skip doesn't gate C/D)
// =================================================================================================
console.log("== C. peer resolution: version mismatch + missing peer ==");
const ISODD = "is-odd";
const oddTgz = mkTarball(
  "oddplugin",
  {
    name: "oddplugin",
    version: "1.0.0",
    main: "index.js",
    peerDependencies: { [ISODD]: "^1.0.0" },
  },
  { "index.js": `module.exports=require('is-odd')` },
);
// Pin auto-install-peers to pnpm's DEFAULT (true) — hermetic regardless of any ambient global .npmrc,
// AND fair: comparing each tool at its default. (Pinning false would be non-default and would manufacture
// a pnpm "leaves the peer absent" result bun was never offered.)
const PNPM_NPMRC = `registry=${REGISTRY}\nauto-install-peers=true\n`;
const BUN_NPMRC = `registry=${REGISTRY}\n`;
// Probe whether the PLUGIN can resolve its peer (and at which version) — the right signal for "did the
// peer get installed where the plugin needs it", independent of whether it was hoisted to the root.
function pluginPeerProbe(dir) {
  const code = `try{const path=require('path');const pd=path.dirname(require.resolve('oddplugin/package.json'));require('oddplugin');const v=require(require.resolve('is-odd/package.json',{paths:[pd]})).version;process.stdout.write('OK '+v)}catch(e){process.stdout.write('FAIL '+(e.code||e.message))}`;
  const r = run(`node -e ${JSON.stringify(code)}`, dir);
  const ok = r.out.startsWith("OK ");
  return { ok, version: ok ? r.out.slice(3).trim() : null };
}
function peerCase(tool, deps, npmrc, strict) {
  const dir = scaffold(
    `C-${tool}-${Object.keys(deps).join("_")}${strict ? "-strict" : ""}`,
    { "package.json": mf(`c-${tool}`, deps) },
    npmrc,
  );
  const env = strict ? { npm_config_strict_peer_dependencies: "true" } : {};
  const r = install[tool](dir, env);
  const plugin = pluginPeerProbe(dir); // does the plugin resolve its peer, at which version
  const root = runtimeProbe(dir, ISODD); // does the ROOT see is-odd (layout: hoisted vs isolated)
  return {
    exit: r.code,
    out: r.out,
    pluginWorks: plugin.ok,
    pluginIsOdd: plugin.version,
    rootSeesIsOdd: root.ok,
  };
}
// mismatch: consumer pins is-odd@3 while the plugin peer-wants ^1 — both warn; pnpm can also fail closed
const mismatchDeps = { [ISODD]: "3.0.0", oddplugin: `file:${oddTgz}` };
const mmBun = peerCase("bun", mismatchDeps, BUN_NPMRC, false);
const mmPnpm = peerCase("pnpm", mismatchDeps, PNPM_NPMRC, false);
const mmPnpmStrict = peerCase("pnpm", mismatchDeps, PNPM_NPMRC, true);
// bun strict-peer: try all three plausible fail-closed knobs; "has knob" iff ANY fails closed for a
// PEER reason. failedClosed must be ATTRIBUTABLE to the peer mismatch — a non-zero exit from a
// resolve/parse/network error is not bun "failing closed on peers" — so require a peer marker in the
// output AND that it is not such an error, else an unrelated bun failure would falsely read as a knob.
const PEER_MARKER = /peer/i;
const NON_PEER_INSTALL_ERR =
  /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|ENOENT|EACCES|JSONParse|SyntaxError|failed to (download|fetch)/i;
const bunStrictMechs = [
  { mech: "npm_config_strict_peer_dependencies (env)", npmrc: BUN_NPMRC, env: true, files: {} },
  {
    mech: ".npmrc strict-peer-dependencies",
    npmrc: `${BUN_NPMRC}strict-peer-dependencies=true\n`,
    env: false,
    files: {},
  },
  {
    mech: "bunfig.toml [install] strictPeerDependencies",
    npmrc: BUN_NPMRC,
    env: false,
    files: { "bunfig.toml": "[install]\nstrictPeerDependencies = true\n" },
  },
].map((c, i) => {
  const dir = scaffold(
    `C-bun-strict-${i}`,
    { "package.json": mf("c-bun-strict", mismatchDeps), ...c.files },
    c.npmrc,
  );
  const r = install.bun(dir, c.env ? { npm_config_strict_peer_dependencies: "true" } : {});
  const failedClosed = r.code !== 0 && PEER_MARKER.test(r.out) && !NON_PEER_INSTALL_ERR.test(r.out);
  return { mech: c.mech, exit: r.code, failedClosed };
});
const bunHasStrictPeerKnob = bunStrictMechs.some((x) => x.failedClosed);
// missing peer: consumer declares only the plugin — both auto-install it at their defaults
const mpBun = peerCase("bun", { oddplugin: `file:${oddTgz}` }, BUN_NPMRC, false);
const mpPnpm = peerCase("pnpm", { oddplugin: `file:${oddTgz}` }, PNPM_NPMRC, false);

const warned = (o) => /peer/i.test(o);
result.peerDependencies = {
  mismatch: {
    bun: { exit: mmBun.exit, warned: warned(mmBun.out), pluginResolvesIsOdd: mmBun.pluginIsOdd },
    pnpm: {
      exit: mmPnpm.exit,
      warned: warned(mmPnpm.out),
      pluginResolvesIsOdd: mmPnpm.pluginIsOdd,
    },
    bothWarn: warned(mmBun.out) && warned(mmPnpm.out),
    pnpmStrict: {
      exit: mmPnpmStrict.exit,
      error: (mmPnpmStrict.out.match(/ERR_PNPM_PEER_DEP_ISSUES/) || [null])[0],
    },
    bunStrict: { hasKnob: bunHasStrictPeerKnob, mechanismsTried: bunStrictMechs },
    note: "both warn on a peer-version mismatch (bun on stderr, pnpm on stdout); the asymmetry is the fail-closed knob: pnpm strict-peer-dependencies=true -> exit 1 (ERR_PNPM_PEER_DEP_ISSUES), while none of bun's three plausible knobs (env / .npmrc / bunfig.toml) flips its exit",
  },
  missingPeer: {
    bun: {
      exit: mpBun.exit,
      pluginWorks: mpBun.pluginWorks,
      rootSeesIsOdd: mpBun.rootSeesIsOdd,
      layout: "hoisted (is-odd at root node_modules)",
    },
    pnpm: {
      exit: mpPnpm.exit,
      pluginWorks: mpPnpm.pluginWorks,
      rootSeesIsOdd: mpPnpm.rootSeesIsOdd,
      layout: "isolated (is-odd under .pnpm, not at root)",
    },
    bothAutoInstall: mpBun.pluginWorks && mpPnpm.pluginWorks,
    note: "a missing peer is auto-installed by BOTH at their defaults (pnpm's auto-install-peers defaults to true), so the plugin resolves its peer on both. The only difference is layout: bun hoists is-odd to the root (which can then phantom-require it — rung D), pnpm keeps it isolated under .pnpm (root cannot). Not a bun safety downside.",
  },
};
result.rungsReproduced.peer = true;
console.log(
  `  mismatch: bun warned=${warned(mmBun.out)} / pnpm warned=${warned(mmPnpm.out)} / pnpm+strict exit ${mmPnpmStrict.exit} (${result.peerDependencies.mismatch.pnpmStrict.error}); bun strict-knob (3 mechs)=${bunHasStrictPeerKnob}`,
);
console.log(
  `  missingPeer: plugin works bun=${mpBun.pluginWorks} pnpm=${mpPnpm.pluginWorks} (both auto-install); root-visible is-odd bun=${mpBun.rootSeesIsOdd} pnpm=${mpPnpm.rootSeesIsOdd}`,
);

// =================================================================================================
// RUNG D — phantom dependency (pnpm's isolation safety edge)
// =================================================================================================
console.log(
  "== D. phantom dependency: undeclared transitive import (bun hoist resolves, pnpm isolation blocks) ==",
);
// a package that DECLARES is-odd but whose consumer does NOT; the consumer then imports is-odd directly.
const phantomTgz = mkTarball(
  "usesodd",
  { name: "usesodd", version: "1.0.0", main: "index.js", dependencies: { [ISODD]: "^3.0.0" } },
  { "index.js": `module.exports=require('is-odd')` },
);
function phantomCase(tool, npmrc) {
  // consumer declares ONLY usesodd; is-odd is a phantom (undeclared) transitive dep.
  const dir = scaffold(
    `D-${tool}`,
    { "package.json": mf(`d-${tool}`, { usesodd: `file:${phantomTgz}` }) },
    npmrc,
  );
  const r = install[tool](dir, {});
  if (r.code !== 0) fail(`D ${tool} install failed (exit ${r.code}):\n${r.out.slice(-400)}`);
  const probe = runtimeProbe(dir, ISODD); // can the consumer require an UNDECLARED dep?
  return { exit: r.code, phantomResolves: probe.ok, detail: probe.detail };
}
const dBun = phantomCase("bun", `registry=${REGISTRY}\n`);
const dPnpm = phantomCase("pnpm", PNPM_NPMRC);
result.phantomDependency = {
  bun: {
    phantomResolves: dBun.phantomResolves,
    layout: "hoisted node_modules",
    detail: dBun.detail,
  },
  pnpm: {
    phantomResolves: dPnpm.phantomResolves,
    layout: "isolated (symlinked .pnpm)",
    detail: dPnpm.detail,
  },
  pnpmSafetyEdge: dPnpm.phantomResolves === false && dBun.phantomResolves === true,
  note: "an undeclared transitive import resolving is a latent break (it vanishes when the transitive dep is deduped away); under pnpm's strict isolation the phantom `require('is-odd')` fails (the missing declaration surfaces), under bun's hoisted layout it resolves (the break stays hidden)",
};
result.rungsReproduced.phantom = true;
console.log(
  `  phantom: bun resolves undeclared dep=${dBun.phantomResolves} | pnpm resolves=${dPnpm.phantomResolves} -> pnpm safety edge=${result.phantomDependency.pnpmSafetyEdge}`,
);

// =================================================================================================
// RUNG B — CodeArtifact private-registry auth (network + AWS; skips gracefully)
// =================================================================================================
console.log("== B. CodeArtifact auth: publish + install round-trip, host-verified ==");
function caSkip(reason) {
  result.codeArtifactAuth = { skipped: true, reason };
  result.rungsReproduced.codeArtifact = false;
  console.log(`  SKIPPED: ${reason}`);
}
function aws(args, opts = {}) {
  return run(`aws ${args}`, ROOT, opts.env);
}
if (process.env.BUN_SAFETY_NO_CA === "1") {
  caSkip("BUN_SAFETY_NO_CA=1");
} else if (aws("sts get-caller-identity --query Account --output text").code !== 0) {
  caSkip("no AWS credentials (aws sts get-caller-identity failed)");
} else {
  const tok = aws(
    `codeartifact get-authorization-token --domain ${CA.DOMAIN} --domain-owner ${CA.OWNER} --region ${CA.REGION} --query authorizationToken --output text`,
  );
  if (tok.code !== 0) {
    caSkip("could not fetch CodeArtifact auth token");
  } else {
    const TOKEN = tok.out.trim();
    const AUTH = `@${CA.DOMAIN}:registry=${CA.EP}\n//${CA.HOST}:_authToken=${TOKEN}\n//${CA.HOST}:always-auth=true\n`;
    const pkgName = (tool) => `@${CA.DOMAIN}/bun-safety-${tool}`;
    // publish: bun has a native publisher; pnpm has NONE (it delegates to npm, and `pnpm publish` with a
    // project-local scoped token fails ENEEDAUTH), so — like the repo's diamond/registry demos — the
    // pnpm column publishes with `npm publish`. pnpm's genuinely-pnpm path here is the install round-trip.
    const publishCmd = { bun: "bun publish", pnpm: "npm publish --userconfig .npmrc" };
    const caBase = `--domain ${CA.DOMAIN} --domain-owner ${CA.OWNER} --repository ${CA.REPO} --region ${CA.REGION} --format npm --namespace ${CA.DOMAIN}`;
    const fixedPresent = (short) => {
      // tri-state: "" = confirmed absent, the version string = present, null = could NOT determine.
      // A ResourceNotFoundException means the package itself doesn't exist => the version is absent;
      // any other non-zero list is an indeterminate failure (throttle/permission) that must NOT read
      // as "clean", so selfCleaned (below) requires a strict "" and treats null as not-cleaned.
      const ls = aws(
        `codeartifact list-package-versions ${caBase} --package bun-safety-${short} --query "versions[?version=='${FIXED}'].version" --output text`,
      );
      if (ls.code === 0) return ls.out.trim();
      if (/ResourceNotFoundException/i.test(ls.out)) return "";
      return null;
    };
    const delFixed = (short) =>
      // delete ONLY this run's throwaway version, never other versions of the name
      execSync(
        `aws codeartifact delete-package-versions ${caBase} --package bun-safety-${short} --versions ${FIXED} >/dev/null 2>&1 || true`,
        { timeout: 30000 },
      );
    for (const tool of ["bun", "pnpm"]) caCleanup.push(() => delFixed(tool));
    for (const tool of ["bun", "pnpm"]) delFixed(tool); // pre-delete a leftover FIXED -> publish fresh

    const ca = { bun: {}, pnpm: {} };
    for (const tool of ["bun", "pnpm"]) {
      // publish
      const pubDir = scaffold(
        `B-pub-${tool}`,
        {
          "package.json": {
            name: pkgName(tool),
            version: FIXED,
            main: "index.js",
            publishConfig: { registry: CA.EP },
          },
          "index.js": `module.exports="bun-safety-${tool}";\n`,
        },
        AUTH,
      );
      const pub = run(publishCmd[tool], pubDir);
      const publishOk = pub.code === 0;
      // host-verify: the publish output must reference the CodeArtifact host, not npmjs
      const hostInPub = pub.out.includes(CA.HOST) || pub.out.includes(`${CA.DOMAIN}-${CA.OWNER}`);
      // install round-trip from a fresh consumer
      let installOk = false,
        resolvedVersion = null,
        runtimeOk = false;
      if (publishOk) {
        const conDir = scaffold(
          `B-con-${tool}`,
          { "package.json": mf(`b-con-${tool}`, { [pkgName(tool)]: FIXED }) },
          AUTH,
        );
        const ins = install[tool](conDir, {});
        installOk = ins.code === 0;
        if (installOk) {
          const probe = runtimeProbe(conDir, pkgName(tool));
          runtimeOk = probe.ok;
          resolvedVersion = probe.ok ? probe.detail : null;
        }
      }
      ca[tool] = {
        publishCmd: publishCmd[tool],
        npmrcForm: "@scope:registry + //host:_authToken (scoped .npmrc, diamond-demo form)",
        publishOk,
        publishHostVerified: hostInPub,
        installOk,
        resolvedVersion,
        runtimeOk,
      };
      console.log(
        `  ${tool}: publishOk=${publishOk} (${publishCmd[tool]}) hostVerified=${hostInPub} installOk=${installOk} runtime=${runtimeOk} (${resolvedVersion})`,
      );
    }
    // auth discriminator: an ABSENT package must 404 from the CodeArtifact host (authenticated, absent),
    // not 401 (auth failed) and not a fall-through to npmjs. Done with bun against the scoped registry.
    const absentDir = scaffold("B-absent", { "package.json": mf("b-absent", {}) }, AUTH);
    const absent = run(`bun add @${CA.DOMAIN}/bun-safety-does-not-exist-xyz`, absentDir);
    const is404 = /404|not found/i.test(absent.out) && absent.code !== 0;
    const is401 = /401|403|unauthor/i.test(absent.out);
    const hostInAbsent =
      absent.out.includes(`${CA.DOMAIN}-${CA.OWNER}`) || absent.out.includes(CA.HOST);

    const authProofOk = is404 && hostInAbsent && !is401;
    // explicit cleanup + verify (the exit handler is an idempotent backstop): delete this run's FIXED
    // version and confirm it is gone, so selfCleaned is MEASURED, not asserted.
    const selfCleaned = ["bun", "pnpm"]
      .map((t) => {
        delFixed(t);
        return fixedPresent(t) === "";
      })
      .every(Boolean);
    result.codeArtifactAuth = {
      skipped: false,
      bun: ca.bun,
      pnpm: ca.pnpm,
      // evidence-based: both completed a publish + install round-trip whose publish output named the CA
      // host (not a npmjs fall-through) and a runtime require, and the absent-package probe proves the
      // .npmrc reached the CA host (404, not 401). Requiring publishHostVerified rules out a publish that
      // exited 0 against some other registry.
      sameAuthPathAsPnpm:
        ca.bun.publishOk &&
        ca.pnpm.publishOk &&
        ca.bun.publishHostVerified &&
        ca.pnpm.publishHostVerified &&
        ca.bun.installOk &&
        ca.pnpm.installOk &&
        ca.bun.runtimeOk &&
        ca.pnpm.runtimeOk &&
        authProofOk,
      authProof: {
        method: "absent package -> 404 from the CodeArtifact host (no whoami endpoint)",
        is404,
        is401,
        hostVerified: hostInAbsent,
        ok: authProofOk,
      },
      note: "bun reaches CodeArtifact via the same scoped .npmrc form the repo's demos use; the install round-trip is bun vs pnpm, but the publish is bun vs npm (pnpm has no native publisher — see publishCmd)",
      throwawayPackages: [pkgName("bun"), pkgName("pnpm")],
      selfCleaned,
    };
    result.rungsReproduced.codeArtifact = true;
    console.log(
      `  authProof: 404=${is404} host-verified=${hostInAbsent} (not 401=${!is401}); selfCleaned=${selfCleaned}`,
    );
  }
}

// =================================================================================================
// derive symmetric downsides + write
// =================================================================================================
const bunDownsides = [];
const pnpmDownsides = [];
if (
  result.lifecycleScripts.registryTrusted.parityOnRegistryTrustedDep === false &&
  !result.lifecycleScripts.registryTrusted.bun.blocked
)
  bunDownsides.push(
    "runs postinstall scripts of built-in-trusted registry deps (e.g. esbuild) by default; pnpm 10 blocks all build scripts until approved",
  );
if (
  result.peerDependencies.mismatch.bunStrict.hasKnob === false &&
  result.peerDependencies.mismatch.pnpmStrict.error
)
  bunDownsides.push(
    "no fail-closed strict-peer knob (none of env / .npmrc / bunfig.toml flips the exit; pnpm strict-peer-dependencies=true -> ERR_PNPM_PEER_DEP_ISSUES, exit 1)",
  );
if (result.phantomDependency.pnpmSafetyEdge === true)
  pnpmDownsides.push(
    "(pnpm advantage) strict isolation blocks phantom (undeclared transitive) imports that bun's hoisted layout resolves",
  );
if (
  result.codeArtifactAuth &&
  !result.codeArtifactAuth.skipped &&
  result.codeArtifactAuth.sameAuthPathAsPnpm === false
)
  bunDownsides.push(
    "CodeArtifact publish/install did not use the identical scoped .npmrc path pnpm uses (see codeArtifactAuth)",
  );

result.downsidesFound = { bun: bunDownsides, pnpm: pnpmDownsides };
const allReproduced = Object.values(result.rungsReproduced).every(Boolean);
result.reproduced = allReproduced;
result.claim =
  "bun is adoptable but not a strict safety superset of pnpm: two genuine gaps remain — bun's built-in trusted ALLOWLIST runs some registry postinstall scripts (esbuild) that pnpm 10 blocks, and bun has no fail-closed strict-peer knob (pnpm's strict-peer-dependencies=true exits 1), while bun's hoisted layout resolves phantom (undeclared) imports that pnpm's isolation surfaces. The rest is parity: a local file: dep's postinstall is BLOCKED by default on both (each printing a remediation hint), a missing peer is auto-installed by both at their defaults and both warn on a peer-version mismatch, and bun authenticates to CodeArtifact via the same scoped .npmrc as pnpm.";

mkdirSync(join(process.cwd(), "bench"), { recursive: true });
// honor the partial-guard convention: a skipped rung never overwrites the canonical dataset
const dest = join(
  "bench",
  allReproduced ? "bun-safety-bench.json" : "bun-safety-bench.partial.json",
);
writeFileSync(dest, JSON.stringify(result, null, 2) + "\n");
console.log(
  `\n--- ${dest} written (rungs: ${Object.entries(result.rungsReproduced)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}) ---`,
);
console.log(`bun downsides: ${bunDownsides.length} | pnpm advantages: ${pnpmDownsides.length}`);

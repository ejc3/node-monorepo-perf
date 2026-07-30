#!/usr/bin/env node
// Relay codegen in front of the checkers: relay-compiler (Rust) extracts graphql``
// literals, validates them against a schema, and emits typed artifacts in EITHER
// dialect — language: "typescript" for tsgo, language: "flow" for Flow. This bench
// scaffolds one synthetic product tree per dialect (a shared schema + N components,
// each carrying a unique query whose generated $data type the component actually
// consumes), then measures the pipeline both checkers sit behind:
//
//   codegenCold      — relay-compiler over N fresh components (no artifacts)
//   codegenNoChange  — rerun with artifacts present (relay's skip-unchanged path)
//   checkFull        — the checker over components + generated artifacts (the types
//                      are imported and used, so the check validates codegen output
//                      against hand-written code, not just parses it)
//
// Gates: exact artifact count; a schema-invalid query must fail codegen (positive
// control); a seeded type error at the component/artifact boundary must turn each
// checker red. Self-contained under RELAY_WORK (removed on exit unless RELAY_KEEP=1);
// non-destructive to the repo; core-bound (load-guarded, RELAY_ALLOW_BUSY=1).
//
//   node scripts/relay-codegen-bench.mjs
//
// Knobs: RELAY_COMPONENTS (default 10000, canonical), RELAY_SAMPLES (3),
// RELAY_TYPES (schema breadth, 100), FLOW_BIN/FLOW_SOURCE (a specific flow binary +
// provenance label — e.g. the flow-main build; else flow-bin@FLOW_VERSION installed
// into the work dir), RELAY_WORK, RELAY_KEEP=1, RELAY_ALLOW_BUSY=1.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { median, loadGuard } from "./_pm-bench-lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const N = Number(process.env.RELAY_COMPONENTS || 10000);
const SAMPLES = Number(process.env.RELAY_SAMPLES || 3);
const TYPES = Number(process.env.RELAY_TYPES || 100);
const WORK = process.env.RELAY_WORK || "/mnt/fcvm-btrfs/relay-codegen-bench";
const RELAY_VERSION = "21.0.1";
const FLOW_VERSION = "0.321.0";
const FLOW_BIN = process.env.FLOW_BIN || null;
const FLOW_SOURCE = process.env.FLOW_SOURCE || null;

class BenchFailure extends Error {}
const fail = (msg) => {
  throw new BenchFailure(`FAIL: ${msg}`);
};
process.on("uncaughtException", (e) => {
  console.error(e instanceof BenchFailure ? e.message : e);
  process.exit(1);
});
if (!Number.isInteger(N) || N < TYPES) fail("RELAY_COMPONENTS must be an integer >= RELAY_TYPES");
if (FLOW_BIN && !existsSync(FLOW_BIN)) fail(`FLOW_BIN does not exist: ${FLOW_BIN}`);
if (FLOW_BIN && !FLOW_SOURCE) fail("FLOW_BIN requires FLOW_SOURCE (provenance label)");
const envInfo = loadGuard("RELAY_ALLOW_BUSY");

process.on("exit", () => {
  if (process.env.RELAY_KEEP === "1") return;
  rmSync(WORK, { recursive: true, force: true });
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

// ---- scaffold ---------------------------------------------------------------------------------
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const schema = (() => {
  const lines = ["type Query {"];
  for (let k = 0; k < TYPES; k++) lines.push(`  t${k}: T${k}`);
  lines.push("}");
  for (let k = 0; k < TYPES; k++)
    lines.push(`type T${k} { id: ID! f0: Int f1: String f2: Boolean f3: [String] }`);
  return lines.join("\n") + "\n";
})();

const tsComponent = (i) => {
  const k = i % TYPES;
  return `import { graphql } from "relay-runtime";
import type { Comp${i}Query$data } from "./__generated__/Comp${i}Query.graphql";

// module-local: flow's types-first cannot type an EXPORTED tag result, and real
// components consume the tag locally via hooks
const node${i} = graphql\`
  query Comp${i}Query {
    t${k} {
      id
      f0
      f1
    }
  }
\`;

export function render${i}(d: Comp${i}Query$data): string {
  const t = d.t${k};
  return t ? t.id + String(t.f0 ?? 0) + (t.f1 ?? "") + String(node${i} != null) : "";
}
`;
};
const flowComponent = (i) => {
  const k = i % TYPES;
  return `// @flow
import { graphql } from "relay-runtime";
import type { Comp${i}Query$data } from "./__generated__/Comp${i}Query.graphql";

// module-local: flow's types-first cannot type an EXPORTED tag result, and real
// components consume the tag locally via hooks
const node${i} = graphql\`
  query Comp${i}Query {
    t${k} {
      id
      f0
      f1
    }
  }
\`;

export function render${i}(d: Comp${i}Query$data): string {
  const t = d.t${k};
  return t ? t.id + String(t.f0 ?? 0) + (t.f1 ?? "") + String(node${i} != null) : "";
}
`;
};

const trees = {};
for (const lang of ["typescript", "flow"]) {
  const dir = join(WORK, lang === "typescript" ? "ts" : "flow");
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(dir, "schema.graphql"), schema);
  writeFileSync(
    join(dir, "relay.config.json"),
    JSON.stringify({ src: "./src", schema: "./schema.graphql", language: lang }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ private: true, name: `relay-bench-${lang}` }, null, 2) + "\n",
  );
  const ext = lang === "typescript" ? "ts" : "js";
  const gen = lang === "typescript" ? tsComponent : flowComponent;
  for (let i = 0; i < N; i++) writeFileSync(join(src, `Comp${i}.${ext}`), gen(i));
  trees[lang] = dir;
}
console.log(
  `scaffolded 2 trees × ${N.toLocaleString("en-US")} components (${TYPES}-type schema) under ${WORK}`,
);

// tsconfig for the ts tree: check components + generated artifacts as one program
writeFileSync(
  join(trees.typescript, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        module: "esnext",
        target: "es2022",
        moduleResolution: "bundler",
      },
      include: ["src"],
    },
    null,
    2,
  ) + "\n",
);
// relay-compiler 21 still emits `+` variance sigils, which current Flow (released
// 0.321 AND main) rejects as unsupported-syntax — the excludes option grandfathers
// the generated dir. Required line for relay+flow today; recorded in the JSON.
writeFileSync(
  join(trees.flow, ".flowconfig"),
  "[options]\nexperimental.deprecated_variance_sigils.excludes=<PROJECT_ROOT>/src/__generated__\n",
);

// ---- toolchain into the work dir (pinned, never the repo tree) --------------------------------
const toolDir = join(WORK, "tools");
mkdirSync(toolDir, { recursive: true });
writeFileSync(join(toolDir, "package.json"), JSON.stringify({ private: true }) + "\n");
{
  const i = spawnSync(
    "npm",
    [
      "install",
      `relay-compiler@${RELAY_VERSION}`,
      `relay-runtime@${RELAY_VERSION}`,
      `flow-bin@${FLOW_VERSION}`,
      "--no-audit",
      "--no-fund",
    ],
    { cwd: toolDir, encoding: "utf8", timeout: 600_000 },
  );
  if (i.status !== 0) fail(`toolchain install failed:\n${(i.stderr || "").slice(-400)}`);
}
const RELAY = join(toolDir, "node_modules", ".bin", "relay-compiler");
const FLOW_RELEASED = join(toolDir, "node_modules", ".bin", "flow");
let FLOW = FLOW_BIN || FLOW_RELEASED; // may fall back: see the artifact-dialect probe
// tsgo: the repo's pinned native binary, directly resolved (the tsgo-scale-bench
// pattern — resolve the WRAPPER package from the repo root, then the platform package
// from the wrapper's own dir, since a bare resolve from this script can't see it)
const nativeProbe = spawnSync(
  "node",
  [
    "-e",
    `const { realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");
const wrapper = dirname(realpathSync(require.resolve("@typescript/native-preview/package.json")));
const platformPkg = require.resolve("@typescript/native-preview-linux-arm64/package.json", { paths: [wrapper] });
process.stdout.write(join(dirname(platformPkg), "lib", "tsgo"));`,
  ],
  { cwd: REPO, encoding: "utf8" },
);
if (nativeProbe.status !== 0 || !existsSync(nativeProbe.stdout.trim()))
  fail(`tsgo native binary not resolvable:\n${(nativeProbe.stderr || "").slice(-300)}`);
const TSGO = nativeProbe.stdout.trim();
// each tree needs relay-runtime resolvable for the artifact/type imports
for (const dir of Object.values(trees)) {
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  spawnSync("ln", [
    "-s",
    join(toolDir, "node_modules", "relay-runtime"),
    join(dir, "node_modules", "relay-runtime"),
  ]);
}
const relayVersion = (() => {
  const v = spawnSync(RELAY, ["--version"], { encoding: "utf8" });
  return (v.stdout || v.stderr || "").trim() || RELAY_VERSION;
})();
const flowVersion = (() => {
  const v = spawnSync(FLOW, ["version", "--semver"], { encoding: "utf8" });
  const base = v.status === 0 ? v.stdout.trim() : "unknown";
  return FLOW_BIN ? `${base} (${FLOW_SOURCE})` : base;
})();

// ---- timed run under GNU time (wall = Elapsed line's LAST token — the colon gotcha) ------------
function timedRun(bin, args, cwd) {
  const r = spawnSync("/usr/bin/time", ["-v", bin, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout: 1_800_000,
  });
  if (r.error && r.error.code === "ETIMEDOUT") fail(`${bin} timed out (30min)`);
  const out = (r.stdout || "") + (r.stderr || "");
  const wallLine = out.split("\n").find((l) => l.includes("Elapsed (wall clock) time"));
  const tok = wallLine?.trim().split(/\s+/).pop();
  let ms = null;
  if (tok) {
    const p = tok.split(":").map(Number);
    ms = Math.round((p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]) * 1000);
  }
  const rss = /Maximum resident set size \(kbytes\): (\d+)/.exec(out);
  return {
    exit: r.status,
    ms,
    peakRssMB: rss ? Math.round(Number(rss[1]) / 1024) : null,
    out: out.slice(0, 4000),
    outTail: (r.stdout || "").slice(-2400),
  };
}
const sampleMs = (runFn, label) => {
  const runs = [];
  for (let i = 0; i < SAMPLES; i++) {
    const r = runFn(i);
    if (r.exit !== 0) fail(`${label} sample ${i} exited ${r.exit}:\n${r.out.slice(-500)}`);
    if (r.ms === null) fail(`${label} sample ${i}: wall parse failed`);
    runs.push(r);
  }
  return {
    medianMs: median(runs.map((r) => r.ms)),
    samplesMs: runs.map((r) => r.ms),
    peakRssMB: Math.max(...runs.map((r) => r.peakRssMB ?? 0)) || null,
  };
};
const countArtifacts = (dir) => {
  const gen = join(dir, "src", "__generated__");
  return existsSync(gen) ? readdirSync(gen).length : 0;
};
const wipeArtifacts = (dir) =>
  rmSync(join(dir, "src", "__generated__"), { recursive: true, force: true });

// ---- per-language pipeline ---------------------------------------------------------------------
const out = {
  components: N,
  schemaTypes: TYPES,
  samples: SAMPLES,
  versions: {
    relayCompiler: relayVersion,
    tsgo: JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).devDependencies[
      "@typescript/native-preview"
    ],
    flow: flowVersion,
    node: process.version,
  },
  ...envInfo,
  flowConfigNote:
    "relay-compiler 21 flow artifacts use the `+` variance sigil, which current Flow (released 0.321 and main) rejects as unsupported-syntax; checking them requires `[options] experimental.deprecated_variance_sigils.excludes=<PROJECT_ROOT>/src/__generated__` in .flowconfig (set here) — without it the flow leg cannot parse relay's output at all",
  rows: {
    codegenCold:
      "relay-compiler over N fresh components, no artifacts on disk — the from-scratch codegen a CI runner pays",
    codegenNoChange:
      "rerun with all artifacts present and nothing edited — relay's skip-unchanged path (still re-extracts and re-validates every document)",
    checkFull:
      "the checker over components + generated artifacts as one program; every component imports and uses its query's generated $data type, so the check validates codegen output against hand-written code",
    freshnessGate:
      "the checked-in-artifacts CI gate on the TS tree: one no-change codegen + `git status --porcelain` over src/__generated__ (status, not plain diff: it also catches UNTRACKED new artifacts); every timed sample asserts BYTE-STABILITY (a nondeterministic artifact would false-positive the gate on every PR) and a drift positive control (an edited query must dirty the status)",
    fleetPoint:
      "one-sample codegen cold, then the same git-tracked freshness pass (no-change codegen + status) at RELAY_FLEET_COMPONENTS (default 30,000 — one component per fleet app), the O(components) anchor for what a fleet-scale freshness pass costs",
  },
  languages: {},
};

for (const [lang, dir] of Object.entries(trees)) {
  const label = lang === "typescript" ? "ts" : "flow";
  console.log(`\n== ${lang} tree ==`);
  const rec = {};

  // positive control: a schema-invalid query must fail codegen
  {
    const p = join(dir, "src", `Comp0.${lang === "typescript" ? "ts" : "js"}`);
    const orig = readFileSync(p, "utf8");
    writeFileSync(p, orig.replace("id\n", "id\n      noSuchField\n"));
    const r = spawnSync(RELAY, [], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 1 << 26,
      timeout: 600_000,
    });
    writeFileSync(p, orig);
    if (r.status === 0) fail(`${label}: codegen accepted a schema-invalid query (noSuchField)`);
    wipeArtifacts(dir);
  }

  rec.codegenCold = sampleMs(() => {
    wipeArtifacts(dir);
    return timedRun(RELAY, [], dir);
  }, `${label} codegen cold`);
  const artifacts = countArtifacts(dir);
  if (artifacts !== N) fail(`${label}: ${artifacts} artifacts for ${N} components`);
  rec.artifacts = artifacts;
  rec.codegenNoChange = sampleMs(() => timedRun(RELAY, [], dir), `${label} codegen no-change`);
  console.log(
    `  codegen cold ${rec.codegenCold.medianMs}ms · no-change ${rec.codegenNoChange.medianMs}ms · ${artifacts.toLocaleString("en-US")} artifacts`,
  );

  // artifact-dialect probe (flow only): a flow binary that cannot PARSE relay's
  // generated artifacts is a recorded compatibility outcome, and the timing rows fall
  // back to the released flow the artifacts target — never a silent hard-fail
  if (lang === "flow" && FLOW_BIN) {
    spawnSync(FLOW, ["stop"], { cwd: dir, stdio: "ignore" });
    const probe = spawnSync(FLOW, ["check"], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      timeout: 1_800_000,
    });
    spawnSync(FLOW, ["stop"], { cwd: dir, stdio: "ignore" });
    if (probe.status !== 0 && /unsupported-syntax/.test(probe.stdout || "")) {
      const sample = ((probe.stdout || "").match(/^Error [^\n]*\n[\s\S]{0,200}/m) || [""])[0];
      rec.flowMainCompat = {
        rejected: true,
        note: `the FLOW_BIN binary (${FLOW_SOURCE}) rejects relay-compiler ${RELAY_VERSION} flow artifacts — unsupported-syntax on generated files; timing rows below use released flow-bin ${FLOW_VERSION}, the dialect the artifacts target`,
        sampleError: sample.slice(0, 300),
      };
      FLOW = FLOW_RELEASED;
      console.log(
        `  FLOW_BIN rejects the generated artifacts (unsupported-syntax) — recorded; using released ${FLOW_VERSION} for the flow rows`,
      );
    } else if (probe.status !== 0) {
      fail(
        `flow probe failed for a reason other than artifact syntax:\n${(probe.stdout || "").slice(-500)}`,
      );
    }
  }

  // checker positive control: misuse a generated type → red
  const cp = join(dir, "src", `Comp1.${lang === "typescript" ? "ts" : "js"}`);
  const corig = readFileSync(cp, "utf8");
  const seeded = corig.replace(/return t \? t\.id[^;]+;/, 'return t ? t.f0 : "";');
  if (seeded === corig) fail(`${label}: checker control seed did not apply (template drift)`);
  writeFileSync(cp, seeded);
  const redRun =
    lang === "typescript"
      ? spawnSync(TSGO, ["--noEmit", "-p", "tsconfig.json"], {
          cwd: dir,
          encoding: "utf8",
          maxBuffer: 1 << 28,
          timeout: 1_800_000,
        })
      : (spawnSync(FLOW, ["stop"], { cwd: dir, stdio: "ignore" }),
        spawnSync(FLOW, ["check"], {
          cwd: dir,
          encoding: "utf8",
          maxBuffer: 1 << 28,
          timeout: 1_800_000,
        }));
  writeFileSync(cp, corig);
  if (redRun.status === 0)
    fail(`${label}: checker accepted a type misuse of a generated $data type`);

  if (lang === "typescript") {
    rec.check = sampleMs(
      () => timedRun(TSGO, ["--noEmit", "-p", "tsconfig.json"], dir),
      "tsgo check",
    );
    console.log(`  tsgo check ${rec.check.medianMs}ms (peak ${rec.check.peakRssMB}MB)`);
  } else {
    rec.flowUsed = FLOW === FLOW_RELEASED ? `flow-bin ${FLOW_VERSION} (released)` : flowVersion;
    rec.check = sampleMs(() => {
      spawnSync(FLOW, ["stop"], { cwd: dir, stdio: "ignore" });
      return timedRun(FLOW, ["check"], dir);
    }, "flow check");
    spawnSync(FLOW, ["stop"], { cwd: dir, stdio: "ignore" });
    console.log(`  flow check ${rec.check.medianMs}ms (client-measured; peak RSS is the client's)`);
    rec.check.peakRssMB = null; // flow check runs through a spawned server — the client RSS is meaningless
  }
  out.languages[label] = rec;
}

// ---- the checked-in-artifacts freshness gate (TS tree) -----------------------------------------
{
  const dir = trees.typescript;
  console.log("\n== freshness gate (ts tree) ==");
  // a throwaway git repo over the corpus: artifacts TRACKED (that is the practice
  // under test), node_modules ignored
  const git = (args, opts = {}) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 1 << 26, ...opts });
    if (r.status !== 0) fail(`git ${args.join(" ")} failed: ${(r.stderr || "").slice(-200)}`);
    return r.stdout;
  };
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  git(["init", "-q"]);
  git(["-c", "user.email=bench@local", "-c", "user.name=bench", "add", "-A"]);
  git([
    "-c",
    "user.email=bench@local",
    "-c",
    "user.name=bench",
    "commit",
    "-q",
    "-m",
    "corpus + artifacts",
  ]);

  const gateOnce = (expectClean = false) => {
    const cg = timedRun(RELAY, [], dir);
    if (cg.exit !== 0) fail(`freshness codegen exited ${cg.exit}`);
    if (cg.ms === null) fail("freshness codegen: wall parse failed");
    const t0 = process.hrtime.bigint();
    const st = git(["status", "--porcelain", "--", "src/__generated__"]);
    const diffMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    const dirty = st.trim().length > 0;
    // byte-stability is asserted on EVERY timed sample, not a separate probe run —
    // an intermittent rewrite must not be able to publish byteStable:true
    if (expectClean && dirty)
      fail("no-change codegen rewrote artifact bytes — the freshness gate would false-positive");
    return { ms: cg.ms + diffMs, exit: 0, diffMs, dirty };
  };
  const gate = sampleMs(() => gateOnce(true), "freshness gate");
  console.log(`  gate ${gate.medianMs}ms (codegen + status) · byte-stable ✓ (all samples)`);
  // drift positive control: an ALIASED existing field is always schema-valid
  // and always changes the artifact (a new field name could not be guaranteed
  // to exist in the generated schema)
  const p = join(dir, "src", "Comp1.ts");
  const orig = readFileSync(p, "utf8");
  let drift, regreen;
  try {
    writeFileSync(p, orig.replace("id\n", "id\n      driftProbe: id\n"));
    drift = gateOnce();
  } finally {
    writeFileSync(p, orig);
    git(["checkout", "-q", "--", "."]);
    git(["clean", "-qfd", "--", "src/__generated__"]);
  }
  regreen = gateOnce();
  if (!drift.dirty) fail("drift control: an edited query did not dirty the artifact diff");
  if (regreen.dirty) fail("gate not clean after restore — state fault");
  out.freshness = {
    gateMedianMs: gate.medianMs,
    gateSamplesMs: gate.samplesMs,
    byteStable: true, // asserted per timed sample above
    driftDetected: drift.dirty,
  };
  console.log(`  drift detected ✓ · re-green ✓`);
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  rmSync(join(dir, ".gitignore"), { force: true });
}

// ---- the fleet-scale anchor (one sample, labeled) ----------------------------------------------
const FLEET_N = Number(process.env.RELAY_FLEET_COMPONENTS || 30000);
if (!Number.isInteger(FLEET_N) || FLEET_N < 0)
  fail(
    `RELAY_FLEET_COMPONENTS must be a non-negative integer, got ${process.env.RELAY_FLEET_COMPONENTS}`,
  );
if (FLEET_N > 0) {
  console.log(`\n== fleet anchor: ${FLEET_N.toLocaleString("en-US")} components (1 sample) ==`);
  const fdir = join(WORK, "fleet-ts");
  rmSync(fdir, { recursive: true, force: true });
  mkdirSync(join(fdir, "src"), { recursive: true });
  writeFileSync(
    join(fdir, "schema.graphql"),
    readFileSync(join(trees.typescript, "schema.graphql")),
  );
  writeFileSync(
    join(fdir, "relay.config.json"),
    readFileSync(join(trees.typescript, "relay.config.json")),
  );
  for (let i = 0; i < FLEET_N; i++) writeFileSync(join(fdir, "src", `Comp${i}.ts`), tsComponent(i));
  mkdirSync(join(fdir, "node_modules"), { recursive: true });
  spawnSync("ln", [
    "-s",
    join(toolDir, "node_modules", "relay-runtime"),
    join(fdir, "node_modules", "relay-runtime"),
  ]);
  const cold = timedRun(RELAY, [], fdir);
  if (cold.exit !== 0) fail(`fleet-anchor codegen exited ${cold.exit}:\n${cold.out.slice(-400)}`);
  if (cold.ms === null) fail("fleet-anchor cold: wall parse failed");
  const artifacts = countArtifacts(fdir);
  if (artifacts !== FLEET_N) fail(`fleet anchor: ${artifacts} artifacts for ${FLEET_N} components`);
  // the fleet row is the same GIT-TRACKED freshness pass as the 10k gate, not a bare
  // codegen rerun — the claimed quantity is the CI freshness cost, git status included
  const fgit = (args) => {
    const r = spawnSync("git", args, { cwd: fdir, encoding: "utf8", maxBuffer: 1 << 26 });
    if (r.status !== 0) fail(`fleet git ${args.join(" ")} failed: ${(r.stderr || "").slice(-200)}`);
    return r.stdout;
  };
  writeFileSync(join(fdir, ".gitignore"), "node_modules\n");
  fgit(["init", "-q"]);
  fgit(["-c", "user.email=bench@local", "-c", "user.name=bench", "add", "-A"]);
  fgit(["-c", "user.email=bench@local", "-c", "user.name=bench", "commit", "-q", "-m", "corpus"]);
  const noChange = timedRun(RELAY, [], fdir);
  if (noChange.exit !== 0) fail(`fleet-anchor no-change exited ${noChange.exit}`);
  if (noChange.ms === null) fail("fleet-anchor no-change: wall parse failed");
  const t0 = process.hrtime.bigint();
  const st = fgit(["status", "--porcelain", "--", "src/__generated__"]);
  const statusMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (st.trim().length > 0)
    fail(
      "fleet-anchor no-change codegen rewrote artifact bytes — freshness gate would false-positive",
    );
  out.fleetPoint = {
    components: FLEET_N,
    codegenColdMs: cold.ms,
    codegenNoChangeMs: noChange.ms,
    statusMs,
    freshnessMs: noChange.ms + statusMs,
    byteStable: true,
    samples: 1,
  };
  console.log(
    `  cold ${cold.ms}ms · freshness pass ${noChange.ms + statusMs}ms (codegen ${noChange.ms} + status ${statusMs}) · ${artifacts.toLocaleString("en-US")} artifacts`,
  );
  rmSync(fdir, { recursive: true, force: true });
}

// ---- write -------------------------------------------------------------------------------------
const canonical = N === 10000 && SAMPLES === 3 && TYPES === 100 && FLEET_N === 30000;
const file = canonical
  ? "bench/relay-codegen-bench.json"
  : "bench/relay-codegen-bench.partial.json";
writeFileSync(join(REPO, file), JSON.stringify(out, null, 2) + "\n");
console.log(`\n--- ${file} written ---`);

#!/usr/bin/env node
// Lib-revision cost from a lib owner's seat: I own a foundation lib that EVERY app
// imports. What does revving it cost, what does the gate that catches a breaking
// change cost, and how does all of that change with the optimal toolchain (tsgo)
// and with the dependency model (a `workspace:` source dep vs a published npm dep)?
//
//   node scripts/lib-rev-bench.mjs 4000:400
//
// The workspace is generated with `--universal 1 --tsgo-task`, so @demo/lib-001 is a
// pure-sink foundation lib every app and every other lib imports, and every package
// carries both a `typecheck` (tsc) and a `typecheck:tsgo` (tsgo) script so the same
// gate runs under either checker.
//
// What it measures (all local, deterministic, no network):
//   blast radius     turbo --dry dependent counts: foundation (all) vs a leaf lib (few)
//   workspace rev    edit the foundation source ->
//                      * lockfile byte-identical (no `pnpm install`, no publish)
//                      * the lib-owner gate `turbo run typecheck --filter=...foundation`
//                        re-typechecks every dependent (O(repo) — it is universal),
//                        timed under tsc AND tsgo
//   breaking change  give the foundation a breaking signature change -> the gate goes
//                      red and reports the dependent apps/libs that no longer typecheck
//                      (TS2554), timed under tsc AND tsgo (this is the "catch a break in
//                      one of the 4k apps before merge" path)
//   leaf rev         edit a top-layer lib -> the gate tracks its small closure (O(closure))
//   tsc vs tsgo      both checkers on the real lib source as one big program (pure
//                      checker speed, no turbo/build overhead)
//   npm fanout       how a version bump reaches consumers under the registry model:
//                      catalog (1 line in pnpm-workspace.yaml) vs per-consumer pin
//
// The npm model's re-resolve/install cost and lockfile churn after such a bump are
// measured by install-modes-bench (catalog bump = full re-resolve) and
// lockfile-merge-bench; the real registry publish + resolution by
// registry-resolution-demo. This bench adds the workspace-side rev/gate cost and the
// universal-vs-leaf blast contrast that those don't cover.
//
// Turbo respects .gitignore for input hashing and the generated workspace is
// gitignored, so source is made visible for the run (real monorepos track source)
// and restored in finally. TURBO_CACHE_DIR is pinned inside this tree so the
// `rm -rf .turbo` warmup actually clears the cache (in a git worktree Turbo would
// otherwise cache in the primary worktree and "cold" would be a stale hit).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { enterSourceVisible } from "./_source-visible.mjs";

const spec = (process.argv[2] || "4000:400").trim();
const m = spec.match(/^(\d+):(\d+)$/);
if (!m) {
  console.error(`usage: lib-rev-bench.mjs <apps>:<libs>  (got "${spec}")`);
  process.exit(1);
}
const APPS = +m[1];
const LIBS = +m[2];
const MODULES = +(process.env.MODULES || 16);
const UNIVERSAL = 1; // one universal foundation lib (@demo/lib-001)
const SAMPLES = (() => {
  const n = parseInt(process.env.TC_SAMPLES || "3", 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
})();
const ROOT = process.cwd();
const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  TURBO_CACHE_DIR: join(ROOT, ".turbo", "cache"),
};

const appW = String(APPS).length;
const libW = String(LIBS).length;
const pad = (n, w) => String(n).padStart(w, "0");
const libPkg = (i) => `@demo/lib-${pad(i, libW)}`;
const libSym = (i) => `lib${pad(i, libW)}Main`;
const libSrc = (i) => join(ROOT, "packages", `lib-${pad(i, libW)}`, "src", "index.ts");
const FOUNDATION = 1; // @demo/lib-001 — the universal foundation lib
const LEAF = LIBS; // top-layer lib: few dependents (the O(closure) contrast)
const foundationPkg = libPkg(FOUNDATION);

// Run a turbo task and parse its "Tasks:"/"Cached:" summary. `cont` adds --continue
// (run every task even past failures); `allowFail` lets a non-zero exit return its
// parsed summary instead of throwing (used for the deliberately-breaking gate);
// `assertCold` throws unless the parsed cache count is 0 (a measured cold run must not
// be a stale hit). A parse miss is always a failure to surface, like dev-sim.
function turbo(task, filter, { cont = false, allowFail = false, assertCold = false } = {}) {
  const sel = filter ? `--filter=${filter} ` : "";
  const contFlag = cont ? "--continue " : "";
  const cmd = `pnpm exec turbo run ${task} ${sel}${contFlag}--cache=local:rw --concurrency=100% --output-logs=errors-only`;
  const t0 = process.hrtime.bigint();
  let out = "";
  let ok = true;
  try {
    out = execSync(cmd, {
      cwd: ROOT,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    ok = false;
    out = (e.stdout || "") + (e.stderr || "");
    if (!allowFail)
      throw new Error(
        `command failed (a measured turbo run must succeed): ${cmd}\n${out.slice(-1500)}`,
      );
  }
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const t = out.match(/Tasks:\s+(\d+) successful, (\d+) total/);
  if (!t) throw new Error(`could not parse turbo summary from: ${cmd}\n${out.slice(-1500)}`);
  const successful = +t[1];
  const total = +t[2];
  // Require the `Cached:` line to parse: a regex miss must NOT silently default to 0
  // cached and read as a fully cold run. With assertCold, a non-zero cache count means
  // the cache wasn't actually cleared, so the "cold" time is a stale hit — fail hard.
  const c = out.match(/Cached:\s+(\d+) cached/);
  if (!c) throw new Error(`could not parse turbo 'Cached:' line from: ${cmd}\n${out.slice(-1500)}`);
  const cached = +c[1];
  if (assertCold && cached !== 0)
    throw new Error(`expected a cold-cache run but ${cached}/${total} tasks were cached: ${cmd}`);
  // errors-only output prints a failed task's log prefixed with its id, so a failed
  // app typecheck shows up as `@demo/app-NNNN:typecheck` — count the distinct apps.
  const appTypecheckFailures = new Set(out.match(/@demo\/app-\d+:typecheck/g) || []).size;
  const sampleError = (out.match(/error TS\d+[^\n]*/) || [])[0] || null;
  return {
    ms,
    ok,
    total,
    successful,
    failed: total - successful,
    ran: total - cached,
    appTypecheckFailures,
    sampleError,
  };
}

function dryCount(filter) {
  const out = execSync(`pnpm exec turbo run build --filter=${filter} --dry=json`, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  const pkgs = JSON.parse(out).packages;
  if (!Array.isArray(pkgs))
    throw new Error(`turbo --dry=json for ${filter} returned no packages[]`);
  return pkgs.length;
}

// wc -l line count + content hash of the lockfile from a single read.
const lockStat = () => {
  const buf = readFileSync(join(ROOT, "pnpm-lock.yaml"));
  return {
    lines: (buf.toString().match(/\n/g) || []).length, // wc -l
    sha: createHash("sha256").update(buf).digest("hex"),
  };
};

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

// tsc/tsgo over the whole lib source as one big program (the case tsgo targets):
// pure checker speed, no turbo orchestration or build emit. paths map @demo/* to
// source so cross-lib imports resolve without a prior emit. One discarded warmup,
// then SAMPLES timed runs (median reported). Returns null + a note on failure so a
// tooling failure never discards the already-measured gate data.
function aggregateTypecheck(bin) {
  const cfg = join(ROOT, "tsconfig.librev.json");
  const runOnce = () => {
    const t0 = process.hrtime.bigint();
    execSync(`${bin} --noEmit -p ${cfg}`, { cwd: ROOT, stdio: "pipe" });
    return Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  };
  runOnce(); // discarded warmup
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(runOnce());
  return { medianMs: median(samples), minMs: Math.min(...samples), samples };
}

const run = (cmd) => execSync(cmd, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
// Clear Turbo's cache so the NEXT gate is a genuine cold run. Each gate is measured
// from a cold cache so the tsc and tsgo gates pay the same lib-`^build` cost (with a
// warm cache the second gate would inherit the first's builds — a confounded compare).
const coldCache = () => run("rm -rf .turbo node_modules/.cache/turbo");

console.log(`# lib-revision bench: ${APPS} apps / ${LIBS} libs, foundation=${foundationPkg}`);
run(
  `node scripts/generate.mjs --apps ${APPS} --libs ${LIBS} --modules ${MODULES} --universal ${UNIVERSAL} --tsgo-task --clean`,
);
run(`pnpm install --config.confirm-modules-purge=false`);
run("rm -rf .turbo node_modules/.cache/turbo");

// Capture tool versions BEFORE making source visible: if a `--version` call throws,
// .gitignore is still in its original (committed) state, nothing to restore.
const result = {
  apps: APPS,
  libs: LIBS,
  modulesPerLib: MODULES,
  universal: UNIVERSAL,
  foundationLib: foundationPkg,
  leafLib: libPkg(LEAF),
  pnpm: execSync("pnpm --version", { encoding: "utf8" }).trim(),
  turbo: execSync("pnpm exec turbo --version", { cwd: ROOT, encoding: "utf8" }).trim(),
  tsgo: execSync(`${join(ROOT, "node_modules", ".bin", "tsgo")} --version`, {
    encoding: "utf8",
  }).trim(),
  node: process.version,
};
const restoreGi = enterSourceVisible(ROOT);
try {
  // blast radius: how many packages a rev of each lib would rebuild
  const foundationClosure = dryCount(`...${foundationPkg}`);
  const leafClosure = dryCount(`...${libPkg(LEAF)}`);
  const allPackages = APPS + LIBS;
  if (foundationClosure < allPackages) {
    throw new Error(
      `foundation closure ${foundationClosure} < all packages ${allPackages}: --universal ${UNIVERSAL} did not make ${foundationPkg} universal`,
    );
  }
  // the leaf must NOT be universal, or there's no O(repo)-vs-O(closure) contrast to show
  if (leafClosure >= allPackages) {
    throw new Error(
      `leaf closure ${leafClosure} == all packages: ${libPkg(LEAF)} is universal too — no O(closure) contrast`,
    );
  }
  result.blastRadius = { allPackages, foundationClosure, leafClosure };
  console.log(
    `\n## blast radius: ${foundationPkg} -> ${foundationClosure} pkgs (all), ${libPkg(LEAF)} -> ${leafClosure} pkgs`,
  );

  // ---- workspace-model rev of the universal foundation lib --------------------
  // A `workspace:` source edit touches no lockfile and needs no install/publish;
  // the gate that re-checks every dependent is the whole cost. Measure it under tsc
  // and tsgo, each from a cold cache (coldCache before each) so both pay the same
  // lib-`^build` cost. Because the lib is universal a "rev" busts everything anyway,
  // so the cold gate IS the rev-propagation cost.
  console.log("\n## workspace rev: edit the foundation source, run the lib-owner gate");
  const foundationFile = libSrc(FOUNDATION);
  const origFoundation = readFileSync(foundationFile, "utf8");
  const before = lockStat();
  writeFileSync(foundationFile, origFoundation + `\nexport const _rev_marker = ${Date.now()};\n`);
  const after = lockStat();
  if (before.sha !== after.sha) {
    throw new Error("editing workspace lib source changed pnpm-lock.yaml — unexpected");
  }
  coldCache();
  const gateTsc = turbo("typecheck", `...${foundationPkg}`, { assertCold: true });
  coldCache();
  const gateTsgo = turbo("typecheck:tsgo", `...${foundationPkg}`, { assertCold: true });
  result.workspaceRev = {
    lockfileLines: before.lines,
    lockfileIdentical: true, // workspace source edit touches no lockfile
    installNeeded: false, // and needs no `pnpm install` / publish
    gate: {
      tsc: { ms: gateTsc.ms, ran: gateTsc.ran, total: gateTsc.total },
      tsgo: { ms: gateTsgo.ms, ran: gateTsgo.ran, total: gateTsgo.total },
      wallClockSpeedup: gateTsgo.ms ? +(gateTsc.ms / gateTsgo.ms).toFixed(2) : null,
      // end-to-end gate wall-clock ratio: BOTH gates run the same `^build` (tsc emit)
      // and only the --noEmit check differs, so this is diluted toward 1 and is NOT the
      // pure-checker speedup (see tscVsTsgo.speedup for that).
      note: "wall-clock ratio; both gates share the tsc ^build step, so this is build-diluted, not the pure-checker speedup",
    },
  };
  console.log(
    `  lockfile identical: true (no install/publish) · gate tsc ${gateTsc.ms}ms / tsgo ${gateTsgo.ms}ms ` +
      `(${result.workspaceRev.gate.wallClockSpeedup}x wall-clock), ran ${gateTsc.ran}/${gateTsc.total}`,
  );

  // ---- breaking change: the gate must CATCH it (the user's core scenario) ------
  // Give the foundation a breaking signature change (a new required parameter) so
  // every 1-arg caller no longer typechecks; the lib owner's gate must go red and
  // name the dependent apps/libs. Measured under tsc and tsgo, --continue so the
  // full blast is reported. Foundation source restored afterward.
  console.log("\n## breaking change: the gate catches dependents that no longer typecheck");
  const sig = `${libSym(FOUNDATION)}(seed: number)`;
  const broken = origFoundation.replace(sig, `${libSym(FOUNDATION)}(seed: number, scale: number)`);
  if (broken === origFoundation)
    throw new Error(`could not find foundation signature "${sig}" to break`);
  writeFileSync(foundationFile, broken);
  coldCache();
  const breakTsc = turbo("typecheck", `...${foundationPkg}`, {
    cont: true,
    allowFail: true,
    assertCold: true,
  });
  coldCache();
  const breakTsgo = turbo("typecheck:tsgo", `...${foundationPkg}`, {
    cont: true,
    allowFail: true,
    assertCold: true,
  });
  writeFileSync(foundationFile, origFoundation); // restore clean foundation
  result.breakingChange = {
    change: "foundation exported function gains a required parameter",
    tsc: {
      caught: !breakTsc.ok,
      ms: breakTsc.ms,
      failed: breakTsc.failed,
      total: breakTsc.total,
      appTypecheckFailures: breakTsc.appTypecheckFailures,
      sampleError: breakTsc.sampleError,
    },
    tsgo: {
      caught: !breakTsgo.ok,
      ms: breakTsgo.ms,
      failed: breakTsgo.failed,
      total: breakTsgo.total,
      appTypecheckFailures: breakTsgo.appTypecheckFailures,
      sampleError: breakTsgo.sampleError,
    },
  };
  console.log(
    `  tsc:  caught=${!breakTsc.ok} ${breakTsc.failed}/${breakTsc.total} failed ` +
      `(${breakTsc.appTypecheckFailures} app typechecks) in ${breakTsc.ms}ms · ${breakTsc.sampleError || ""}`,
  );
  console.log(
    `  tsgo: caught=${!breakTsgo.ok} ${breakTsgo.failed}/${breakTsgo.total} failed ` +
      `(${breakTsgo.appTypecheckFailures} app typechecks) in ${breakTsgo.ms}ms · ${breakTsgo.sampleError || ""}`,
  );
  // A gate that does NOT go red on a breaking change is a broken measurement, not a
  // result — fail hard rather than write a JSON that records the catch as working. And
  // the red must be the intended per-app arity fanout: for each checker assert app
  // typecheck failures > 0 AND a TS2554 (wrong-arg-count) sample, mirroring
  // optimal-gate-bench's appsWithErrors + TS2554 check — a red from some other error
  // (a stray syntax/import break) is not the catch we claim.
  const arityCaught = (b) =>
    !b.ok && b.appTypecheckFailures > 0 && /TS2554/.test(b.sampleError || "");
  if (!arityCaught(breakTsc) || !arityCaught(breakTsgo)) {
    throw new Error(
      `breaking foundation change was NOT caught as a per-app arity fanout (gate must go red with TS2554): ` +
        `tsc ok=${breakTsc.ok} (${breakTsc.appTypecheckFailures} app typechecks, ${breakTsc.failed}/${breakTsc.total} failed, "${breakTsc.sampleError || "none"}"), ` +
        `tsgo ok=${breakTsgo.ok} (${breakTsgo.appTypecheckFailures} app typechecks, ${breakTsgo.failed}/${breakTsgo.total} failed, "${breakTsgo.sampleError || "none"}")`,
    );
  }

  // ---- leaf rev (O(closure) contrast) -----------------------------------------
  console.log("\n## leaf rev: edit a top-layer lib (few dependents)");
  const leafFile = libSrc(LEAF);
  writeFileSync(
    leafFile,
    readFileSync(leafFile, "utf8") + `\nexport const _rev_marker = ${Date.now()};\n`,
  );
  coldCache();
  const leaf = turbo("typecheck", `...${libPkg(LEAF)}`, { assertCold: true });
  result.leafRev = {
    leafLib: libPkg(LEAF),
    gate: { ms: leaf.ms, ran: leaf.ran, total: leaf.total },
  };
  console.log(`  gate typecheck ${leaf.ms}ms ran ${leaf.ran}/${leaf.total}`);

  // ---- tsc vs tsgo on the real lib source as one big program ------------------
  console.log("\n## tsc vs tsgo on the real lib source (one big program, pure checker speed)");
  const aggIncludeFiles = LIBS * (MODULES + 1); // modules + index per lib
  writeFileSync(
    join(ROOT, "tsconfig.librev.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "nodenext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          esModuleInterop: true,
          isolatedModules: true,
          // No baseUrl and a relative path pattern: tsgo (TS7) removed baseUrl
          // (TS5102) and rejects non-relative path values (TS5090); this form
          // resolves @demo/* to source in both tsc 5.x and tsgo 7.x.
          paths: { "@demo/*": ["./packages/*/src/index.ts"] },
        },
        include: ["packages/*/src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  const tsc = join(ROOT, "node_modules", ".bin", "tsc");
  const tsgo = join(ROOT, "node_modules", ".bin", "tsgo");
  const errText = (e) => ((e.stdout || "") + (e.stderr || "")).toString() || e.message || "";
  let tscAgg = null;
  let tsgoAgg = null;
  let tscNote = null;
  let tsgoNote = null;
  try {
    tscAgg = aggregateTypecheck(tsc);
  } catch (e) {
    tscNote = `tsc failed on the lib program: ${errText(e).slice(-400)}`;
  }
  try {
    tsgoAgg = existsSync(tsgo) ? aggregateTypecheck(tsgo) : null;
    if (!tsgoAgg) tsgoNote = "tsgo binary not found";
  } catch (e) {
    tsgoNote = `tsgo failed on the lib program: ${errText(e).slice(-400)}`;
  }
  const tscMs = tscAgg ? tscAgg.medianMs : null;
  const tsgoMs = tsgoAgg ? tsgoAgg.medianMs : null;
  result.tscVsTsgo = {
    libProgramFiles: aggIncludeFiles,
    tscMs,
    tsgoMs,
    speedup: tscMs && tsgoMs ? +(tscMs / tsgoMs).toFixed(2) : null,
    tsc: tscAgg,
    tsgo: tsgoAgg,
    note: [tscNote, tsgoNote].filter(Boolean).join("; ") || null,
  };
  console.log(
    `  tsc ${tscMs ? tscMs + "ms" : "n/a"} · tsgo ${tsgoMs ? tsgoMs + "ms" : "n/a"} ` +
      `${result.tscVsTsgo.speedup ? "(" + result.tscVsTsgo.speedup + "x)" : ""}${result.tscVsTsgo.note ? " · " + result.tscVsTsgo.note : ""}`,
  );

  // ---- npm-model fanout: how a foundation version bump reaches its consumers ----
  // Count every consumer manifest (apps AND non-foundation libs) that names the
  // foundation, so the per-pin fanout is the true manifest-edit count, not just apps.
  const consumerCount = (group) =>
    readdirSync(join(ROOT, group))
      .map((d) => join(ROOT, group, d, "package.json"))
      .filter(existsSync)
      .filter((p) => {
        const deps = JSON.parse(readFileSync(p, "utf8")).dependencies;
        return deps && deps[foundationPkg];
      }).length;
  const appConsumers = consumerCount("apps");
  const libConsumers = consumerCount("packages");
  // The foundation is universal: every app and every OTHER lib imports it. A degenerate
  // 0 (or partial) count would record a clean fanout that never happened, so assert the
  // full counts before they feed perPin.manifestsChanged.
  if (appConsumers !== APPS)
    throw new Error(
      `appConsumers ${appConsumers} != ${APPS} apps: not every app names the universal foundation ${foundationPkg}`,
    );
  if (libConsumers !== LIBS - UNIVERSAL)
    throw new Error(
      `libConsumers ${libConsumers} != ${LIBS - UNIVERSAL} (LIBS - UNIVERSAL): not every other lib names the universal foundation ${foundationPkg}`,
    );
  result.npmFanout = {
    appConsumers,
    libConsumers,
    // a registry-versioned foundation bumped 1.0.0 -> 1.1.0:
    catalog: { workspaceYamlLinesChanged: 1, manifestsChanged: 0 },
    perPin: { manifestsChanged: appConsumers + libConsumers },
    note: "re-resolve/install time + lockfile churn after such a bump: see install-modes-bench (catalog bump) and lockfile-merge-bench",
  };
  console.log(
    `\n## npm fanout for a foundation version bump: catalog = 1 workspace.yaml line; ` +
      `per-pin = ${appConsumers + libConsumers} manifests (${appConsumers} apps + ${libConsumers} libs)`,
  );

  result.summary = {
    foundationRevReruns: gateTsc.ran,
    leafRevReruns: leaf.ran,
    workspaceRevTouchesLockfile: false,
    workspaceRevNeedsInstall: false,
    gateTscMs: gateTsc.ms,
    gateTsgoMs: gateTsgo.ms,
    gateWallClockSpeedup: result.workspaceRev.gate.wallClockSpeedup, // build-diluted, see gate.note
    breakingChangeCaught: !breakTsc.ok && !breakTsgo.ok,
    pureCheckerSpeedup: result.tscVsTsgo.speedup, // the real tsc-vs-tsgo checker speedup
  };
  mkdirSync(join(ROOT, "bench"), { recursive: true });
  writeFileSync(join(ROOT, "bench/lib-rev-bench.json"), JSON.stringify(result, null, 2));
  console.log("\n--- bench/lib-rev-bench.json written ---");
} finally {
  rmSync(join(ROOT, "tsconfig.librev.json"), { force: true });
  restoreGi();
}

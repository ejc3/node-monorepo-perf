#!/usr/bin/env node
// The ultra-optimal single-workspace stack, measured end to end — no slow baseline,
// just the latest native-compiled tools:
//   install     bun         (workspaces; catalogs dropped to concrete versions so bun installs them)
//   typecheck   tsgo        (the TypeScript native port — the type-error gate)
//   lint        oxlint      (oxc — native Rust linter)
//   orchestrate turbo       (caching + `--filter`/`--affected` scoping)
//
//   node scripts/optimal-gate-bench.mjs 4000:400
//
// Scenario: a lib owner owns a foundation lib every app imports (`@demo/lib-001`,
// generated with `--universal 1`). It installs the workspace with bun, then revs the
// foundation and measures two type-error gates: the optimal one for a universal rev — a
// single tsgo process over the whole workspace from source (it shares each lib's parse
// across all apps and skips the tsc dist builds) — and, as context, the turbo build+tsgo
// gate (per-package, cacheable, scopable; it ALSO emits dist, so it is not like-for-like).
// A breaking foundation signature must turn every dependent app red (TS2554). The leaf
// rev shows where turbo's graph scoping wins instead (O(closure)).
//
// Destructive: it overwrites the root package.json and the generated tree, so it
// REFUSES to run outside a dedicated git worktree (see ~/src/<name>). turbo needs
// `packageManager` in the root manifest to detect a bun workspace, and the generated
// tsconfigs extend the repo-root tsconfig.base.json + turbo.json, so it must run in a
// worktree of THIS repo (those files are present). Generated source is gitignored, so
// it is made visible to Turbo's input hashing for the run, and everything it mutates
// (root package.json, the revved source, tsconfig.whole.json) is restored on exit.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { enterSourceVisible } from "./_source-visible.mjs";

const spec = (process.argv[2] || "4000:400").trim();
const m = spec.match(/^(\d+):(\d+)$/);
if (!m) {
  console.error(`usage: optimal-gate-bench.mjs <apps>:<libs>  (got "${spec}")`);
  process.exit(1);
}
const APPS = +m[1];
const LIBS = +m[2];
const MODULES = +(process.env.MODULES || 16);
const ROOT = process.cwd();
const PKG = join(ROOT, "package.json");
const BUN = existsSync(join(homedir(), ".bun/bin/bun")) ? join(homedir(), ".bun/bin/bun") : "bun";
const env = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  TURBO_CACHE_DIR: join(ROOT, ".turbo", "cache"),
};

const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...opts });

// This bench overwrites the tracked root package.json and regenerates apps/packages,
// so it must run in a throwaway worktree, never the primary tree (a linked worktree's
// git-dir lives under .../worktrees/). This is the guard the per-app/diamond demos get
// for free by scaffolding into a temp dir.
const gitDir = sh("git rev-parse --git-dir", { encoding: "utf8" }).trim();
if (!gitDir.includes("worktrees")) {
  console.error(
    "refusing to run outside a dedicated git worktree — it overwrites package.json and the generated tree.",
  );
  console.error("create one (e.g. `git worktree add ~/src/optimal-bench HEAD`) and run there.");
  process.exit(1);
}

const libW = String(LIBS).length;
const pad = (n, w) => String(n).padStart(w, "0");
const libPkg = (i) => `@demo/lib-${pad(i, libW)}`;
const libSym = (i) => `lib${pad(i, libW)}Main`;
const libSrc = (i) => join(ROOT, "packages", `lib-${pad(i, libW)}`, "src", "index.ts");
const FOUNDATION = 1;
const LEAF = LIBS;
const foundationPkg = libPkg(FOUNDATION);
const bin = (name) => join(ROOT, "node_modules", ".bin", name);
const ver = (name) =>
  existsSync(bin(name))
    ? execSync(`${bin(name)} --version`)
        .toString()
        .trim()
    : null;

const timed = (fn) => {
  const t0 = process.hrtime.bigint();
  const r = fn();
  return { ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), r };
};
const coldCache = () => sh("rm -rf .turbo node_modules/.cache/turbo");
const rmNodeModules = () => sh("find . -name node_modules -type d -prune -exec rm -rf {} +");
const rmLocks = () => {
  for (const f of ["pnpm-lock.yaml", "bun.lock", "bun.lockb"])
    rmSync(join(ROOT, f), { force: true });
};

const WHOLE_TSCONFIG = join(ROOT, "tsconfig.whole.json");

// Run a cold turbo task and parse the "Tasks:"/"Cached:" summary. Used for the turbo
// build+tsgo gate (non-breaking foundation + leaf), which must succeed and run cold —
// any failure throws, and a stale-cache hit (cached != 0) throws, so neither can be
// recorded as a clean cold time.
function turbo(task, filter) {
  const cmd = `${bin("turbo")} run ${task} --filter=${filter} --cache=local:rw --concurrency=100% --output-logs=errors-only`;
  const t0 = process.hrtime.bigint();
  let out;
  try {
    out = sh(cmd, { encoding: "utf8" });
  } catch (e) {
    throw new Error(
      `turbo run must succeed: ${cmd}\n${((e.stdout || "") + (e.stderr || "")).slice(-1500)}`,
    );
  }
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const t = out.match(/Tasks:\s+(\d+) successful, (\d+) total/);
  const c = out.match(/Cached:\s+(\d+) cached, (\d+) total/);
  if (!t || !c) throw new Error(`could not parse turbo summary from: ${cmd}\n${out.slice(-1500)}`);
  const total = +t[2];
  const cached = +c[1];
  if (cached !== 0)
    throw new Error(`expected a cold-cache run but ${cached}/${total} tasks were cached: ${cmd}`);
  return { ms, ran: total - cached, total };
}

// Rev a lib (append a source line so the dependents re-check) and run the scoped turbo
// gate from a cold cache. Used for the foundation context gate (O(repo)) and the leaf
// gate (O(closure)).
function revGate(file, orig, pkg) {
  writeFileSync(file, orig + `\nexport const _rev = ${Date.now()};\n`);
  coldCache();
  return turbo("typecheck:tsgo", `...${pkg}`);
}

// The "one program" optimal gate: a single tsgo process over the WHOLE workspace, with
// `@demo/*` resolved to lib `src` (no per-lib dist build). One process parses each lib's
// source once and shares it across every importing app, and skips the tsc `^build` — the
// optimal type-error gate for a universal rev, where every app must re-check anyway and
// there is nothing to scope away. It is typecheck-only: unlike the turbo gate it emits no
// dist. `declaration:false` because `tsconfig.base.json` sets `declaration:true` (for lib
// dist builds), which would otherwise flag JSX component return types as non-portable
// (TS2883) under `--noEmit`.
const writeWholeTsconfig = () =>
  writeFileSync(
    WHOLE_TSCONFIG,
    JSON.stringify(
      {
        extends: "./tsconfig.base.json",
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          jsx: "preserve",
          noEmit: true,
          declaration: false,
          allowJs: true,
          paths: { "@demo/*": ["./packages/*/src/index.ts"] },
        },
        include: ["apps/*/**/*.ts", "apps/*/**/*.tsx", "packages/*/src/**/*.ts"],
        exclude: ["node_modules", "**/.next"],
      },
      null,
      2,
    ) + "\n",
  );

// Run the whole-workspace tsgo program from scratch (no incremental cache); capture wall
// time + peak RSS (the one-process tradeoff). `/usr/bin/time -v` writes RSS to stderr,
// merged via `2>&1` so it is captured on a clean (zero-exit) run too.
function wholeProgram() {
  const t0 = process.hrtime.bigint();
  let ok = true;
  let out = "";
  try {
    out = sh(`/usr/bin/time -v ${bin("tsgo")} --noEmit -p tsconfig.whole.json 2>&1`, {
      encoding: "utf8",
    });
  } catch (e) {
    ok = false;
    out = (e.stdout || "") + (e.stderr || "");
  }
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const rssKb = +(out.match(/Maximum resident set size \(kbytes\): (\d+)/) || [])[1] || null;
  return {
    ms,
    ok,
    maxRssMB: rssKb ? Math.round(rssKb / 1024) : null,
    errors: (out.match(/error TS\d+/g) || []).length,
    ts2554: (out.match(/error TS2554/g) || []).length,
    appsWithErrors: new Set(out.match(/apps\/app-\d+\//g) || []).size,
    sample: (out.match(/error TS\d+[^\n]*/) || [])[0] || null,
  };
}

// ---- setup: generate, decatalog, bun-installable root ---------------------------
console.log(`# optimal-stack gate: ${APPS} apps / ${LIBS} libs, foundation=${foundationPkg}`);
sh(
  `node scripts/generate.mjs --apps ${APPS} --libs ${LIBS} --modules ${MODULES} --universal 1 --tsgo-task --clean`,
);
// bun ignores pnpm catalogs, so resolve catalog: specs to concrete versions
sh(`node scripts/rewrite-protocols.mjs --dir apps --catalog ${join(ROOT, "pnpm-workspace.yaml")}`);
sh(
  `node scripts/rewrite-protocols.mjs --dir packages --catalog ${join(ROOT, "pnpm-workspace.yaml")}`,
);

// Capture everything we will mutate, and register an idempotent restore that runs on
// normal exit, on a throw, and on Ctrl-C/kill (the signal handlers below turn the signal
// into a process.exit so the 'exit' handler fires). This keeps a failure or an interrupt
// during the long bun install — which runs before enterSourceVisible's own handlers — from
// leaving the worktree dirty: the revved source, the overwritten root package.json, the
// transient tsconfig.whole.json, and the bun lockfile.
const foundationFile = libSrc(FOUNDATION);
const leafFile = libSrc(LEAF);
const origFoundation = readFileSync(foundationFile, "utf8");
const origLeaf = readFileSync(leafFile, "utf8");
const origPkg = readFileSync(PKG, "utf8");
let restoreGi;
let restored = false;
function restoreAll() {
  if (restored) return;
  restored = true;
  if (restoreGi) restoreGi();
  writeFileSync(foundationFile, origFoundation);
  writeFileSync(leafFile, origLeaf);
  writeFileSync(PKG, origPkg);
  rmSync(WHOLE_TSCONFIG, { force: true });
  rmLocks();
}
process.on("exit", restoreAll);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// a bun workspace root that also carries the toolchain so `bun install` brings it,
// and packageManager so turbo detects the workspace.
const toolchain = JSON.parse(origPkg).devDependencies;
const bunVer = execSync(`${BUN} --version`).toString().trim();
writeFileSync(
  PKG,
  JSON.stringify(
    {
      name: "optimal-bench",
      private: true,
      packageManager: `bun@${bunVer}`,
      workspaces: ["apps/*", "packages/*"],
      devDependencies: {
        turbo: toolchain.turbo,
        typescript: toolchain.typescript,
        "@typescript/native-preview": toolchain["@typescript/native-preview"],
        oxlint: "latest",
      },
    },
    null,
    2,
  ) + "\n",
);
rmLocks();

// ---- install: bun, warm-store ---------------------------------------------------
// Pre-warm the global content store + write the lockfile, then wipe node_modules and
// time a second install. "Install the workspace" is the per-clone link cost against a
// warm store (the steady-state CI case), not a one-off network-cold or no-op number.
console.log("\n## install: bun (warm-store, the optimal install)");
sh(`${BUN} install`, { encoding: "utf8" }); // pre-warm store + lockfile (discard timing)
rmNodeModules();
const install = timed(() => sh(`${BUN} install`, { encoding: "utf8" }));
const bunPkgs =
  (install.r.match(/(\d+) packages installed/) ||
    install.r.match(/across (\d+) packages/) ||
    [])[1] || null;
console.log(`  bun install: ${install.ms}ms (${bunPkgs || "?"} packages)`);

const result = {
  apps: APPS,
  libs: LIBS,
  modulesPerLib: MODULES,
  foundationLib: foundationPkg,
  leafLib: libPkg(LEAF),
  stack: { install: "bun", typecheck: "tsgo", lint: "oxlint", orchestrate: "turbo" },
  versions: {
    bun: bunVer,
    tsgo: ver("tsgo"),
    turbo: ver("turbo"),
    oxlint: ver("oxlint"),
    node: process.version,
  },
  install: { tool: "bun", storeWarm: true, ms: install.ms, packages: bunPkgs ? +bunPkgs : null },
};

try {
  restoreGi = enterSourceVisible(ROOT);
  writeWholeTsconfig();

  // ===== the optimal gate: one tsgo program over the whole workspace (from src) =====
  // A universal rev makes every app re-check, so there is nothing to scope away; one
  // process shares each lib's parse across all apps and skips the per-lib dist builds.
  // A throwaway warmup run first absorbs tsgo binary load + first-touch fs caching, so
  // the timed number is comparable to the turbo gate's post-`--dry` cold time.
  console.log("\n## optimal gate: one tsgo program over the whole workspace (from src)");
  writeFileSync(foundationFile, origFoundation + `\nexport const _rev = ${Date.now()};\n`); // non-breaking rev
  wholeProgram(); // warmup, discard
  const whole = wholeProgram();
  if (!whole.ok) {
    throw new Error(
      whole.errors > 0
        ? `whole-program gate not clean on a non-breaking rev (a valid gate must be green): ${whole.errors} errors, sample ${whole.sample}`
        : `whole-program gate failed with no type errors — tsgo/tooling issue (is /usr/bin/time GNU time?): ${whole.sample}`,
    );
  }
  if (whole.maxRssMB == null) {
    throw new Error("whole-program peak RSS not captured — is /usr/bin/time GNU time with -v?");
  }
  result.optimalGate = {
    tool: "tsgo (one program, from src)",
    kind: "typecheck only (no dist emit)",
    ms: whole.ms,
    maxRssMB: whole.maxRssMB,
  };
  console.log(`  ${whole.ms}ms, ${whole.maxRssMB}MB peak RSS (clean baseline)`);

  // ---- breaking change: the one-program gate flags every dependent app ----------
  console.log("\n## breaking change: the one-program gate flags every dependent app");
  const sig = `${libSym(FOUNDATION)}(seed: number)`;
  const broken = origFoundation.replace(sig, `${libSym(FOUNDATION)}(seed: number, scale: number)`);
  if (broken === origFoundation)
    throw new Error(`could not find foundation signature "${sig}" to break`);
  writeFileSync(foundationFile, broken);
  const wbrk = wholeProgram();
  writeFileSync(foundationFile, origFoundation); // un-break before the turbo/leaf gates
  // every app imports the foundation and calls it with one arg, so a breaking signature
  // must turn EVERY app red with the arity error (TS2554) — not merely a non-zero exit.
  const caught = !wbrk.ok && wbrk.appsWithErrors === APPS && wbrk.ts2554 > 0;
  if (!caught) {
    throw new Error(
      `breaking change not caught by the one-program gate: ok=${wbrk.ok} appsWithErrors=${wbrk.appsWithErrors}/${APPS} ts2554=${wbrk.ts2554} sample=${wbrk.sample}`,
    );
  }
  result.breakingChange = {
    tool: "tsgo (one program)",
    caught,
    ms: wbrk.ms,
    appsWithErrors: wbrk.appsWithErrors,
    ts2554: wbrk.ts2554,
    sample: wbrk.sample,
  };
  console.log(
    `  caught=${caught}: ${wbrk.appsWithErrors}/${APPS} apps red, ${wbrk.ts2554}× TS2554, in ${wbrk.ms}ms`,
  );

  // ===== context: turbo build+tsgo, the orchestrated / per-package path =====
  // turbo runs one tsgo per package against built `dist` (per-package caching + graph
  // scoping), at the cost of N process spawns + the tsc `^build`. NOT like-for-like with
  // the one-program gate: this also emits dist (a deploy needs it), so part of the gap is
  // the build, not just process count. For a UNIVERSAL rev there is no scope to exploit,
  // so the one-program type-error gate above is faster. A daemon/graph warmup runs first
  // so the cold time excludes one-time spin-up; the gate is asserted cold.
  console.log("\n## context: turbo build+tsgo gate (orchestrated, O(repo), also emits dist)");
  sh(`${bin("turbo")} run typecheck:tsgo --filter=...${foundationPkg} --dry`);
  result.warmupOk = true;
  const gate = revGate(foundationFile, origFoundation, foundationPkg);
  result.turboGate = {
    tool: "turbo+tsgo (build+check)",
    kind: "tsc dist build (^build) + tsgo typecheck",
    ms: gate.ms,
    ran: gate.ran,
    total: gate.total,
  };
  console.log(`  gate: ${gate.ms}ms, ran ${gate.ran}/${gate.total}`);

  // ---- leaf rev: turbo --filter scopes to the closure (O(closure)) --------------
  // For a NON-universal rev, scoping is the win: turbo checks only the lib's closure.
  console.log("\n## leaf rev: turbo --filter scopes to the closure (O(closure))");
  const leaf = revGate(leafFile, origLeaf, libPkg(LEAF));
  if (leaf.total >= gate.total) {
    throw new Error(
      `leaf closure (${leaf.total}) is not smaller than the foundation closure (${gate.total}) — O(closure) contrast invalid`,
    );
  }
  result.leafGate = { tool: "turbo+tsgo", ms: leaf.ms, ran: leaf.ran, total: leaf.total };
  console.log(`  gate: ${leaf.ms}ms, ran ${leaf.ran}/${leaf.total}`);

  // ---- oxlint: the native-speed lint layer -------------------------------------
  // A completed oxlint run exits 0 (clean / warnings only) or 1 (error-level findings); classify
  // by EXIT CODE, not by a summary line — oxlint's human reporter prints one line per diagnostic
  // and no "Found N" total, so a summary regex never matches. A missing binary (exit 127), usage
  // error (exit 2), panic, or timeout (SIGTERM) is NOT a completed run and must NOT read as a fast
  // clean lint pass. `findings` is exact on exit 0: oxlint's default rules trigger 0 diagnostics
  // (warnings or errors) on this generated re-export tree, so 0 is the full count, not just the
  // error-level subset. On exit 1 the human reporter carries no parseable total, so findings is null
  // (real-app-bench, where a real codebase yields warnings, uses -f json to count every diagnostic).
  console.log("\n## lint: oxlint across the workspace");
  const t0 = process.hrtime.bigint();
  let oxlint;
  try {
    sh(`${bin("oxlint")} apps packages`, { encoding: "utf8", timeout: 120000 });
    oxlint = {
      tool: "oxlint",
      ran: true,
      ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
      findings: 0,
    };
  } catch (e) {
    const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    if (e.signal === "SIGTERM") {
      oxlint = { tool: "oxlint", ran: false, ms, note: "timed out (120s)" };
    } else if (e.status === 1) {
      // exit 1 = oxlint ran and found error-level problems: a completed, timed run. The human
      // reporter carries no parseable total, so record that it ran rather than a (false) count.
      oxlint = { tool: "oxlint", ran: true, ms, findings: null };
    } else {
      // exit 127 (missing binary) / 2 (usage/config) / panic / other = the lint pass did not
      // complete — record it as such, don't let a crash read as success.
      oxlint = {
        tool: "oxlint",
        ran: false,
        ms,
        note: `exited ${e.status ?? e.signal ?? "?"} without completing`,
      };
    }
  }
  result.lint = oxlint;
  console.log(
    oxlint.ran
      ? `  oxlint: ${oxlint.ms}ms (${oxlint.findings ?? "?"} findings)`
      : `  oxlint: ${oxlint.note}`,
  );

  result.summary = {
    bunInstallMs: install.ms,
    optimalGateMs: result.optimalGate.ms,
    optimalGateRssMB: result.optimalGate.maxRssMB,
    breakingChangeCaught: result.breakingChange.caught,
    breakingChangeAppsRed: result.breakingChange.appsWithErrors,
    breakingChangeMs: result.breakingChange.ms,
    turboGateMs: result.turboGate.ms,
    turboGateRan: result.turboGate.ran,
    leafGateMs: result.leafGate.ms,
    leafGateRan: result.leafGate.ran,
    oxlintMs: result.lint.ran ? result.lint.ms : null,
  };
  mkdirSync(join(ROOT, "bench"), { recursive: true });
  writeFileSync(join(ROOT, "bench/optimal-gate-bench.json"), JSON.stringify(result, null, 2));
  console.log("\n--- bench/optimal-gate-bench.json written ---");
} finally {
  restoreAll();
}

#!/usr/bin/env node
// Run the optimal stack (bun install + tsgo --noEmit + oxlint, orchestrated by turbo) against
// REAL, open-source Next.js App Router apps cloned off GitHub at pinned commits — the real-world
// counterpart to the synthetic tiny-app benches. The synthetic apps are one page importing a few
// libs; these are 60-130 source files of real product code. It answers "does the per-app inner
// loop stay cheap on real, larger apps?" and records the FINAGLE friction of wiring a real app
// into this toolchain.
//
// The friction is the point: tsgo (TS7 preview) refuses to start on a real tsconfig — it errors
// on options it has removed (baseUrl, moduleResolution:node/node10, target:es5, downlevelIteration)
// before type-checking anything. So the bench modernizes the config (those four edits) and adds an
// ambient declaration for CSS/asset side-effect imports (normally supplied by `next build` codegen),
// then measures the real typecheck. tsgo exiting non-zero because the app has TYPE errors is data,
// not a bench failure; only a signal/panic is treated as a crash.
//
//   node scripts/real-app-bench.mjs            (REAL_APP_ONLY=vercel-commerce to run one)
//
// Self-contained and non-destructive to this repo: it clones to a btrfs work dir (REAL_APP_WORK,
// default /mnt/fcvm-btrfs/real-app-bench) and removes each clone on exit unless REAL_APP_KEEP=1.
// It runs THIS repo's pinned tool binaries (node_modules/.bin/{tsgo,turbo}) plus oxlint added to
// the app, so the toolchain version is fixed regardless of what the app pins. Core-bound timings
// (tsgo is parallel), so it refuses to run on a loaded box unless REAL_APP_ALLOW_BUSY=1.

import { execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { availableParallelism, loadavg } from "node:os";

const REPO = "/home/ubuntu/pnpm-demo";
const WORK = process.env.REAL_APP_WORK || "/mnt/fcvm-btrfs/real-app-bench";
const KEEP = !!process.env.REAL_APP_KEEP;
const OXLINT_VER = process.env.REAL_APP_OXLINT || "1.71.0";
const DEFAULT_SAMPLES = 3;
const SAMPLES = (() => {
  const n = Math.floor(Number(process.env.REAL_APP_SAMPLES));
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_SAMPLES;
})();

// Real Next.js App Router + TypeScript apps, pinned to a commit so a re-run resolves the same
// source. (Dep .d.ts still resolve at run time, so a checker's error count can drift if an app's
// `^`-ranged deps publish a new major — recorded honestly, not asserted to a fixed number.)
const TARGETS = [
  {
    name: "vercel-commerce",
    repo: "https://github.com/vercel/commerce.git",
    sha: "3761e52e60df9c6a316e067dbfd7032e494d3634",
    lintDir: ".",
  },
  {
    name: "shadcn-taxonomy",
    repo: "https://github.com/shadcn-ui/taxonomy.git",
    sha: "298a8857c7128a0d121e7f699dfd729f23b3966d",
    lintDir: ".",
  },
];

const only = process.env.REAL_APP_ONLY;
const targets = only ? TARGETS.filter((t) => t.name === only) : TARGETS;
if (!targets.length) {
  console.error(
    `no targets (REAL_APP_ONLY=${only}?). known: ${TARGETS.map((t) => t.name).join(", ")}`,
  );
  process.exit(1);
}
// Only a full run at the default sample count is the source of record. A partial run (REAL_APP_ONLY,
// or a non-default REAL_APP_SAMPLES) writes a separate .partial.json and leaves the canonical file
// untouched — a one-app verify run must never clobber the committed two-app dataset.
const canonical = !only && targets.length === TARGETS.length && SAMPLES === DEFAULT_SAMPLES;

const bin = (name) => join(REPO, "node_modules", ".bin", name);
const BUN = existsSync(join(process.env.HOME || "", ".bun/bin/bun"))
  ? join(process.env.HOME, ".bun/bin/bun")
  : "bun";
const TSGO = bin("tsgo");
const TURBO = bin("turbo");
for (const [label, p] of [
  ["tsgo", TSGO],
  ["turbo", TURBO],
]) {
  if (!existsSync(p)) {
    console.error(
      `missing ${label} at ${p} — run \`bun install\`/\`pnpm install\` in ${REPO} first.`,
    );
    process.exit(1);
  }
}

// Core-bound: tsgo is parallel and turbo runs at full concurrency, so a co-tenant hogging cores
// would collapse the timings — refuse on a busy box.
const CORES = availableParallelism();
const load1 = loadavg()[0];
if (load1 > CORES * 0.5 && !process.env.REAL_APP_ALLOW_BUSY) {
  console.error(
    `1-min load average ${load1.toFixed(1)} on ${CORES} cores — busy box; timings would be contended.\n` +
      `Wait for it to quiesce, or set REAL_APP_ALLOW_BUSY=1.`,
  );
  process.exit(1);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2);
};
// Repeats of the same command cluster on a quiet box; a sample far above the median means a
// co-tenant spun up mid-run (the start-of-run guard can't see that) — refuse rather than publish.
function assertNotContended(label, samples) {
  if (samples.length < 2) return;
  const m = median(samples);
  const hi = Math.max(...samples);
  if (hi > 2 * m && hi - m > 50)
    throw new Error(
      `${label}: samples too noisy (${samples.join(",")}ms; max ${hi} > 2x median ${m}) — re-run idle.`,
    );
}
const CRASH =
  /Command terminated by signal|panic:|Segmentation fault|fatal runtime|out of memory|\(core dumped\)/i;
// A child killed by a signal exits 128+signo when run through a shell (execSync masks e.signal to
// null), so detect the kill numerically — not by the shell's wording, which varies (Killed,
// Aborted, Bus error, Terminated). Any such exit is a crash: it must never read as a clean time.
const isSignalExit = (code) => code > 128 && code <= 192;

// Run a command in `cwd`, capturing stdout+stderr, wall ms, and (optionally) GNU-time peak RSS.
// A non-zero exit is returned, not thrown — a checker exits non-zero when it finds errors, which
// is data. A signal/panic IS thrown (a killed run must never read as a clean low time).
function run(cmd, cwd, { rss = false } = {}) {
  const full = rss ? `/usr/bin/time -v ${cmd} 2>&1` : cmd;
  const s = process.hrtime.bigint();
  let out = "";
  let code = 0;
  try {
    out = execSync(full, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    code = e.status ?? -1;
    out = (e.stdout || "") + (e.stderr || "");
    if (e.signal || code < 0 || isSignalExit(code))
      out += `\nCommand terminated by signal ${e.signal || (code > 128 ? code - 128 : "?")}`;
  }
  const ms = Math.round(Number(process.hrtime.bigint() - s) / 1e6);
  if (CRASH.test(out) || isSignalExit(code))
    throw new Error(`crash in \`${cmd}\` (exit ${code}):\n${out.slice(-800)}`);
  const rssMB = rss
    ? Math.round(+(out.match(/Maximum resident set size \(kbytes\): (\d+)/) || [])[1] / 1024) ||
      null
    : null;
  return { ms, code, out, rssMB };
}
const errorCount = (out) => (out.match(/error TS\d+/g) || []).length;
const errorCodes = (out) => {
  const h = {};
  for (const m of out.match(/error TS\d+/g) || []) h[m] = (h[m] || 0) + 1;
  return Object.fromEntries(
    Object.entries(h)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6),
  );
};
// tsgo rejects removed options before type-checking; collect those messages as the finagle reason.
const removedOptions = (out) =>
  [...out.matchAll(/error TS\d+: Option '([^']+)' has been removed/g)].map((m) => m[1]);
// Up to PER_CODE representative diagnostic lines per distinct error code (work-dir prefix stripped),
// so a doc that attributes a code to a cause traces to the actual messages — and to ALL the files
// behind that cause, not just the first one tsgo emits (one-per-code would under-state a cause
// spread across several files, e.g. the same dropped prop across three components).
const errorSample = (out, dir) => {
  const PER_CODE = 3;
  const byCode = {};
  for (const line of out.split("\n")) {
    const m = line.match(/error (TS\d+):/);
    if (!m) continue;
    if (!byCode[m[1]]) byCode[m[1]] = [];
    if (byCode[m[1]].length < PER_CODE) byCode[m[1]].push(line.replaceAll(dir + "/", "").trim());
  }
  return Object.values(byCode).flat().slice(0, 24);
};

// --- source size: app's own .ts/.tsx, excluding deps / build output -----------------------------
function sourceSize(dir) {
  const out = execFileSync(
    "bash",
    [
      "-c",
      `find . \\( -name '*.ts' -o -name '*.tsx' \\) -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/dist/*' -print0 | xargs -0 cat 2>/dev/null | wc -l; find . \\( -name '*.ts' -o -name '*.tsx' \\) -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/dist/*' | wc -l`,
    ],
    { cwd: dir, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  return { loc: +out[0], files: +out[1] };
}

// --- build a tsgo-compatible tsconfig from the app's own (the FINAGLE) ---------------------------
function finagle(dir, appTsconfig) {
  const raw = readFileSync(join(dir, appTsconfig), "utf8");
  // Real Next tsconfigs are plain JSON; tolerate a stray trailing comma but not naive // stripping
  // (paths contain `/*`). Fall back to a comment strip only if a clean parse fails.
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
    parsed = JSON.parse(stripped);
  }
  const c = { ...(parsed.compilerOptions || {}) };
  const removed = [];
  if ("baseUrl" in c) (removed.push("baseUrl"), delete c.baseUrl);
  if ("downlevelIteration" in c) (removed.push("downlevelIteration"), delete c.downlevelIteration);
  if (["node", "node10", "classic", ""].includes(String(c.moduleResolution || "").toLowerCase())) {
    if (c.moduleResolution) removed.push(`moduleResolution=${c.moduleResolution}`);
    c.moduleResolution = "bundler";
  }
  if (["es3", "es5"].includes(String(c.target || "").toLowerCase())) {
    (removed.push(`target=${c.target}`), (c.target = "es2017"));
  }
  c.noEmit = true;
  c.module = c.module || "esnext";
  c.jsx = c.jsx || "react-jsx";
  // baseUrl let bare specifiers resolve from root; tsgo's own suggestion is paths:{"*":["./*"]}.
  c.paths = { "*": ["./*"], ...(c.paths || {}) };
  const ambient = "realbench-ambient.d.ts";
  writeFileSync(
    join(dir, ambient),
    'declare module "*.css";\ndeclare module "*.scss";\ndeclare module "*.svg";\n' +
      'declare module "*.png";\ndeclare module "*.jpg";\ndeclare module "*.webp";\n',
  );
  const cfg = {
    compilerOptions: c,
    // Hand-written source + the stub ambient decl. We do NOT list `next-env.d.ts`: it is generated
    // by `next build`/`next dev` (which this bench never runs) so it is absent in a fresh clone, and
    // listing a never-present file would misstate the program scope. So Next's ambient globals and
    // its generated `.next/types` route types are out of the program — see the doc disclosure.
    include: [ambient, "**/*.ts", "**/*.tsx"],
    exclude: ["node_modules", ".next", "dist"],
  };
  const cfgPath = "tsconfig.realbench.json";
  writeFileSync(join(dir, cfgPath), JSON.stringify(cfg, null, 2));
  // skipLibCheck is inherited from the app's own tsconfig (not set by the finagle); include/exclude
  // record the program scope — hand-written source, NOT the app's `next build`-generated
  // `.next/types` route types or contentlayer codegen, so this is the inner-loop source check,
  // not the app's build-complete `tsc`/`next typecheck` surface.
  return {
    cfgPath,
    ambient,
    removed,
    skipLibCheck: !!c.skipLibCheck,
    include: cfg.include,
    exclude: cfg.exclude,
  };
}

// median of SAMPLES timed runs after one warmup; RSS from the representative (median) run
function medianRun(cmd, dir, { rss = false } = {}) {
  run(cmd, dir, { rss }); // warmup (binary load + first-touch fs)
  const runs = Array.from({ length: SAMPLES }, () => run(cmd, dir, { rss }));
  const samples = runs.map((r) => r.ms);
  assertNotContended(cmd.slice(0, 40), samples);
  const ms = median(samples);
  const rep = runs.reduce((a, b) => (Math.abs(b.ms - ms) < Math.abs(a.ms - ms) ? b : a));
  return { ms, samples, rssMB: rep.rssMB, code: rep.code, out: rep.out };
}

// A turbo run over the single app. The cache dir lives OUTSIDE the app (a sibling) — turbo hashes
// the package's files as inputs, so a cache written inside the package would change the next run's
// hash and miss forever. Real apps don't gitignore `.turbo` either, so the task `inputs` are pinned
// to source globs (below) rather than relying on turbo's default file set.
function turbo(dir, cacheDir, tasks, { warm } = {}) {
  if (!warm) rmSync(cacheDir, { recursive: true, force: true });
  rmSync(join(dir, ".turbo"), { recursive: true, force: true }); // turbo's per-run log dir (not the cache)
  const env = { ...process.env, TURBO_TELEMETRY_DISABLED: "1", TURBO_CACHE_DIR: cacheDir };
  const cmd = `${TURBO} run ${tasks} --cache=local:rw --output-logs=errors-only`;
  const s = process.hrtime.bigint();
  let out = "";
  let code = 0;
  try {
    out = execSync(cmd, {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    code = e.status ?? -1;
    out = (e.stdout || "") + (e.stderr || ""); // a task may exit non-zero (type errors) — still timed
  }
  const ms = Math.round(Number(process.hrtime.bigint() - s) / 1e6);
  const cm = out.match(/Cached:\s+(\d+) cached, (\d+) total/);
  const cached = cm ? +cm[1] : null;
  const total = cm ? +cm[2] : null;
  // A task exiting non-zero on type errors is data — but turbo still prints its run summary. A
  // crash (OOM/panic/segfault → 128+signo) or a non-zero exit with NO summary means turbo itself
  // died: never record that wall time as a clean run.
  if (CRASH.test(out) || isSignalExit(code))
    throw new Error(`turbo crash (\`${tasks}\`, exit ${code}):\n${out.slice(-800)}`);
  if (code !== 0 && cm === null)
    throw new Error(
      `turbo failed to orchestrate (\`${tasks}\`, exit ${code}, no run summary):\n${out.slice(-800)}`,
    );
  return { ms, cached, total };
}

mkdirSync(WORK, { recursive: true });
const cleanups = [];
// Run in reverse (LIFO) so per-app cleanups undo in registration order — the clone removal is
// registered first and must run LAST, after the in-clone restores (package.json, finagle files,
// turbo.json) and the out-of-clone turbo cache removal, or those would error on a deleted dir.
function cleanupAll() {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      fn();
    } catch {}
  }
}
process.on("exit", cleanupAll);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const ver = (p) => execSync(`${p} --version`, { encoding: "utf8" }).trim();
const result = {
  cores: CORES,
  preRunLoadAvg1: +load1.toFixed(2),
  samples: SAMPLES,
  versions: {
    bun: ver(BUN),
    tsgo: ver(TSGO),
    oxlint: OXLINT_VER,
    turbo: ver(TURBO),
    node: process.version,
  },
  // The synthetic tiny-app point, for the size contrast (one page importing ~4 libs).
  syntheticBaseline: (() => {
    try {
      const d = JSON.parse(readFileSync(join(REPO, "bench/dev-loop-bench.json"), "utf8"));
      return {
        app: d.appDev.target,
        tsgoMs: d.appDev.typecheckOnSave.subsequentMs,
        source: "bench/dev-loop-bench.json",
      };
    } catch {
      return null;
    }
  })(),
  apps: [],
};

for (const t of targets) {
  const dir = join(WORK, t.name);
  console.log(`\n======== ${t.name} (${t.sha.slice(0, 10)}) ========`);
  // Clone pinned (shallow). A reused clone (REAL_APP_KEEP, or one left by a crash that skipped
  // cleanup) is trusted only if it is exactly at t.sha with a clean tree — otherwise it could feed
  // a number attributed to the wrong commit. Re-clone on any mismatch, then record the HEAD that
  // was actually measured, not the constant.
  const headAt = () => {
    try {
      return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  const isClean = () => {
    try {
      return execSync("git status --porcelain", { cwd: dir, encoding: "utf8" }).trim() === "";
    } catch {
      return false;
    }
  };
  if (!existsSync(join(dir, ".git")) || headAt() !== t.sha || !isClean()) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execSync(
      `git init -q && git remote add origin ${t.repo} && git fetch -q --depth 1 origin ${t.sha} && git checkout -q FETCH_HEAD`,
      {
        cwd: dir,
        stdio: "ignore",
      },
    );
  }
  const head = headAt();
  if (head !== t.sha) throw new Error(`${t.name}: clone HEAD ${head} != pinned ${t.sha}`);
  if (!KEEP) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  const size = sourceSize(dir);
  console.log(`  source: ${size.files} ts/tsx files, ${size.loc} LOC`);
  // Pristine manifest, captured before any bun install / oxlint add mutates it — restored on exit
  // so a kept (REAL_APP_KEEP) clone is left clean (HEAD==sha, no diff) and can be reused as-is.
  // Register the restore NOW (before the first install writes a lockfile), so a crash anywhere in
  // the per-app work still leaves a kept clone clean rather than dirty.
  const pkgPath = join(dir, "package.json");
  const pristinePkg = readFileSync(pkgPath, "utf8");
  cleanups.push(() => {
    if (existsSync(dir)) {
      writeFileSync(pkgPath, pristinePkg); // undo install/oxlint/name/scripts mutations
      for (const f of ["bun.lock", "bun.lockb"]) rmSync(join(dir, f), { force: true });
    }
  });

  // bun install — warm the store + lockfile (discard), wipe node_modules, then TIME a cold-
  // node_modules install: the per-clone link cost with the store warm (dev-loop's "fresh"
  // definition), so the number is consistent regardless of any pre-existing node_modules.
  run(`${BUN} install`, dir);
  rmSync(join(dir, "node_modules"), { recursive: true, force: true });
  const inst = run(`${BUN} install`, dir);
  if (inst.code !== 0) throw new Error(`${t.name}: bun install failed:\n${inst.out.slice(-800)}`);
  const pkgMatch = inst.out.match(/(\d+) packages installed/);
  console.log(`  bun install: ${inst.ms}ms${pkgMatch ? ` (${pkgMatch[1]} packages)` : ""}`);

  // tsgo: try the app's own config (record the finagle friction), then the modernized config.
  const appTsconfig = t.tsconfig || "tsconfig.json";
  const asis = run(`${TSGO} --noEmit -p ${appTsconfig}`, dir);
  const removedByApp = removedOptions(asis.out);
  const configRejected = removedByApp.length > 0;
  console.log(
    `  tsgo on app's own tsconfig: exit ${asis.code}${configRejected ? ` — REJECTED (removed: ${removedByApp.join(", ")})` : " — accepted"}`,
  );

  const fin = finagle(dir, appTsconfig);
  const { cfgPath, ambient } = fin;
  cleanups.push(() => {
    for (const f of [cfgPath, ambient]) rmSync(join(dir, f), { force: true });
  });
  const tsgo = medianRun(`${TSGO} --noEmit -p ${cfgPath}`, dir, { rss: true });
  const tsgoErrors = errorCount(tsgo.out);
  console.log(
    `  tsgo (finagled): ${tsgo.ms}ms / ${tsgo.rssMB}MB, ${tsgoErrors} type errors (samples ${tsgo.samples.join(",")})`,
  );
  if (tsgoErrors) console.log(`    codes: ${JSON.stringify(errorCodes(tsgo.out))}`);

  // oxlint (config-agnostic): add our pinned version to the app and run it over the source.
  run(`${BUN} add -d oxlint@${OXLINT_VER}`, dir);
  const ox = medianRun(`${bin0(dir, "oxlint")} ${t.lintDir || "."}`, dir);
  const oxFindings = (() => {
    const w = (ox.out.match(/(\d+)\s+warning/i) || [])[1];
    const e = (ox.out.match(/(\d+)\s+error/i) || [])[1];
    return { warnings: w ? +w : 0, errors: e ? +e : 0 };
  })();
  console.log(
    `  oxlint: ${ox.ms}ms (warnings ${oxFindings.warnings}, errors ${oxFindings.errors})`,
  );

  // turbo: wire the two checks into a turbo.json + package scripts, run COLD then WARM (cache hit).
  // Turbo needs a `packageManager` field and a package `name` to resolve a single-package repo;
  // real apps may omit both (vercel/commerce has no `name`), so the finagle supplies them.
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = pkg.name || t.name;
  pkg.packageManager = pkg.packageManager || `bun@${result.versions.bun}`;
  pkg.scripts = {
    ...pkg.scripts,
    "rb:typecheck": `${TSGO} --noEmit -p ${cfgPath}`,
    "rb:lint": `${bin0(dir, "oxlint")} ${t.lintDir || "."}`,
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  // Pin task inputs to source globs so the hash is stable across runs (turbo's default file set
  // would include the regenerated .turbo logs and poison the warm hash).
  const inputs = [
    "**/*.ts",
    "**/*.tsx",
    "**/*.json",
    "**/*.d.ts",
    "!node_modules/**",
    "!.next/**",
    "!.turbo/**",
    "!dist/**",
    "!.git/**",
  ];
  writeFileSync(
    join(dir, "turbo.json"),
    JSON.stringify(
      {
        $schema: "https://turborepo.com/schema.json",
        tasks: { "rb:typecheck": { outputs: [], inputs }, "rb:lint": { outputs: [], inputs } },
      },
      null,
      2,
    ),
  );
  const turboCache = join(WORK, `_turbocache_${t.name}`);
  cleanups.push(() => {
    // Drop the turbo files the bench wrote here (package.json + bun lockfiles are restored by the
    // earlier cleanup); the external cache lives outside the clone, so remove it unconditionally.
    if (existsSync(dir)) {
      rmSync(join(dir, "turbo.json"), { force: true });
      rmSync(join(dir, ".turbo"), { recursive: true, force: true });
    }
    rmSync(turboCache, { recursive: true, force: true });
  });
  // Turbo does not cache a task that exits non-zero, so an app with type/lint errors warm-caches
  // only its passing checks — recorded, not asserted (a clean app caches all; a red one re-runs
  // the red task until fixed). This is the honest turbo-on-a-real-app behavior.
  const tCold = turbo(dir, turboCache, "rb:typecheck rb:lint", {});
  // The cold run just wiped the cache, so it MUST be 0 cached — any hit means a contaminated cache
  // read as a fast "cold" time (the methodology's "cold is actually cold" rule, asserted here as
  // the sibling benches do). The warm side stays recorded-not-asserted (a red task legitimately
  // re-runs until green).
  if (tCold.cached !== 0)
    throw new Error(
      `${t.name}: cold turbo expected 0 cached, got ${tCold.cached}/${tCold.total} — cache not actually cold`,
    );
  const tWarm = turbo(dir, turboCache, "rb:typecheck rb:lint", { warm: true });
  console.log(
    `  turbo (typecheck+lint): cold ${tCold.ms}ms (0/${tCold.total}), warm ${tWarm.ms}ms (cached ${tWarm.cached}/${tWarm.total})`,
  );

  result.apps.push({
    name: t.name,
    repo: t.repo,
    sha: head, // the HEAD actually measured (verified === t.sha above), not the constant
    source: size,
    install: { tool: "bun", ms: inst.ms, packages: pkgMatch ? +pkgMatch[1] : null },
    finagle: {
      appConfigRejected: configRejected,
      removedOptions: fin.removed,
      asisMs: asis.ms, // tsgo's reject-on-config time — the friction, recorded not just described
      asisExit: asis.code,
      skipLibCheck: fin.skipLibCheck, // inherited from the app's own tsconfig, not bench-set
      include: fin.include, // program scope: hand-written source, not Next's generated/ambient types
      exclude: fin.exclude,
    },
    tsgo: {
      ms: tsgo.ms,
      samples: tsgo.samples,
      rssMB: tsgo.rssMB,
      typeErrors: tsgoErrors,
      errorCodes: tsgoErrors ? errorCodes(tsgo.out) : {},
      errorSample: tsgoErrors ? errorSample(tsgo.out, dir) : [],
    },
    oxlint: {
      version: OXLINT_VER,
      ms: ox.ms,
      samples: ox.samples,
      warnings: oxFindings.warnings,
      errors: oxFindings.errors,
    },
    turbo: {
      coldMs: tCold.ms,
      warmMs: tWarm.ms,
      coldCached: tCold.cached,
      cached: tWarm.cached,
      total: tWarm.total,
    },
  });
}

mkdirSync(join(REPO, "bench"), { recursive: true });
const outPath = canonical ? "bench/real-app-bench.json" : "bench/real-app-bench.partial.json";
writeFileSync(join(REPO, outPath), JSON.stringify(result, null, 2));
if (!canonical) {
  const why = [
    only ? `REAL_APP_ONLY=${only}` : null,
    SAMPLES !== DEFAULT_SAMPLES ? `REAL_APP_SAMPLES=${SAMPLES}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  console.log(
    `\n[partial run: ${why}] wrote ${outPath} — canonical bench/real-app-bench.json left untouched.`,
  );
}
console.log(`\n--- ${outPath} written ---`);
console.log(
  JSON.stringify(
    result.apps.map((a) => ({
      name: a.name,
      files: a.source.files,
      loc: a.source.loc,
      tsgoMs: a.tsgo.ms,
      tsgoRssMB: a.tsgo.rssMB,
      errs: a.tsgo.typeErrors,
    })),
    null,
    2,
  ),
);

function bin0(dir, name) {
  return join(dir, "node_modules", ".bin", name);
}

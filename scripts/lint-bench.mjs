#!/usr/bin/env node
// lint-bench.mjs — ESLint vs oxlint, head-to-head, ESLint pointed at oxlint's own rule set. The
// lint axis the repo uses oxlint for but never raced against the incumbent. (TOOLING.md "Lint:
// eslint vs oxlint".)
//
// The fairness problem: oxlint implements a SUBSET of the ESLint ecosystem's rules (ports of
// eslint core + typescript-eslint + react + unicorn + import + jsx-a11y + promise + …, ~700 rules
// across 15 plugins). A naive "default ESLint vs default oxlint" race is not like-for-like —
// ESLint would be slower partly because it is doing MORE. This bench instead points ESLint at
// oxlint's own rule set so the comparison is about engine speed, not coverage breadth:
//
//   - The oxlint side is STANDALONE oxlint at its full capability — all native plugins + all
//     categories + `--type-aware`. No ESLint and no eslint-plugin-oxlint ever runs on the oxlint
//     side; it is purely "what oxlint can do."
//   - The ESLint side is configured from oxlint's coverage AUTHORITATIVELY, not by guesswork:
//     `eslint-plugin-oxlint` (an ESLint plugin, used ONLY to configure the ESLint side) publishes
//     the exact map of which ESLint rules oxlint covers — its `flat/all` config turns them off. We
//     INVERT that map, turning those rules back ON in ESLint with the matching plugins registered.
//     ESLint cannot run ALL of oxlint's set (some oxlint rules have no ESLint port, need an
//     unregistered plugin, or are type-checked → measurement #2), so ESLint runs a STRICT SUBSET of
//     what oxlint covers while oxlint runs its full set. Both rule counts are recorded, but they are
//     not a 1:1 tally (an oxlint rule and an ESLint rule do not map one-to-one) — the load-bearing
//     fact is "ESLint does no MORE work than oxlint", which keeps the ratio CONSERVATIVE. The numbers
//     are wall-clock on a many-core box where oxlint is multithreaded and ESLint is single-process,
//     so the ratio scales with core count. oxlint's run is untouched by any ESLint tooling.
//
// Three measurements, on one generated corpus (N cross-referencing .ts/.tsx modules):
//   1. syntactic (headline) — oxlint at its FULL native set (all plugins + all categories) vs ESLint
//      configured to the rules it can run from that set (registered plugin, non-type-checked). This
//      is NOT identical coverage: ESLint's set is a STRICT SUBSET (some oxlint rules have no ESLint
//      port / need an unregistered plugin / are type-checked), so ESLint does no more work and the
//      ratio is CONSERVATIVE. Both rule counts (oxlint's own number_of_rules; ESLint's matched count)
//      are recorded but are not directly comparable across the tools' separate rule namespaces.
//      ESLint is timed without `--cache` (noCacheMs) and with it
//      (cacheMs); oxlint has no persistent cache, so a single steady-state run is its number — not
//      dressed up as a "warm" cache hit. All times exclude a discarded warmup (steady-state, NOT
//      disk-cold).
//   2. typeAware — ESLint + typescript-eslint TYPE-CHECKED rules (parserOptions.projectService, so
//      ESLint builds the TS program) vs `oxlint --type-aware` (oxlint-tsgolint, tsgo/TS7; covers
//      59/61 typescript-eslint type-aware rules, alpha). The capability that used to be oxlint's
//      gap. Speed + findings + the alpha/coverage caveat.
//   3. layered — the real-world pattern: `eslint-plugin-oxlint` turns OFF the rules oxlint covers,
//      so ESLint runs only the RESIDUAL (rules oxlint has no port for). Records that residual rule
//      count — what a team still needs ESLint for after adopting oxlint.
//
// Correctness net (never let a failure read as success): a dirty FIXTURE seeded with the exact
// violations of a small curated rule set both tools implement is linted by each; the run HARD-FAILS
// unless BOTH flag EXACTLY that set (every expected rule present, none beyond it) with zero fatal
// diagnostics. The speed measurements then HARD-FAIL unless the seeded rules actually appear in the
// findings (no-var/eqeqeq for syntactic, no-floating-promises for type-aware) with no fatal/parse
// diagnostics — so a misconfigured rule set, a parse error counted as findings, or a tool that
// silently no-ops fails loud instead of recording a fast meaningless number.
//
// Self-contained and non-destructive: scaffolds a throwaway workspace under the OS temp dir (never
// the repo tree, so no git worktree needed), bun-installs the toolchains pinned to what npm
// resolves now (recorded), and removes the scaffold on exit. The ESLint/oxlint speed ratio is
// core-bound (oxlint is parallel; type-checked ESLint builds a TS program), so it REFUSES to run on
// a loaded box (1-min loadavg > cores/2) unless LINT_ALLOW_BUSY=1, and records cores/preRunLoadAvg1
// and per-run samples so a contended run is visible → bench/lint-bench.json.
//
//   node scripts/lint-bench.mjs            # defaults: 800 files, 3 samples
//   LINT_FILES=1500 LINT_SAMPLES=5 node scripts/lint-bench.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const REPO = process.cwd();
const fail = (m) => {
  throw new Error(`[lint-bench] ${m}`);
};

// ---- knobs ---------------------------------------------------------------------------------
const FILES = (() => {
  const n = parseInt(process.env.LINT_FILES || "800", 10);
  return Number.isFinite(n) && n >= 50 ? n : 800;
})();
const SAMPLES = (() => {
  const n = parseInt(process.env.LINT_SAMPLES || "3", 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
})();
const TSX_FRACTION = 0.25; // a quarter of the corpus is .tsx (react rules have something to chew)
const ALLOW_BUSY = process.env.LINT_ALLOW_BUSY === "1";

// Toolchain. Pinned to recent majors; the exact resolved versions are recorded in the output so the
// dataset documents what it ran. oxlint-tsgolint (type-aware) is alpha — pin its known line.
const DEPS = {
  eslint: "^9",
  "@eslint/js": "^9",
  typescript: "^5.9",
  "typescript-eslint": "^8",
  "eslint-plugin-react": "^7",
  "eslint-plugin-react-hooks": "^5",
  "eslint-plugin-jsx-a11y": "^6",
  "eslint-plugin-import": "^2",
  "eslint-plugin-unicorn": "^56",
  "eslint-plugin-promise": "^7",
  "eslint-plugin-n": "^17",
  "eslint-plugin-jsdoc": "^50",
  "eslint-plugin-oxlint": "latest",
  oxlint: "latest",
  "oxlint-tsgolint": "latest",
};

// ---- helpers -------------------------------------------------------------------------------
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Run a command, capturing STDOUT and STDERR SEPARATELY (spawnSync, not execSync — the linters
// write their `-f json` report to stdout and warnings/deprecations to stderr, so findings must be
// parsed from stdout alone; concatenating the two breaks JSON.parse). Wall ms + exit code recorded.
// A non-zero exit is DATA (a linter exits non-zero when it finds problems), returned not thrown.
// A signal/crash IS thrown (a killed run must never read as a clean low time).
const isSignalExit = (code) => code > 128 && code <= 192;
const CRASH = /panic:|Segmentation fault|fatal runtime|out of memory|core dumped|RUST_BACKTRACE/i;
function run(cmd, cwd) {
  const t = process.hrtime.bigint();
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", maxBuffer: 1 << 30 });
  const ms = Math.round(Number(process.hrtime.bigint() - t) / 1e6);
  const stdout = r.stdout || "";
  const stderr = r.stderr || "";
  const code = r.status ?? -1;
  // Crash detection on STDERR only — the `-f json` lint report goes to stdout and legitimately
  // contains rule names and message text ("no-unsafe-…", error strings) that would false-trigger the
  // CRASH regex; a real panic/OOM writes to stderr. A signal kill, or a 128<exit≤192 signal-exit, is
  // a crash too. (A plain non-zero exit such as 1 stays DATA — the exit-code sanity check in
  // assertLintRun rejects the non-lint exit codes, e.g. a Rust panic's 101.)
  if (r.signal || CRASH.test(stderr) || isSignalExit(code))
    fail(
      `crash in \`${cmd}\` (exit ${code}, signal ${r.signal}):\n${(stderr + stdout).slice(-600)}`,
    );
  return { ms, code, stdout, stderr };
}

// Median of SAMPLES timed runs of a command (a discarded warmup first to neutralize cold
// page-cache/JIT bias). EVERY timed sample is validated, not just the last — an intermittent
// crash/config-error/partial lint in any sample would otherwise lower the median while the last run
// reads as valid. With a `parse` (parseEslint/parseOxlint), each sample must exit with a lint code
// (0/1) and report the same finding/fatal/file counts as its predecessors. The lint is deterministic
// over the same corpus, so the COUNTS must match exactly (rule ORDER may differ under oxlint's
// threads, so counts — not byte-identical output). Returns the median ms, the raw ms samples, and
// the LAST run's stdout/code/parsed find.
function timedMedian(cmd, cwd, parse) {
  run(cmd, cwd); // discarded warmup
  const samples = [];
  let last, lastFind;
  for (let i = 0; i < SAMPLES; i++) {
    last = run(cmd, cwd);
    samples.push(last.ms);
    if (parse) {
      if (last.code < 0 || last.code > 1)
        fail(
          `${cmd}: sample ${i} exit ${last.code} — a lint exits 0 or 1; anything else is a crash/error.`,
        );
      const f = parse(last.stdout);
      if (!f) fail(`${cmd}: sample ${i} produced unparseable output — config/parse broken.`);
      if (
        lastFind &&
        (f.total !== lastFind.total ||
          f.fatal !== lastFind.fatal ||
          f.filesLinted !== lastFind.filesLinted)
      )
        fail(
          `${cmd}: sample ${i} diverged from a prior sample ` +
            `(total/fatal/files ${f.total}/${f.fatal}/${f.filesLinted} vs ${lastFind.total}/${lastFind.fatal}/${lastFind.filesLinted}) — a non-deterministic/flaky run, not a clean measurement.`,
        );
      lastFind = f;
    }
  }
  return { ms: median(samples), samples, stdout: last.stdout, code: last.code, find: lastFind };
}

// eslint -f json → array of { messages:[{ruleId,severity,fatal}], errorCount, warningCount }, one
// element PER LINTED FILE (so the array length is the file count). severity 2=error, 1=warning; a
// message with fatal:true (or a severity-2 message with NO ruleId) is a parse/config error, NOT a
// lint finding — counted as `fatal` so a broken run can't read as a successful lint. Returns the
// finding total, the distinct rule-id set, the fatal count, and the number of files linted.
function parseEslint(out) {
  let arr;
  try {
    arr = JSON.parse(out);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  let total = 0,
    fatal = 0;
  const ruleIds = new Set();
  for (const f of arr) {
    total += (f.errorCount || 0) + (f.warningCount || 0);
    for (const m of f.messages || []) {
      if (m.fatal || (m.ruleId == null && m.severity === 2)) fatal++;
      if (m.ruleId) ruleIds.add(m.ruleId);
    }
  }
  return { total, ruleIds, fatal, filesLinted: arr.length };
}

// oxlint -f json → { diagnostics:[{code:"eslint(no-debugger)", severity, ...}], number_of_files,
// number_of_rules, ... } (schema confirmed against oxlint 1.71). A diagnostic with NO `code` is a
// non-rule diagnostic (e.g. a config error) — counted as `fatal`. number_of_rules is oxlint's own
// count of rules it actually ran (the authoritative active-rule count). Unknown shape → null.
function parseOxlint(out) {
  let j;
  try {
    j = JSON.parse(out);
  } catch {
    return null;
  }
  if (!j || !Array.isArray(j.diagnostics)) return null;
  let fatal = 0;
  const ruleIds = new Set();
  for (const d of j.diagnostics) {
    if (d.code) ruleIds.add(String(d.code));
    else fatal++; // a diagnostic with no rule code is a non-rule (config) error, not a lint finding
  }
  const numberOfFiles = Number.isFinite(j.number_of_files) ? j.number_of_files : null;
  return {
    total: j.diagnostics.length,
    ruleIds,
    fatal,
    numberOfRules: Number.isFinite(j.number_of_rules) ? j.number_of_rules : null,
    numberOfFiles,
    filesLinted: numberOfFiles, // oxlint reports the file count directly
  };
}

// Assert a parsed result names every rule in `expected` (normalized), has no fatal diagnostics, and
// found something — the strong "the rules that matter actually ran" check (vs a vacuous total>0).
function assertRan(label, find, expected) {
  if (!find) fail(`${label}: unparseable lint output — config/parse broken.`);
  if (find.fatal > 0)
    fail(`${label}: ${find.fatal} fatal/parse diagnostic(s) — a broken setup, not a lint.`);
  if (find.total <= 0) fail(`${label}: 0 findings on the seeded corpus — config/parse broken.`);
  const names = normSet(find.ruleIds);
  const missing = expected.filter((r) => !names.has(r));
  if (missing.length)
    fail(
      `${label}: expected seeded rule(s) not flagged: ${missing.join(", ")} (got {${[...names].sort().join(", ")}}).`,
    );
}

// A lint process exits 0 (clean, or warnings-only) or 1 (errors found). Anything else — 2 (config
// error), 101 (a Rust panic, below the signal-exit band run() catches), 127 (missing binary), -1
// (spawn failure) — is a broken run, NOT a lint result, even when it streamed parseable JSON first.
// Optionally assert it linted exactly `files` files, so a tool that silently linted a subset (and so
// recorded a fast, unfair time) is caught. Used alongside assertRan on every timed lint.
function assertLintRun(label, result, find, files) {
  if (result.code < 0 || result.code > 1)
    fail(`${label}: exit ${result.code} — a lint exits 0 or 1; anything else is an error/crash.`);
  // When a file count is expected, REQUIRE the tool to report it and to equal `files`. A null
  // filesLinted (e.g. oxlint output missing number_of_files) is itself a failure, not a reason to
  // skip the check — otherwise a partial/degenerate run could pass as long as the seeded rules fired.
  if (files != null && find.filesLinted !== files)
    fail(
      `${label}: linted ${find.filesLinted} files, expected ${files} — a partial lint or missing file count.`,
    );
}

// Normalize a rule id from either tool to a bare rule name for set comparison: oxlint
// `eslint(no-debugger)` / `typescript(no-explicit-any)` → `no-debugger` / `no-explicit-any`;
// ESLint `@typescript-eslint/no-x` / `react/no-y` / `no-z` → `no-x` / `no-y` / `no-z`.
function normRule(id) {
  const ox = /^[\w-]+\(([^)]+)\)$/.exec(id);
  if (ox) return ox[1];
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}
const normSet = (ids) => new Set([...ids].map(normRule));

// ---- corpus --------------------------------------------------------------------------------
// N modules that import a few predecessors (a real-ish dependency web for import/unused rules),
// each seeded with a small, fixed set of violations so findings are non-zero and proportional.
function genCorpus(srcDir) {
  mkdirSync(srcDir, { recursive: true });
  for (let i = 0; i < FILES; i++) {
    const isTsx = i % Math.round(1 / TSX_FRACTION) === 0;
    const imports = [];
    for (let k = 1; k <= 3; k++) {
      const j = i - k;
      if (j >= 0) imports.push(j);
    }
    const importLines = imports.map((j) => `import { v${j} } from "./m${j}.js";`).join("\n");
    const sum = imports.map((j) => `v${j}`).join(" + ") || "0";
    // Seeded violations (syntactic): no-var, eqeqeq, an unused binding. Type-aware seed: an
    // un-awaited promise (no-floating-promises) in a fraction of files.
    const seedTypeAware = i % 5 === 0;
    const body = `
export const v${i}: number = ${i} + ${sum};
export function compute${i}(a: number, b: number): number {
  var acc = a; // no-var
  if (a == b) { acc = b; } // eqeqeq
  const unusedLocal${i} = ${i}; // no-unused-vars
  return acc + ${sum};
}
${
  seedTypeAware
    ? `async function side${i}(): Promise<number> { return ${i}; }
export function trigger${i}(): void { side${i}(); } // no-floating-promises (type-aware)\n`
    : ""
}`;
    if (isTsx) {
      writeFileSync(
        join(srcDir, `m${i}.tsx`),
        `${importLines}
${body}
export function View${i}() {
  return <div title="m${i}">{v${i}}</div>;
}
`,
      );
    } else {
      writeFileSync(join(srcDir, `m${i}.ts`), `${importLines}\n${body}\n`);
    }
  }
  return FILES;
}

// A dirty fixture with a known set of violations of a SMALL curated rule set both tools implement
// with aligned semantics — the like-for-like parity proof. Returns the expected rule names.
const PARITY_RULES = [
  "no-debugger",
  "no-var",
  "eqeqeq",
  "no-constant-condition",
  "no-self-compare",
];
function genFixture(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "dirty.ts"),
    `export function dirty(a: number): number {
  debugger; // no-debugger
  var x = a; // no-var
  if (a == x) x = a + 1; // eqeqeq
  if (true) x = x + 1; // no-constant-condition (a constant IF, flagged by both; while(true) is allowed)
  if (x === x) x++; // no-self-compare
  return x;
}
`,
  );
  return PARITY_RULES;
}

// ---- config files --------------------------------------------------------------------------
function writeConfigs(dir) {
  // tsconfig for type-checked ESLint (projectService) and oxlint --type-aware (tsgo/TS7).
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "nodenext",
          strict: true,
          noEmit: true,
          jsx: "react-jsx",
          skipLibCheck: true,
        },
        include: ["src"],
      },
      null,
      2,
    ),
  );

  // ESLint MATCHED config: invert eslint-plugin-oxlint's coverage map → run the subset of oxlint's
  // rules ESLint can (registered plugin, non-type-checked).
  writeFileSync(
    join(dir, "eslint.matched.mjs"),
    `import { Linter } from "eslint";
import oxlint from "eslint-plugin-oxlint";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import importPlugin from "eslint-plugin-import";
import unicorn from "eslint-plugin-unicorn";
import promise from "eslint-plugin-promise";
import n from "eslint-plugin-n";
import jsdoc from "eslint-plugin-jsdoc";

const pluginMap = {
  "@typescript-eslint": tseslint.plugin,
  react, "react-hooks": reactHooks, "jsx-a11y": jsxA11y,
  import: importPlugin, unicorn, promise, n, jsdoc,
};
// Core rule existence, so a core rule eslint has since removed can't make ESLint exit 2
// ("Definition for rule not found") and read as a broken/empty run.
let coreRules;
try { coreRules = new Linter({ configType: "flat" }).getRules(); } catch { coreRules = null; }
// Collect the rule ids oxlint covers (eslint-plugin-oxlint sets each to "off" in flat/all). Enable
// the ones ESLint can actually run here: a registered plugin (or core), the rule present in this
// plugin version, and NOT a type-checked rule — those are the type-aware race (measurement #2), so
// excluding them keeps #1 syntactic and fair against oxlint's non-type-aware run.
const covered = {};
for (const cfg of oxlint.configs["flat/all"]) Object.assign(covered, cfg.rules || {});
const rules = {};
for (const id of Object.keys(covered)) {
  const ns = id.includes("/") ? id.slice(0, id.indexOf("/")) : null;
  if (ns === null) {
    if (coreRules && !coreRules.has(id)) continue;
    rules[id] = "warn";
    continue;
  }
  const plugin = pluginMap[ns];
  if (!plugin) continue;
  const bare = id.slice(id.indexOf("/") + 1);
  const rule = plugin.rules?.[bare];
  if (!rule) continue;
  if (ns === "@typescript-eslint" && rule.meta?.docs?.requiresTypeChecking) continue;
  rules[id] = "warn";
}

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: pluginMap,
    settings: { react: { version: "detect" } },
    rules,
  },
];
`,
  );

  // ESLint TYPE-CHECKED config: only typescript-eslint type-checked rules (build the TS program).
  writeFileSync(
    join(dir, "eslint.typed.mjs"),
    `import tseslint from "typescript-eslint";
export default [
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
];
`,
  );

  // ESLint LAYERED config: recommended sets, then eslint-plugin-oxlint turns off oxlint-covered
  // rules — what ESLint still does after adopting oxlint (the residual).
  writeFileSync(
    join(dir, "eslint.layered.mjs"),
    `import js from "@eslint/js";
import tseslint from "typescript-eslint";
import oxlint from "eslint-plugin-oxlint";
export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  ...oxlint.configs["flat/all"], // last: turns off everything oxlint covers
];
`,
  );

  // ESLint PARITY config: the small curated set only.
  writeFileSync(
    join(dir, "eslint.parity.mjs"),
    `import tseslint from "typescript-eslint";
export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-debugger": "error",
      "no-var": "error",
      "eqeqeq": "error",
      "no-constant-condition": "error",
      "no-self-compare": "error",
    },
  },
];
`,
  );

  // oxlint FULL: all plugins + all categories (its full capability).
  writeFileSync(
    join(dir, ".oxlintrc.full.json"),
    JSON.stringify(
      {
        plugins: [
          "eslint",
          "react",
          "unicorn",
          "typescript",
          "oxc",
          "import",
          "jsdoc",
          "jsx-a11y",
          "promise",
          "node",
        ],
        categories: {
          correctness: "warn",
          suspicious: "warn",
          pedantic: "warn",
          perf: "warn",
          style: "warn",
          restriction: "warn",
        },
      },
      null,
      2,
    ),
  );

  // oxlint PARITY: the curated set only (categories off, just these rules).
  writeFileSync(
    join(dir, ".oxlintrc.parity.json"),
    JSON.stringify(
      {
        plugins: ["eslint"],
        categories: { correctness: "off" },
        rules: {
          "no-debugger": "error",
          "no-var": "error",
          eqeqeq: "error",
          "no-constant-condition": "error",
          "no-self-compare": "error",
        },
      },
      null,
      2,
    ),
  );
}

// ---- main ----------------------------------------------------------------------------------
const cores = os.cpus().length;
const load1 = os.loadavg()[0];
if (!ALLOW_BUSY && load1 > cores / 2)
  fail(
    `box too loaded (1-min loadavg ${load1.toFixed(2)} > cores/2 ${cores / 2}). Re-run idle or set LINT_ALLOW_BUSY=1.`,
  );

const work = join(os.tmpdir(), `lint-bench-${process.pid}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const cleanup = () => rmSync(work, { recursive: true, force: true });
process.on("exit", cleanup);
// On a signal, exit with the conventional 128+signo — process.exit fires the "exit" handler
// (cleanup) and then actually terminates, rather than swallowing the signal and continuing.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

console.log(
  `## lint-bench — ${FILES} files, ${SAMPLES} samples, ${cores} cores (load ${load1.toFixed(2)})`,
);
console.log(`   scaffold: ${work}`);

const srcDir = join(work, "src");
const fixDir = join(work, "fixture");
genCorpus(srcDir);
const parityRules = genFixture(fixDir);
writeConfigs(work);

// package.json + install
writeFileSync(
  join(work, "package.json"),
  JSON.stringify(
    { name: "lint-bench-scaffold", private: true, type: "module", devDependencies: DEPS },
    null,
    2,
  ),
);
const BUN = "bun";
console.log(`   installing toolchains (bun)…`);
const inst = run(`${BUN} install`, work);
if (inst.code !== 0) fail(`bun install failed:\n${(inst.stderr || inst.stdout).slice(-800)}`);

const bin = (b) => join(work, "node_modules", ".bin", b);
const ESLINT = bin("eslint");
const OXLINT = bin("oxlint");
if (!existsSync(ESLINT)) fail(`eslint not installed at ${ESLINT}`);
if (!existsSync(OXLINT)) fail(`oxlint not installed at ${OXLINT}`);

// resolved versions
const resolved = (() => {
  const r = {};
  for (const dep of Object.keys(DEPS)) {
    try {
      const pj = JSON.parse(readFileSync(join(work, "node_modules", dep, "package.json"), "utf8"));
      r[dep] = pj.version;
    } catch {
      r[dep] = null;
    }
  }
  return r;
})();
// Every recorded version must be real — a null means a dep didn't install, so the run is invalid.
// All DEPS are used (the configs import every plugin), so require all of them.
const missingVers = Object.keys(DEPS).filter((d) => !resolved[d]);
if (missingVers.length)
  fail(`required tool version(s) unreadable (not installed?): ${missingVers.join(", ")}`);
console.log(
  `   oxlint ${resolved.oxlint}, eslint ${resolved.eslint}, typescript-eslint ${resolved["typescript-eslint"]}, tsgolint ${resolved["oxlint-tsgolint"]}`,
);

const out = {
  generatedAt: new Date().toISOString(),
  env: {
    node: process.version,
    platform: process.platform,
    cores,
    os: `${os.type()} ${os.release()}`,
  },
  cores,
  preRunLoadAvg1: +load1.toFixed(2),
  corpus: { files: FILES, tsxFraction: TSX_FRACTION },
  versions: resolved,
};

// 1. PARITY proof (must pass before any speed number is trusted) -----------------------------
console.log(`\n## parity proof (curated set: ${parityRules.join(", ")})`);
const pEslint = run(
  `"${ESLINT}" --no-config-lookup -c "${join(work, "eslint.parity.mjs")}" -f json "${fixDir}"`,
  work,
);
const pOxlint = run(
  `"${OXLINT}" -c "${join(work, ".oxlintrc.parity.json")}" -f json "${fixDir}"`,
  work,
);
const peFind = parseEslint(pEslint.stdout);
const poFind = parseOxlint(pOxlint.stdout);
// Both tools must flag EXACTLY the curated set on the fixture — every expected rule present (via
// assertRan: parsed, no fatal, all expected names), and no extra rule beyond it. The earlier
// weaker check (the two sets merely agreeing) passed even when both missed a curated rule. The
// fixture is one file, so each tool must report linting exactly 1 and exit with a lint code.
assertRan("parity ESLint", peFind, parityRules);
assertRan("parity oxlint", poFind, parityRules);
assertLintRun("parity ESLint", pEslint, peFind, 1);
assertLintRun("parity oxlint", pOxlint, poFind, 1);
const eNames = normSet(peFind.ruleIds);
const oNames = normSet(poFind.ruleIds);
const expected = new Set(parityRules);
const extra = (names) => [...names].filter((n) => !expected.has(n));
const eExtra = extra(eNames);
const oExtra = extra(oNames);
if (eExtra.length || oExtra.length)
  fail(
    `parity: a tool flagged rules beyond the curated set (config too broad) — ` +
      `eslint extra {${eExtra.join(", ")}}, oxlint extra {${oExtra.join(", ")}}.`,
  );
out.findingsParity = {
  curatedRules: parityRules,
  eslintFindings: peFind.total,
  oxlintFindings: poFind.total,
  eslintRuleNames: [...eNames].sort(),
  oxlintRuleNames: [...oNames].sort(),
  exactMatch: true, // assertRan + no-extra above proved both === curatedRules
};
console.log(
  `   ESLint ${peFind.total} / oxlint ${poFind.total} findings — both flag exactly {${[...eNames].sort().join(", ")}} ✓`,
);

// 2. Syntactic head-to-head: oxlint FULL native set vs ESLint matched to the rules it can run.
// Not "identical coverage" — oxlint runs its entire native set; ESLint runs the subset of those it
// can (rules with a registered plugin, non-type-checked). ESLint's set is SMALLER, so the speed
// ratio is conservative (oxlint checks MORE and is still faster). Both rule counts are recorded.
console.log(`\n## syntactic: oxlint full native set vs ESLint matched-equivalent subset`);
const matchedCfg = join(work, "eslint.matched.mjs");
const oxFull = join(work, ".oxlintrc.full.json");
const cacheFile = join(work, ".eslintcache");

// Rule counts: the universe oxlint covers (eslint-plugin-oxlint's map) and what ESLint actually runs
// here. A null/non-positive count is a broken run, not a recordable number — fail.
const ruleCount = (label, specifier, extract) => {
  const r = run(`node --input-type=module -e "import c from '${specifier}'; ${extract}"`, work);
  const num = parseInt((r.stdout || "").trim(), 10);
  if (!Number.isFinite(num) || num <= 0)
    fail(
      `${label}: could not count rules (got "${(r.stdout || r.stderr || "").trim().slice(-120)}").`,
    );
  return num;
};
const oxlintCoveredRuleCount = ruleCount(
  "oxlint-covered count",
  "eslint-plugin-oxlint",
  "const a={};for(const x of c.configs['flat/all'])Object.assign(a,x.rules||{});console.log(Object.keys(a).length)",
);
const eslintMatchedRuleCount = ruleCount(
  "ESLint matched count",
  "./eslint.matched.mjs",
  "console.log(Object.keys(c[0].rules).length)",
);

const SEED_SYNTACTIC = ["no-var", "eqeqeq"]; // seeded in every corpus file; both must flag them
const eslintRun = (extra = "") =>
  `"${ESLINT}" --no-config-lookup -c "${matchedCfg}" -f json ${extra} "${srcDir}"`;
rmSync(cacheFile, { force: true });
const mEslintNoCache = timedMedian(eslintRun(), work, parseEslint);
const mEslintCache = timedMedian(
  eslintRun(`--cache --cache-location "${cacheFile}"`),
  work,
  parseEslint,
);
// oxlint has no persistent cache, so a single steady-state run is its number (a second "warm" run
// would only re-measure the page cache and could be mistaken for an oxlint cache feature).
const mOxlint = timedMedian(`"${OXLINT}" -c "${oxFull}" -f json "${srcDir}"`, work, parseOxlint);
const meFind = mEslintNoCache.find;
const meCacheFind = mEslintCache.find;
const moFind = mOxlint.find;
// The corpus seeds no-var/eqeqeq in every file, so a WORKING config must flag them with no fatal
// diagnostics; a 0/unparseable/fatal result is a broken config, not a clean codebase — fail.
assertRan("syntactic ESLint", meFind, SEED_SYNTACTIC);
assertRan("syntactic oxlint", moFind, SEED_SYNTACTIC);
// The --cache run is timed and reported too, so it must be validated the same way — else a fatal or
// zero-finding cache run could still record cacheMs and a ratio.
assertRan("syntactic ESLint --cache", meCacheFind, SEED_SYNTACTIC);
// Every timed lint must have exited with a lint code (0/1) AND linted the whole corpus — a tool that
// silently linted a subset would record a fast, unfair time. (oxlint and ESLint both report the file
// count; FILES is the corpus size.)
assertLintRun("syntactic ESLint", mEslintNoCache, meFind, FILES);
assertLintRun("syntactic ESLint --cache", mEslintCache, meCacheFind, FILES);
assertLintRun("syntactic oxlint", mOxlint, moFind, FILES);
// oxlint's own active-rule count is recorded as the headline "oxlint runs more rules" figure and
// drives the chart — a missing/non-positive value is a broken run, not a recordable number.
if (!Number.isFinite(moFind.numberOfRules) || moFind.numberOfRules <= 0)
  fail(
    `syntactic oxlint: number_of_rules missing/non-positive (${moFind.numberOfRules}) — cannot record an active-rule count.`,
  );
out.syntactic = {
  note:
    "oxlint runs its FULL native set; ESLint runs the subset of oxlint-covered rules it can (registered " +
    "plugin, non-type-checked). ESLint's set is smaller, so the ratio is conservative — oxlint checks more " +
    "and is still faster. Times exclude a discarded warmup (steady-state, not disk-cold).",
  oxlintCoveredRuleCount,
  eslintMatchedRuleCount,
  oxlintActiveRuleCount: moFind.numberOfRules, // oxlint's own report of rules it ran
  oxlintFilesLinted: moFind.numberOfFiles,
  eslint: {
    noCacheMs: mEslintNoCache.ms,
    cacheMs: mEslintCache.ms, // ESLint --cache hit (oxlint has no equivalent)
    findings: meFind.total,
    samples: mEslintNoCache.samples,
  },
  oxlint: { runMs: mOxlint.ms, findings: moFind.total, samples: mOxlint.samples },
  eslintNoCacheVsOxlint: +(mEslintNoCache.ms / Math.max(1, mOxlint.ms)).toFixed(1),
  eslintCacheVsOxlint: +(mEslintCache.ms / Math.max(1, mOxlint.ms)).toFixed(1),
};
console.log(
  `   ESLint ${eslintMatchedRuleCount} rules: ${mEslintNoCache.ms}ms (no --cache) / ${mEslintCache.ms}ms (--cache), ${meFind.total} findings`,
);
console.log(
  `   oxlint ${moFind.numberOfRules} rules: ${mOxlint.ms}ms (no cache), ${moFind.total} findings`,
);
console.log(
  `   oxlint vs ESLint: ${out.syntactic.eslintNoCacheVsOxlint}× (no-cache) — ${out.syntactic.eslintCacheVsOxlint}× (ESLint --cache)`,
);

// 3. TYPE-AWARE: the capability that used to be oxlint's gap. ESLint's type-aware offering
// (typescript-eslint type-checked rules, which build the TS program) vs oxlint --type-aware
// (tsgolint, tsgo/TS7). The corpus seeds a floating promise, so both MUST flag no-floating-promises
// — proving the type-aware engine actually engaged, not a fast no-op.
console.log(`\n## type-aware (ESLint type-checked vs oxlint --type-aware/tsgolint)`);
const typedCfg = join(work, "eslint.typed.mjs");
const tEslint = timedMedian(
  `"${ESLINT}" --no-config-lookup -c "${typedCfg}" -f json "${srcDir}"`,
  work,
  parseEslint,
);
const tOxlint = timedMedian(
  `"${OXLINT}" --type-aware -c "${oxFull}" -f json "${srcDir}"`,
  work,
  parseOxlint,
);
const teFind = tEslint.find;
const toFind = tOxlint.find;
assertRan("type-aware ESLint", teFind, ["no-floating-promises"]);
assertRan("type-aware oxlint", toFind, ["no-floating-promises"]);
assertLintRun("type-aware ESLint", tEslint, teFind, FILES);
assertLintRun("type-aware oxlint", tOxlint, toFind, FILES);
out.typeAware = {
  note:
    "ESLint = typescript-eslint type-checked rules (builds the TS program). oxlint = --type-aware " +
    "(oxlint-tsgolint, alpha; 59/61 ts-eslint type-aware rules; needs TS7+) on its full config, so " +
    "oxlint also runs its whole native set in that time — conservative. Both flag no-floating-promises.",
  eslint: { ms: tEslint.ms, findings: teFind.total, exit: tEslint.code, samples: tEslint.samples },
  oxlint: { ms: tOxlint.ms, findings: toFind.total, exit: tOxlint.code, samples: tOxlint.samples },
  speedup: +(tEslint.ms / Math.max(1, tOxlint.ms)).toFixed(1),
};
console.log(
  `   ESLint(type-checked) ${tEslint.ms}ms (${teFind.total} findings) — oxlint --type-aware ${tOxlint.ms}ms (${toFind.total} findings) → ${out.typeAware.speedup}×`,
);

// 4. LAYERED residual ------------------------------------------------------------------------
console.log(`\n## layered (ESLint after eslint-plugin-oxlint removes oxlint-covered rules)`);
const layeredCfg = join(work, "eslint.layered.mjs");
const lEslint = timedMedian(
  `"${ESLINT}" --no-config-lookup -c "${layeredCfg}" -f json "${srcDir}"`,
  work,
  parseEslint,
);
const leFind = lEslint.find;
// Residual findings can legitimately be 0 on a synthetic corpus (its seeded violations are all
// oxlint-covered), so only require the run to PARSE — a null means the config/parse broke.
if (!leFind)
  fail(
    `layered: ESLint produced unparseable output:\n${(lEslint.stdout || lEslint.stderr || "").slice(-300)}`,
  );
if (leFind.fatal > 0)
  fail(`layered: ${leFind.fatal} fatal/parse diagnostic(s) — a broken config, not a lint.`);
// A 0-residual must still come from a real lint of the whole corpus, not a config that no-op'd: the
// run must exit with a lint code and report linting all FILES (so "0 residual" means oxlint covered
// every seeded rule, not that ESLint scanned nothing).
assertLintRun("layered ESLint", lEslint, leFind, FILES);
out.layered = {
  note: "ESLint recommended + typescript-eslint, with eslint-plugin-oxlint turning off oxlint-covered rules — the residual a team still needs ESLint for.",
  eslintResidualMs: lEslint.ms,
  residualFindings: leFind.total,
  samples: lEslint.samples,
};
console.log(`   ESLint residual ${lEslint.ms}ms (${leFind.total} findings)`);

mkdirSync(join(REPO, "bench"), { recursive: true });
writeFileSync(join(REPO, "bench", "lint-bench.json"), JSON.stringify(out, null, 2));
console.log(`\nwrote bench/lint-bench.json`);

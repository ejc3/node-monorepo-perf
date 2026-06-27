#!/usr/bin/env node
// Vet the two properties the optimal-stack gate (OPTIMAL-STACK.md) depends on, on REAL
// type complexity — not the 16-line re-exports the optimal-gate-bench tree uses:
//
//   1. Cost — the one tsgo program over the whole workspace must stay fast and bounded
//      when the libs carry real types (recursive conditional + mapped types, large
//      unions, recursive path-flattening, cross-lib intersections), not just re-exports.
//   2. Parity — tsgo must agree with tsc: on valid code both report zero, and on injected
//      errors tsgo must flag every location tsc flags (a type gate that misses real errors
//      is worthless). tsc is the oracle; tsgo is the gate.
//
//   node scripts/typecheck-parity-bench.mjs <apps>:<libs>:<modules>   (default 300:80:8)
//
// Self-contained and non-destructive: it scaffolds a throwaway workspace under the OS temp
// dir (never the repo tree, so no worktree is needed), bun-installs typescript + tsgo, runs
// both checkers over one tsconfig that resolves `@demo/*` to lib source, and removes the
// workspace on exit. Writes bench/typecheck-parity-bench.json.
//
// Honesty guards (per the repo's measurement rules): each checker is timed as the median of
// PARITY_SAMPLES runs after a warmup (binary load / first-touch fs excluded), and the bench
// refuses to run on a loaded box (the speed ratio is core-bound). The run HARD-FAILS if the
// generated heavy types are not valid (clean baseline must be 0/0), if a checker crashes, if
// the injected tsc/tsgo counts drift from the 25 expected, or if tsgo's error LOCATIONS
// diverge from tsc's in either direction (a missed error can never read as a clean pass; an
// added one is a divergence worth a human's eyes). Same-location different-CODE is reported,
// not failed — both checkers still reject the expression.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir, loadavg, availableParallelism } from "node:os";

const spec = (process.argv[2] || "300:80:8").trim();
const m = spec.match(/^(\d+):(\d+):(\d+)$/);
if (!m) {
  console.error(`usage: typecheck-parity-bench.mjs <apps>:<libs>:<modules>  (got "${spec}")`);
  process.exit(1);
}
const [APPS, LIBS, MODS] = [+m[1], +m[2], +m[3]];
if (APPS < 1 || LIBS < 1 || MODS < 1) {
  // 0 in any field generates a degenerate workspace (no error sites to inject, or mod-NaN
  // imports) that would otherwise pass vacuously or fail with a misleading "invalid types".
  console.error(`apps, libs, and modules must each be >= 1 (got ${APPS}:${LIBS}:${MODS})`);
  process.exit(1);
}
const REPO = process.cwd();
// Scaffold into a UNIQUE dir under the OS temp dir: mkdtemp keeps two concurrent same-size
// runs from sharing a path and rm-ing each other's workspace, and the random suffix means
// the dir is always one we own and created fresh (so the on-exit rm only removes our own).
const ROOT = mkdtempSync(join(tmpdir(), `tc-parity-${APPS}x${LIBS}x${MODS}-`));
const BUN = existsSync(join(homedir(), ".bun/bin/bun")) ? join(homedir(), ".bun/bin/bun") : "bun";
// Track the repo's real toolchain: read the tsc/tsgo versions from the root package.json
// rather than hardcoding literals, so the vet measures the same checker the optimal gate
// installs (a hardcoded version silently drifts when the repo bumps tsgo).
const rootDeps = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).devDependencies || {};
const TS_VER = rootDeps.typescript || "^5.9.0";
const TSGO_VER = rootDeps["@typescript/native-preview"] || "7.0.0-dev.20260614.1";
const sh = (c, o = {}) =>
  execSync(c, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...o });

const lw = String(LIBS).length;
const aw = String(APPS).length;
const lp = (i) => `lib-${String(i).padStart(lw, "0")}`;
const ap = (i) => `app-${String(i).padStart(aw, "0")}`;

// remove the throwaway workspace on normal exit, on a throw, and on SIGINT/SIGTERM (the
// handlers convert the signal into a process.exit so the 'exit' handler fires). A SIGKILL
// cannot be cleaned up; the random ROOT name keeps the leak isolated to that one dir.
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  rmSync(ROOT, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// A type-heavy but VALID module: a 48-member string-literal union, a deep nested record, a
// recursive readonly-deepen (DeepRO) and a recursive path-flatten (Flatten) to force real
// type computation, a generic transform validated against a concrete literal, and — for
// every module above the foundation — a cross-lib intersection to force instantiation
// across the dependency graph.
function heavyMod(li, mi, lowerLib) {
  const cross = lowerLib != null;
  const imp = cross ? `import type { Rec as Lower } from "@demo/${lp(lowerLib)}/src/mod-0";\n` : "";
  const ext = cross ? " & { lower: Lower }" : "";
  const union = Array.from({ length: 48 }, (_, k) => `"u${li}_${mi}_${k}"`).join(" | ");
  return `${imp}export type Rec = {
  id: \`row_\${number}\`;
  kind: ${union};
  a: { b: { c: { d: number; e: string; g: readonly boolean[] }; h: number }; i: string };
  list: { v: number; meta: { x: string; y: boolean; z: ${li % 2 ? "number" : "string"} } }[];
}${ext}
export type DeepRO<T> = T extends (infer U)[] ? DeepRO<U>[] : T extends object ? { readonly [K in keyof T]: DeepRO<T[K]> } : T;
export type Flatten<T, P extends string = ""> = T extends object
  ? { [K in keyof T & string]: T[K] extends object ? Flatten<T[K], \`\${P}\${K}.\`> : \`\${P}\${K}\` }[keyof T & string]
  : never;
export type Paths = Flatten<Rec>;
export function transform<T extends Rec>(x: T): DeepRO<T> & { tag: "${lp(li)}/mod-${mi}" } {
  return { ...(x as any), tag: "${lp(li)}/mod-${mi}" };
}
const base: Rec = {
  id: "row_${mi}",
  kind: "u${li}_${mi}_0",
  a: { b: { c: { d: ${mi}, e: "e", g: [true, false] }, h: 1 }, i: "i" },
  list: [{ v: 1, meta: { x: "x", y: true, z: ${li % 2 ? 0 : '"z"'} } }],
}${cross ? " as unknown as Rec" : ""};
export const built = transform(base);
export const aPath: Paths = "a.b.c.d" as Paths;
`;
}

// libs in layers so lib i imports a strictly-lower lib (acyclic dependency graph)
for (let i = 1; i <= LIBS; i++) {
  const dir = join(ROOT, "packages", lp(i), "src");
  mkdirSync(dir, { recursive: true });
  const lower = i > 1 ? ((i * 7) % (i - 1)) + 1 : null;
  for (let m2 = 0; m2 < MODS; m2++)
    writeFileSync(join(dir, `mod-${m2}.ts`), heavyMod(i, m2, m2 === 0 ? null : lower));
  writeFileSync(
    join(dir, "index.ts"),
    Array.from({ length: MODS }, (_, m2) => `export * as M${m2} from "./mod-${m2}";`).join("\n") +
      "\n",
  );
  writeFileSync(
    join(ROOT, "packages", lp(i), "package.json"),
    JSON.stringify({ name: `@demo/${lp(i)}`, version: "1.0.0" }),
  );
}

// apps: each imports transform + built from 4 libs and uses them (forces instantiation)
for (let i = 1; i <= APPS; i++) {
  const dir = join(ROOT, "apps", ap(i), "src");
  mkdirSync(dir, { recursive: true });
  const libs = Array.from({ length: 4 }, (_, k) => 1 + ((i * 31 + k * 97) % LIBS));
  const body = libs
    .map(
      (l, k) =>
        `import { transform as t${k}, built as b${k} } from "@demo/${lp(l)}/src/mod-${k % MODS}";`,
    )
    .join("\n");
  const use = libs.map((_, k) => `t${k}(b${k} as any).tag`).join(", ");
  writeFileSync(join(dir, "index.ts"), `${body}\nexport const tags = [${use}];\n`);
  writeFileSync(
    join(ROOT, "apps", ap(i), "package.json"),
    JSON.stringify({ name: `@demo/${ap(i)}`, version: "1.0.0" }),
  );
}

writeFileSync(
  join(ROOT, "package.json"),
  JSON.stringify(
    {
      name: "tc-parity",
      private: true,
      workspaces: ["apps/*", "packages/*"],
      devDependencies: {
        typescript: TS_VER,
        "@typescript/native-preview": TSGO_VER,
      },
    },
    null,
    2,
  ),
);
// One tsconfig, both checkers: `@demo/*` resolves to lib source (the one-program-from-source
// shape the optimal gate uses), so each lib is parsed once and shared across importers.
writeFileSync(
  join(ROOT, "tsconfig.whole.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "esnext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        declaration: false,
        skipLibCheck: true,
        lib: ["ES2022"],
        paths: { "@demo/*": ["./packages/*", "./apps/*"] },
      },
      include: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
    },
    null,
    2,
  ),
);

console.log(`# typecheck parity vet: ${APPS} apps / ${LIBS} libs / ${MODS} modules each`);
sh(`${BUN} install`, { encoding: "utf8" });
const tsgo = join(ROOT, "node_modules", ".bin", "tsgo");
const tsc = join(ROOT, "node_modules", ".bin", "tsc");
const verOf = (bin) => execSync(`${bin} --version`).toString().trim();

// Run a checker over tsconfig.whole.json; capture wall ms, peak RSS, and the sorted set of
// `file(line,col): error TSxxxx` diagnostics. Timed after one warmup run (discarded).
function run(bin, label) {
  let out = "";
  let ok = true;
  const t0 = process.hrtime.bigint();
  try {
    out = sh(`/usr/bin/time -v ${bin} --noEmit -p tsconfig.whole.json 2>&1`, { encoding: "utf8" });
  } catch (e) {
    ok = false;
    out = (e.stdout || "") + (e.stderr || "");
  }
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const rss = +(out.match(/Maximum resident set size \(kbytes\): (\d+)/) || [])[1] || null;
  // A checker that died abnormally is a failed run, not a result — even when it already
  // emitted some diagnostics, which the count alone would miss on the injected (non-zero by
  // design) runs. Catch a signal kill (GNU time's "Command terminated by signal", e.g.
  // segfault/OOM) and an internal-compiler abort (tsgo Go "panic:", tsc "Debug Failure").
  const crashed = /Command terminated by signal|panic:|Debug Failure/.test(out);
  const diags = (out.match(/[^\s]+\.[cm]?tsx?\(\d+,\d+\): error TS\d+/g) || []).sort();
  console.log(
    `  ${label}: ${ms}ms, ${rss ? Math.round(rss / 1024) : "?"}MB, ${diags.length} diagnostics, ok=${ok}`,
  );
  return { ms, rssMB: rss ? Math.round(rss / 1024) : null, diags, ok, crashed, out };
}

// One warmup (discarded), then PARITY_SAMPLES timed runs; report the MEDIAN ms (per the
// repo's "true median, not min" rule) so a single transient spike does not become the number.
// Carries the sample spread, and propagates a failure/signal in ANY sample. The speed ratio is
// load-sensitive (tsgo is parallel, so core contention hits it hardest) — the load guard below
// refuses to publish a number from a busy box; median only smooths transient blips, not a
// sustained co-tenant.
const sampleEnv = Math.floor(Number(process.env.PARITY_SAMPLES));
const SAMPLES = Number.isFinite(sampleEnv) && sampleEnv >= 1 ? sampleEnv : 3;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const timed = (bin, label) => {
  run(bin, `${label} (warmup)`);
  const runs = Array.from({ length: SAMPLES }, (_, i) => run(bin, `${label} #${i + 1}`));
  // tsc/tsgo are deterministic, so every timed sample must produce the IDENTICAL diagnostic
  // set — if they diverge the checker is flaky and the rep-sample's diags can't stand in for
  // the parity check below. Assert it so a non-deterministic run fails rather than passing on
  // whichever sample happened to land closest to the median.
  if (new Set(runs.map((r) => r.diags.join("\n"))).size > 1) {
    throw new Error(
      `${label}: diagnostics differ across timed samples (non-deterministic checker)`,
    );
  }
  const ms = median(runs.map((r) => r.ms));
  const rep = runs.reduce((a, b) => (Math.abs(b.ms - ms) < Math.abs(a.ms - ms) ? b : a));
  return {
    ...rep,
    ms,
    samples: runs.map((r) => r.ms),
    ok: runs.every((r) => r.ok),
    crashed: runs.some((r) => r.crashed),
  };
};

// Refuse to publish a speed number from a busy box. The ratio is core-bound — tsgo is
// parallel, so a co-tenant hogging cores silently collapses the measured speedup (a clean
// box reads ~9×; a contended one read ~3.7× during development). The load average is read
// before the measured runs; it mostly reflects OTHER tenants (the just-finished install
// decays into the 1-min average, which only makes the guard more conservative, never less).
// Override with PARITY_ALLOW_BUSY=1 for a deliberate contended run.
const CORES = availableParallelism(); // respects cgroup CPU limits, unlike cpus().length
const load1 = loadavg()[0];
if (load1 > CORES * 0.5 && !process.env.PARITY_ALLOW_BUSY) {
  console.error(
    `1-min load average ${load1.toFixed(1)} on ${CORES} cores — the box is busy and the speed ratio would be contended.\n` +
      `Wait for it to quiesce, or set PARITY_ALLOW_BUSY=1 to measure anyway.`,
  );
  process.exit(1);
}

console.log("\n## clean baseline (valid heavy types) — both must report 0");
const tscClean = timed(tsc, "tsc ");
const tsgoClean = timed(tsgo, "tsgo");
// A valid clean run exits 0 (no type errors) and reports peak RSS. ok=false or rss=null means
// the checker did not actually run (bad config, OOM, crash, or /usr/bin/time not GNU time) —
// which would otherwise leave an empty diagnostics list that reads as a false "0 diagnostics".
// Catch that here so a failure can never be recorded as a clean baseline.
for (const [label, r] of [
  ["tsc", tscClean],
  ["tsgo", tsgoClean],
]) {
  if (!r.ok || r.crashed) {
    throw new Error(
      `${label} did not run cleanly on valid code (non-zero exit / crash with no parseable type errors — failed to run?):\n${(r.out || "").slice(-800)}`,
    );
  }
  if (r.rssMB == null) {
    throw new Error(`${label} peak RSS not captured — is /usr/bin/time GNU time with -v?`);
  }
}
if (tscClean.diags.length !== 0 || tsgoClean.diags.length !== 0) {
  throw new Error(
    `clean baseline not 0/0 (generated heavy types must be valid): tsc=${tscClean.diags.length} tsgo=${tsgoClean.diags.length}\n` +
      [...tscClean.diags, ...tsgoClean.diags].slice(0, 6).join("\n"),
  );
}

// inject errors into 5 app files: five sites spanning assignment / arg-type / arity /
// return-type. Both checkers must flag the same LOCATIONS.
console.log("\n## injected errors (5 apps) — both must flag the same locations");
const broken = Array.from({ length: Math.min(5, APPS) }, (_, k) => ap(1 + k));
for (const a of broken) {
  writeFileSync(
    join(ROOT, "apps", a, "src", "index.ts"),
    `import { transform } from "@demo/${lp(1)}/src/mod-0";
export const e1: string = 42;
export const e2: number = "x";
export const e3 = transform({ id: 123 } as any as { nope: true });
export const e4 = transform();
export function e5(n: number): string { return n; }
`,
  );
}
const tscBad = timed(tsc, "tsc ");
const tsgoBad = timed(tsgo, "tsgo");

// The oracle (tsc) must flag exactly the injected errors — 5 sites per broken app. If it
// reports a different count the injection or tsc itself changed (and a 0 here would be tsc
// failing to run, which must not pass as "both agree on nothing"); fail loudly so a human
// re-checks rather than publishing a silently-shifted count. The location-parity check below
// then holds tsgo to those same locations.
const expectedInjected = broken.length * 5;
if (tscBad.crashed || tsgoBad.crashed) {
  // a checker that crashed mid-run can emit a partial diagnostic set that would slip through
  // the location checks below; reject it outright.
  throw new Error(
    `a checker crashed on the injected run (signal/panic, not a clean type-error exit):\n${((tscBad.crashed ? tscBad.out : tsgoBad.out) || "").slice(-800)}`,
  );
}
// Both checkers must flag EXACTLY the injected count — 5 sites per broken app, one diagnostic
// each. A different tsc count means the injection or tsc changed; a different tsgo count means
// tsgo emitted a partial set (a crash-after-output) or an EXTRA diagnostic at an
// already-flagged location (which the location-set check below would otherwise miss). Both
// fail loudly rather than publishing a silently-shifted count.
if (tscBad.diags.length !== expectedInjected) {
  throw new Error(
    `oracle (tsc) flagged ${tscBad.diags.length} diagnostics, expected ${expectedInjected} (${broken.length} apps × 5 sites) — injection or tsc changed:\n${(tscBad.out || "").slice(-800)}`,
  );
}
if (tsgoBad.diags.length !== expectedInjected) {
  throw new Error(
    `tsgo flagged ${tsgoBad.diags.length} diagnostics, expected ${expectedInjected} (partial output, or an extra diagnostic at a shared location):\n${(tsgoBad.out || "").slice(-800)}`,
  );
}

// parity by LOCATION (file:line:col) and by LOCATION+CODE separately
const loc = (s) => s.replace(/^.*\/(apps|packages)\//, "$1/").replace(/: error TS\d+/, "");
const full = (s) => s.replace(/^.*\/(apps|packages)\//, "$1/");
const tscLoc = new Set(tscBad.diags.map(loc));
const tsgoLoc = new Set(tsgoBad.diags.map(loc));
const tscFull = new Set(tscBad.diags.map(full));
const tsgoFull = new Set(tsgoBad.diags.map(full));
const missed = [...tscLoc].filter((x) => !tsgoLoc.has(x)); // tsc flagged a spot tsgo did not
const falsePos = [...tsgoLoc].filter((x) => !tscLoc.has(x)); // tsgo flagged a spot tsc did not
const codeDiff = [...tscFull].filter((x) => !tsgoFull.has(x) && tsgoLoc.has(loc(x))); // same spot, diff code
// for a sample differing location, record both checkers' codes (both reject it, different code)
const codeOf = (s) => (s.match(/TS\d+/) || [])[0];
const codePair = (x) => {
  const tg = [...tsgoFull].find((y) => loc(y) === loc(x));
  return `${codeOf(x)}->${tg ? codeOf(tg) : "?"}`;
};
const codeDiffSample =
  codeDiff.length === 0
    ? null
    : (() => {
        const tg = [...tsgoFull].find((y) => loc(y) === loc(codeDiff[0]));
        return { tsc: codeOf(codeDiff[0]), tsgo: tg ? codeOf(tg) : null };
      })();
// distinct tsc->tsgo code pairs across all differing locations — a single pair confirms the
// differences are all the same site repeated across the broken apps (not scattered codes)
const codeDiffPairs = [...new Set(codeDiff.map(codePair))];

console.log("\n## PARITY");
console.log(`  clean baseline: tsc=0 tsgo=0`);
console.log(`  injected: tsc=${tscBad.diags.length} tsgo=${tsgoBad.diags.length} diagnostics`);
console.log(
  `  LOCATION: missed by tsgo=${missed.length}  tsgo-only (false-pos)=${falsePos.length}`,
);
console.log(`  CODE differs at shared location: ${codeDiff.length}`);
if (missed.length) console.log("   tsgo MISSED:", missed.slice(0, 4));
if (falsePos.length) console.log("   tsgo FALSE-POS:", falsePos.slice(0, 4));

// A miss is the unacceptable outcome for a gate (a real error read as clean); a tsgo-only
// location is a divergence the doc claims is zero. Hard-fail BOTH directions so the recorded
// "0 missed / 0 false-positive" location parity is enforced, not merely reported — a future
// tsgo that drifts either way fails the run for a human to assess rather than shipping silently.
if (missed.length) {
  throw new Error(
    `tsgo missed ${missed.length} error location(s) tsc flagged: ${missed.slice(0, 4)}`,
  );
}
if (falsePos.length) {
  throw new Error(
    `tsgo flagged ${falsePos.length} location(s) tsc did not (location parity broken): ${falsePos.slice(0, 4)}`,
  );
}

const ratio = +(tscClean.ms / tsgoClean.ms).toFixed(1);
console.log(
  `\n## SPEED (clean, real types): tsc ${tscClean.ms}ms ${tscClean.rssMB}MB  vs  tsgo ${tsgoClean.ms}ms ${tsgoClean.rssMB}MB  = ${ratio}x`,
);

const result = {
  apps: APPS,
  libs: LIBS,
  modulesPerLib: MODS,
  versions: { bun: verOf(BUN), tsc: verOf(tsc), tsgo: verOf(tsgo), node: process.version },
  cores: CORES,
  preRunLoadAvg1: +load1.toFixed(2),
  samples: SAMPLES,
  typeShape:
    "recursive conditional + mapped types, 48-member unions, path-flatten, cross-lib intersections",
  cleanBaseline: {
    tsgo: { ms: tsgoClean.ms, rssMB: tsgoClean.rssMB, diagnostics: 0, sampleMs: tsgoClean.samples },
    tsc: { ms: tscClean.ms, rssMB: tscClean.rssMB, diagnostics: 0, sampleMs: tscClean.samples },
    speedupTsgoOverTsc: ratio,
  },
  injected: {
    apps: broken.length,
    tscDiagnostics: tscBad.diags.length,
    tsgoDiagnostics: tsgoBad.diags.length,
    locationMissedByTsgo: missed.length,
    tsgoOnlyLocations: falsePos.length,
    codeDiffersAtSharedLocation: codeDiff.length,
    codeDiffSample,
    codeDiffPairs,
  },
};
mkdirSync(join(REPO, "bench"), { recursive: true });
writeFileSync(join(REPO, "bench/typecheck-parity-bench.json"), JSON.stringify(result, null, 2));
console.log("\n--- bench/typecheck-parity-bench.json written ---");

#!/usr/bin/env node
// Demonstrate, on a self-contained repro, the declaration-emit coverage gap — one place the fast
// whole-program type-error gate is NOT equivalent to the build: it validates the code but not the
// published `.d.ts`. The optimal gate runs with `declaration:false` (the OPTIMAL-STACK config sets it
// so, to avoid TS2883 noise on JSX component return types), so it skips declaration-portability
// checking entirely. A declaration error therefore passes the gate, yet is caught BOTH by a
// `declaration:true` check (no emit needed) AND by the dist-emitting build.
//
// The error used is the canonical "inferred type cannot be named ... not portable", which arises
// when an exported value's inferred type comes from a transitive dependency nested under another
// package's node_modules (the pnpm geometry). tsc reports it as TS2742, tsgo as TS2883 — same issue,
// different code. The precise boundary is `declaration` off-vs-on, not `--noEmit` vs emit: a
// `--noEmit` check with `declaration:true` already catches it, no build required. The load-bearing
// fix is promoting the transitive type to a directly-resolvable dependency; the explicit annotation
// TS2742 suggests is insufficient on its own here (it cannot even resolve the nested type).
//
// This is the empirical backing for OPTIMAL-STACK.md's caveat that the fast gate (declaration:false,
// `@demo/*`→src) complements the build (`tsc` via turbo `^build`), it doesn't replace it. It mirrors
// the gate's app→`@demo` import shape, on a constructed nested-dep hazard the synthetic 4,000:400
// libs do NOT have (their exports carry explicit return types), so the measured gate misses nothing
// there — this is a latent hazard for real published libraries.
//
//   node scripts/decl-emit-caveat.mjs
//
// Self-contained and non-destructive: scaffolds a throwaway workspace under the OS temp dir (never
// the repo tree, so no worktree needed) and removes it on exit. Runs THIS repo's pinned tsgo + tsc
// (node_modules/.bin). HARD-FAILS if the divergence does not reproduce (gate clean / declaration
// check + build flag exactly the portability code / promoting the dep clears it / the annotation
// alone cannot resolve), so a future toolchain change that closes or breaks the gap turns the bench
// red instead of letting a stale claim stand → bench/decl-emit-caveat.json.

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Repo root derived from this file's location (scripts/<this>.mjs), so the bench reproduces from any
// checkout rather than one hardcoded path.
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const bin = (name) => join(REPO, "node_modules", ".bin", name);
const TSGO = bin("tsgo");
const TSC = bin("tsc");
for (const [label, p] of [
  ["tsgo", TSGO],
  ["tsc", TSC],
]) {
  if (!existsSync(p)) {
    console.error(
      `missing ${label} at ${p} — run \`bun install\`/\`pnpm install\` in ${REPO} first.`,
    );
    process.exit(1);
  }
}

// A kill (OOM/panic/segfault) exits 128+signo through the shell; treat any such exit as a crash so a
// killed checker never reads as a clean pass/fail. A checker exiting non-zero on type/emit errors is
// data (the whole point), not a crash.
const isSignalExit = (code) => code > 128 && code <= 192;
const CRASH =
  /Command terminated by signal|panic:|Segmentation fault|out of memory|\(core dumped\)/i;

function run(cmd, cwd) {
  let out = "";
  let code = 0;
  try {
    out = execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    code = e.status ?? -1;
    out = (e.stdout || "") + (e.stderr || "");
  }
  if (CRASH.test(out) || isSignalExit(code))
    throw new Error(`crash in \`${cmd}\` (exit ${code}):\n${out.slice(-800)}`);
  return { code, out };
}
const ver = (p) => execSync(`${p} --version`, { encoding: "utf8" }).trim();

// --- scaffold a throwaway workspace ----------------------------------------------------------------
const WORK = mkdtempSync(join(tmpdir(), "decl-emit-caveat-"));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

const w = (rel, content) => {
  const p = join(WORK, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};

// `dep` exposes a value whose type comes from `subdep`, nested under dep/node_modules — a transitive
// type the root (and a foundation .d.ts) cannot name. This is the pnpm/nested geometry that trips the
// "inferred type cannot be named" portability error on declaration emit.
w(
  "packages/foundation/node_modules/dep/package.json",
  JSON.stringify({ name: "dep", version: "1.0.0", types: "index.d.ts" }),
);
w(
  "packages/foundation/node_modules/dep/index.d.ts",
  'import { Sub } from "subdep";\nexport declare const thing: Sub;\n',
);
w(
  "packages/foundation/node_modules/dep/node_modules/subdep/package.json",
  JSON.stringify({ name: "subdep", version: "1.0.0", types: "index.d.ts" }),
);
w(
  "packages/foundation/node_modules/dep/node_modules/subdep/index.d.ts",
  "export interface Sub {\n  v: number;\n}\n",
);

// The foundation package SOURCE: re-exports a value whose inferred type is Sub (from the nested dep).
w(
  "packages/foundation/package.json",
  JSON.stringify({
    name: "@demo/foundation",
    version: "0.0.0",
    private: true,
    types: "./dist/index.d.ts",
  }),
);
w(
  "packages/foundation/src/index.ts",
  'import { thing } from "dep";\n// inferred type Sub, only nameable via dep/node_modules/subdep\nexport const x = thing;\n',
);
// The annotation TS2742 suggests, on its own (no promotion of the nested type) — used to show it is
// insufficient here: the import cannot even resolve `subdep`.
w(
  "packages/foundation/src/index.annotated.ts",
  'import { thing } from "dep";\nimport type { Sub } from "subdep";\nexport const x: Sub = thing;\n',
);

// An app consuming the foundation package (the gate checks app + foundation source together).
w(
  "apps/app/src/index.ts",
  'import { x } from "@demo/foundation";\nexport const y: number = x.v;\n',
);

const COMMON = {
  strict: true,
  module: "esnext",
  moduleResolution: "bundler",
  target: "es2017",
  skipLibCheck: true,
};
// The fast gate: one program over app + foundation SOURCE (`@demo/*`→src), typecheck-only,
// declaration:false (what optimal-gate-bench runs — declaration checking is OFF).
const gateInclude = ["apps/app/src/index.ts", "packages/foundation/src/index.ts"];
const gatePaths = { "@demo/foundation": ["./packages/foundation/src/index.ts"] };
w(
  "tsconfig.gate.json",
  JSON.stringify(
    {
      compilerOptions: { ...COMMON, noEmit: true, declaration: false, paths: gatePaths },
      include: gateInclude,
    },
    null,
    2,
  ),
);
// The same program, still `--noEmit` (no files written) but with declaration checking ON — shows the
// boundary is `declaration` off-vs-on, not noEmit-vs-emit: this catches the error without a build.
w(
  "tsconfig.declcheck.json",
  JSON.stringify(
    {
      compilerOptions: { ...COMMON, noEmit: true, declaration: true, paths: gatePaths },
      include: gateInclude,
    },
    null,
    2,
  ),
);
// The build: emit the foundation package's dist `.d.ts` with `tsc --declaration` — a
// declaration-emitting build of the kind turbo `^build` runs (a minimal tsc config, not the
// generated lib config).
w(
  "packages/foundation/tsconfig.build.json",
  JSON.stringify(
    {
      compilerOptions: { ...COMMON, declaration: true, emitDeclarationOnly: true, outDir: "dist" },
      include: ["src/index.ts"],
    },
    null,
    2,
  ),
);
// The load-bearing fix: promote the transitive type to a directly-resolvable dependency (here, a
// `paths` mapping that makes `subdep` nameable). SAME un-annotated source — once the type is
// nameable, declaration emit succeeds with no annotation.
w(
  "packages/foundation/tsconfig.fix-nameable.json",
  JSON.stringify(
    {
      compilerOptions: {
        ...COMMON,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: "distfix",
        paths: { subdep: ["./node_modules/dep/node_modules/subdep/index.d.ts"] },
      },
      include: ["src/index.ts"],
    },
    null,
    2,
  ),
);
// The annotation TS2742 suggests, WITHOUT promoting the dep: the annotated source can't even resolve
// the nested type (TS2307), so the annotation alone is insufficient in this geometry.
w(
  "packages/foundation/tsconfig.annotation-only.json",
  JSON.stringify(
    {
      compilerOptions: {
        ...COMMON,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: "distann",
      },
      include: ["src/index.annotated.ts"],
    },
    null,
    2,
  ),
);

// --- run the rungs -------------------------------------------------------------------------------
const foundation = join(WORK, "packages/foundation");
const errs = (out) => (out.match(/error TS\d+/g) || []).length;
// The portability diagnostic — tsc emits TS2742, tsgo emits TS2883 for the same "cannot be named".
const portability = (out) => (out.match(/error TS(2742|2883):.*/) || [])[0] || null;
const ts2307 = (out) => (out.match(/error TS2307:.*/) || [])[0] || null;

console.log("== gate (declaration:false, --noEmit) — what optimal-gate-bench runs ==");
const gateTsgo = run(`${TSGO} --noEmit -p tsconfig.gate.json`, WORK);
const gateTsc = run(`${TSC} --noEmit -p tsconfig.gate.json`, WORK);
console.log(
  `  tsgo exit ${gateTsgo.code} (${errs(gateTsgo.out)} err); tsc exit ${gateTsc.code} (${errs(gateTsc.out)} err)`,
);

console.log("== declaration check (declaration:true, --noEmit — NO emit) ==");
const declTsgo = run(`${TSGO} --noEmit -p tsconfig.declcheck.json`, WORK);
const declTsc = run(`${TSC} --noEmit -p tsconfig.declcheck.json`, WORK);
console.log(
  `  tsgo exit ${declTsgo.code} ${portability(declTsgo.out) ? "(TS2883)" : ""}; tsc exit ${declTsc.code} ${portability(declTsc.out) ? "(TS2742)" : ""}`,
);

console.log("== build (declaration:true, emit foundation dist .d.ts via tsc) ==");
const build = run(`${TSC} -p tsconfig.build.json`, foundation);
console.log(
  `  tsc exit ${build.code}, ${errs(build.out)} errors${portability(build.out) ? " (TS2742)" : ""}`,
);

console.log("== fix: promote the transitive type to a resolvable dep (same source) ==");
const fix = run(`${TSC} -p tsconfig.fix-nameable.json`, foundation);
console.log(`  tsc exit ${fix.code}, ${errs(fix.out)} errors`);

console.log("== annotation only (TS2742's suggested annotation, dep NOT promoted) ==");
const annOnly = run(`${TSC} -p tsconfig.annotation-only.json`, foundation);
console.log(
  `  tsc exit ${annOnly.code}, ${errs(annOnly.out)} errors${ts2307(annOnly.out) ? " (TS2307 — can't resolve)" : ""}`,
);

// --- assert the divergence reproduced (hard-fail otherwise, so a stale claim can't survive) -------
const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};
const mustBeClean = (label, r) => {
  if (r.code !== 0 || errs(r.out) !== 0)
    fail(`${label} should be clean (0 errors); got exit ${r.code}\n${r.out.slice(-600)}`);
};
// Exactly the named portability code, the ONLY error, for `x` via the nested subdep — so a future
// toolchain change (tsgo switching to TS2742, an extra error) turns the bench red rather than green.
const mustCatch = (label, r, code) => {
  if (
    r.code === 0 ||
    errs(r.out) !== 1 ||
    !new RegExp(`error ${code}: `).test(r.out) ||
    !/inferred type of 'x'/.test(r.out) ||
    !/dep\/node_modules\/subdep/.test(r.out)
  )
    fail(
      `${label} should flag exactly ${code} for 'x' via subdep; got exit ${r.code}, ${errs(r.out)} err\n${r.out.slice(-600)}`,
    );
};
mustBeClean("tsgo gate (declaration:false)", gateTsgo);
mustBeClean("tsc gate (declaration:false)", gateTsc);
mustCatch("tsgo declaration check", declTsgo, "TS2883");
mustCatch("tsc declaration check", declTsc, "TS2742");
mustCatch("tsc build", build, "TS2742");
mustBeClean("tsc build after promoting the dep", fix);
// The annotation alone cannot even resolve the nested type (TS2307) — proves nameability, not the
// annotation, is the load-bearing fix in this geometry.
if (annOnly.code === 0 || !ts2307(annOnly.out))
  fail(
    `annotation-only should fail to resolve (TS2307); got exit ${annOnly.code}\n${annOnly.out.slice(-600)}`,
  );

const result = {
  claim:
    "The optimal gate runs declaration:false, so it validates the code but not the published .d.ts. " +
    "A declaration-portability error (an exported value whose inferred type comes from a transitive " +
    "dep nested under another package's node_modules) is MISSED by the gate, yet caught both by a " +
    "declaration:true check (no emit needed) and by the dist-emitting build. tsc reports TS2742, tsgo " +
    "TS2883 — same issue, different code; the boundary is declaration off-vs-on, not noEmit-vs-emit. " +
    "The load-bearing fix is promoting the transitive type to a directly-resolvable dependency; the " +
    "explicit annotation TS2742 suggests is insufficient alone here (it cannot resolve the nested type).",
  versions: { tsgo: ver(TSGO), tsc: ver(TSC), node: process.version },
  gate: {
    config: "declaration:false, --noEmit (@demo/*->src whole program — the optimal gate)",
    tsgo: { exit: gateTsgo.code, errors: errs(gateTsgo.out) },
    tsc: { exit: gateTsc.code, errors: errs(gateTsc.out) },
  },
  declarationCheck: {
    config: "declaration:true, --noEmit (declaration checking on, still no files written)",
    tsgo: {
      exit: declTsgo.code,
      errors: errs(declTsgo.out),
      diagnostic: portability(declTsgo.out),
    },
    tsc: { exit: declTsc.code, errors: errs(declTsc.out), diagnostic: portability(declTsc.out) },
  },
  build: {
    config:
      "declaration:true, emit .d.ts via tsc (a declaration-emitting build, as turbo ^build runs)",
    tool: "tsc",
    exit: build.code,
    errors: errs(build.out),
    diagnostic: portability(build.out),
  },
  fix: {
    config:
      "promote the transitive type to a directly-resolvable dependency (same un-annotated source)",
    tool: "tsc --declaration",
    exit: fix.code,
  },
  annotationOnly: {
    config: "TS2742's suggested explicit annotation, dep NOT promoted — insufficient alone",
    tool: "tsc --declaration",
    exit: annOnly.code,
    diagnostic: ts2307(annOnly.out),
  },
  reproduced: true,
};
mkdirSync(join(REPO, "bench"), { recursive: true });
writeFileSync(join(REPO, "bench/decl-emit-caveat.json"), JSON.stringify(result, null, 2));
console.log("\n--- bench/decl-emit-caveat.json written (divergence reproduced) ---");
console.log(
  `  gate(decl:false): tsgo ${gateTsgo.code}/tsc ${gateTsc.code} clean  |  ` +
    `decl-check(decl:true,noEmit): tsgo ${declTsgo.code}/tsc ${declTsc.code} catch  |  ` +
    `build: ${build.code} catch  |  fix(promote dep): ${fix.code} clean  |  annotation-only: ${annOnly.code} (TS2307)`,
);

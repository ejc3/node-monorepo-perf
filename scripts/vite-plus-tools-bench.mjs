#!/usr/bin/env node
// The Vite+ tool layer, priced against the engines it wraps — two rungs, each on its own
// self-contained temp scaffold (non-destructive, no worktree needed):
//
//   CHECK — one-pass `vp check --no-fmt` (oxlint + tsgolint type errors in one traversal;
//     vite.config `lint.options.typeAware + typeCheck`) vs the same engines run
//     separately at the SAME pinned versions vp bundles (oxlint 1.72.0,
//     oxlint-tsgolint 0.24.0): (a) `oxlint --type-aware` — the exact-engine sequentialized
//     baseline, and (b) plain `oxlint` + one whole-program `tsgo --noEmit` — the repo's
//     optimal-gate shape, a DIFFERENT type-check model (one program vs per-file typed
//     lint), reported for context and labeled as such. Every timed run must exit 0 and
//     is file-count asserted against the walked source corpus — a run that traversed
//     node_modules or built dist (vp check's type-aware pass lints every file in the
//     type program, so a dist-bearing tree sweeps emitted .js/.d.ts too) or skipped the
//     tree cannot read as a fast number. The corpus is source-only: @demo/* resolves to
//     lib source via tsconfig paths, nothing is built.
//
//   BUILD — `vp build` vs `vite build` on one generated Vite app (the build-bench 40:24
//     scale): the same app source, the workspace-pinned vite 8.0.16 vs the vite bundled
//     inside @voidzero-dev/vite-plus-core; dist contents hashed for an identity verdict
//     (recorded, not asserted — a bundled-version delta is the finding, not a failure),
//     plus vp's second-run cooperative-caching row.
//
//   node scripts/vite-plus-tools-bench.mjs        # CHECK at 100:40, BUILD at 40:24
//   TOOLS_SAMPLES=3 node scripts/vite-plus-tools-bench.mjs
//
// vp is non-interactive only with CI set and stdin closed (its prompt otherwise hangs a
// pipe — found in recon); every tool call runs that way, ambient VITE_*/VP_*/TURBO_*/
// npm_config_*/OXLINT_* scrubbed per run. A signal-killed tool is a harness fault.
// Load-guarded (oxlint/tsgo are parallel).

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir, cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { VITE_PLUS_VERSION } from "./_pins.mjs";
import { median, loadGuard, scaffoldWorkspace, scrubEnv } from "./_pm-bench-lib.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLES = Number(process.env.TOOLS_SAMPLES || 3);
const CHECK_SCALE = { apps: 100, libs: 40 }; // ~700 source files, the lint-bench order
const BUILD_SCALE = { apps: 40, libs: 24 }; // build-bench's scale
const CORES = cpus().length;

// vp's own engine pins (vite-plus's package.json dependencies) — the separate-engines
// baseline runs the SAME versions or the comparison is versions, not integration; the
// CHECK rung asserts these against the installed vite-plus's actual pins, so a vp bump
// cannot silently leave the baseline on stale engines
const OXLINT_VERSION = "1.72.0";
const TSGOLINT_VERSION = "0.24.0";

const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};
const envInfo = loadGuard("VITE_TOOLS_ALLOW_BUSY");

const ROOT = mkdtempSync(join(tmpdir(), "vite-plus-tools-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

const repoDevDeps = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).devDependencies;

function run(cmd, args, { cwd, env = {}, timeout = 1_800_000 } = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    timeout,
    // scrubbed base (ambient VITE_*/npm_config_*/TURBO_* would reconfigure the tools),
    // CI=true pinned: vp prompts — and hangs a pipe — when it thinks it's interactive
    env: scrubEnv(["VITE_", "VP_", "TURBO_", "npm_config_", "OXLINT_"], { CI: "true", ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) fail(`${cmd} ${args.join(" ")}: ${r.error.code || r.error.message}`);
  if (r.signal || r.status === null)
    fail(`${cmd} ${args.join(" ")} killed by ${r.signal || "unknown signal"} — not a measurement`);
  return {
    code: r.status,
    ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
    out: (r.stdout || "") + (r.stderr || ""),
  };
}

// timed sample set: one warmup, then SAMPLES timed runs, each gated by `check`
function sampled(label, exec, check) {
  check(exec()); // warmup, still gated — a broken run must not become a warm cache for the next
  const ms = [];
  for (let i = 0; i < SAMPLES; i++) {
    const r = exec();
    check(r);
    ms.push(r.ms);
  }
  const m = median(ms);
  console.log(`  ${label}: ${m}ms (median of ${SAMPLES})`);
  return { medianMs: m, samplesMs: ms };
}

// every file the engines lint: .ts/.tsx (including .d.ts — next-env.d.ts is linted) and
// .mjs/.js (each app's next.config.mjs is linted); the count gates below are exact
const walkLintable = (base, dir, acc = []) => {
  for (const e of readdirSync(join(base, dir))) {
    const rel = join(dir, e);
    if (e === "node_modules" || e === "dist" || e === ".next") continue;
    if (statSync(join(base, rel)).isDirectory()) walkLintable(base, rel, acc);
    else if (/\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(e)) acc.push(rel);
  }
  return acc;
};

function scaffold(name, scale, extraArgs, devDeps) {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  scaffoldWorkspace(REPO, dir, { ...scale, name: `vite-plus-${name}`, extraArgs });
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkg.devDependencies = devDeps;
  pkg.packageManager = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).packageManager;
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(join(dir, "tsconfig.base.json"), readFileSync(join(REPO, "tsconfig.base.json")));
  writeFileSync(join(dir, "turbo.json"), readFileSync(join(REPO, "turbo.json")));
  // node_modules/dist ignored, source NOT — oxlint and vp both read ignore files, and a
  // scaffold that ignores the source lints 0 files while one with no ignore file at all
  // sends vp check into nested node_modules (both found in recon, both vacuous)
  writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n*.tsbuildinfo\n");
  const i = run("pnpm", ["install"], { cwd: dir });
  if (i.code !== 0) fail(`${name} pnpm install failed:\n${i.out.slice(-400)}`);
  return dir;
}

const out = {
  versions: {
    vitePlus: VITE_PLUS_VERSION,
    oxlint: OXLINT_VERSION,
    oxlintTsgolint: TSGOLINT_VERSION,
    tsgo: repoDevDeps["@typescript/native-preview"],
    node: process.version,
  },
  ...envInfo,
  samples: SAMPLES,
  rungs: {},
};

// ---- CHECK rung ----------------------------------------------------------------------------------
console.log(
  `== check: one-pass vp check vs the same engines separate (${CHECK_SCALE.apps}:${CHECK_SCALE.libs}) ==`,
);
{
  const dir = scaffold("check", CHECK_SCALE, ["--tsgo-task"], {
    "vite-plus": VITE_PLUS_VERSION,
    "@voidzero-dev/vite-plus-core": VITE_PLUS_VERSION,
    oxlint: OXLINT_VERSION,
    "oxlint-tsgolint": TSGOLINT_VERSION,
    "@typescript/native-preview": repoDevDeps["@typescript/native-preview"],
    typescript: repoDevDeps.typescript,
    turbo: repoDevDeps.turbo,
  });
  // the corpus is SOURCE-ONLY: @demo/* resolves to lib source via tsconfig paths, so no
  // dist exists and no build runs. This is load-bearing, not a convenience — vp check's
  // type-aware pass lints every file in the type program, so with dist built it sweeps
  // the emitted .js/.d.ts too (measured during bring-up: 5,321 files and 308,800
  // warnings at this scale, vs the 720 source files) and none of the three engines
  // would be timing the same corpus.
  {
    const base = JSON.parse(readFileSync(join(dir, "tsconfig.base.json"), "utf8"));
    base.compilerOptions.paths = { "@demo/*": ["./packages/*/src/index.ts"] };
    writeFileSync(join(dir, "tsconfig.base.json"), JSON.stringify(base, null, 2) + "\n");
    for (const lib of readdirSync(join(dir, "packages"))) {
      const p = join(dir, "packages", lib, "tsconfig.json");
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      // check-only: emit-oriented rootDir rejects the cross-lib source the paths mapping
      // pulls in, and outDir-without-rootDir is itself a config error — nothing in this
      // scaffold ever builds
      delete cfg.compilerOptions.rootDir;
      delete cfg.compilerOptions.outDir;
      cfg.compilerOptions.noEmit = true;
      writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    }
    for (const app of readdirSync(join(dir, "apps"))) {
      const p = join(dir, "apps", app, "tsconfig.json");
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      // incremental writes tsconfig.tsbuildinfo during a type-aware pass — sample N
      // would time a different fs state than sample 1
      cfg.compilerOptions.incremental = false;
      writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    }
  }
  const expectedFiles = walkLintable(dir, "apps").length + walkLintable(dir, "packages").length;
  const expectedVpFiles = expectedFiles + 1; // + the root vite.config.ts
  console.log(`  corpus: ${expectedFiles} lintable files (+1 root config for vp check)`);

  // @ts-nocheck: the config is harness, not corpus — vp check lints every project file
  // including this one, and the beta core's defineConfig type does not yet carry the
  // lint key its runtime accepts (TS2769 otherwise)
  writeFileSync(
    join(dir, "vite.config.ts"),
    `// @ts-nocheck
import { defineConfig } from "@voidzero-dev/vite-plus-core";
export default defineConfig({ lint: { options: { typeAware: true, typeCheck: true } } });
`,
  );
  // whole-program baseline config, the optimal-gate shape: every lib resolved to source
  writeFileSync(
    join(dir, "tsconfig.whole.json"),
    JSON.stringify(
      {
        // the optimal-gate whole-program shape (one tsgo process, libs from source)
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
    ),
  );

  // vite-plus's ACTUAL engine pins must equal the consts the baselines install
  {
    const vpPkg = JSON.parse(
      readFileSync(join(dir, "node_modules", "vite-plus", "package.json"), "utf8"),
    );
    const pinned = {
      oxlint: vpPkg.dependencies?.oxlint,
      tsgolint: vpPkg.dependencies?.["oxlint-tsgolint"],
    };
    if (pinned.oxlint !== `=${OXLINT_VERSION}` || pinned.tsgolint !== `=${TSGOLINT_VERSION}`)
      fail(
        `vite-plus ${VITE_PLUS_VERSION} pins oxlint ${pinned.oxlint} / oxlint-tsgolint ${pinned.tsgolint}; this bench's baseline consts are ${OXLINT_VERSION} / ${TSGOLINT_VERSION} — update them together`,
      );
  }

  // the LAST summary line: vp check can print one per pass; the final one is the run's
  const vpFiles = (o) => {
    const m = [...o.matchAll(/in (\d+) files/g)];
    return +(m.at(-1)?.[1] ?? NaN);
  };
  const oxFiles = (o) => +(o.match(/"number_of_files":\s*(\d+)/)?.[1] ?? NaN);
  const gate =
    (label, files, expected = expectedFiles) =>
    (r) => {
      if (r.code !== 0) fail(`${label} exited ${r.code}:\n${r.out.slice(-600)}`);
      const n = files(r.out);
      if (n !== expected)
        fail(`${label} covered ${n} files, expected ${expected} — not the same corpus`);
    };

  // positive control (the lint-bench discipline): seed one type error, every engine
  // must flag it and exit non-zero — an engine whose type-aware pass silently no-ops
  // must not produce a timed number. The probe file is removed before timing and the
  // corpus re-verified clean.
  {
    const probe = join(
      dir,
      "apps",
      readdirSync(join(dir, "apps")).sort()[0],
      "app",
      "bench-probe.ts",
    );
    writeFileSync(probe, 'export const benchProbe: number = "not a number";\n');
    const controls = [
      ["vp check", run("pnpm", ["exec", "vp", "check", "--no-fmt"], { cwd: dir })],
      [
        "oxlint --type-aware --type-check",
        run(
          "pnpm",
          ["exec", "oxlint", "--type-aware", "--type-check", "--format=json", "apps", "packages"],
          { cwd: dir },
        ),
      ],
      [
        "tsgo whole-program",
        run("pnpm", ["exec", "tsgo", "--noEmit", "-p", "tsconfig.whole.json"], { cwd: dir }),
      ],
    ];
    for (const [name, r] of controls) {
      if (r.code === 0) fail(`positive control: ${name} exited 0 on a seeded type error`);
      if (!/bench-probe/.test(r.out) && !/TS2322|2322/.test(r.out))
        fail(
          `positive control: ${name} failed without naming the seeded error:\n${r.out.slice(-400)}`,
        );
    }
    rmSync(probe);
    console.log("  positive control: all three engines flag a seeded type error");
  }

  const rung = {};
  rung.vpCheckOnePass = sampled(
    "vp check --no-fmt (lint + type errors, one pass)",
    () => run("pnpm", ["exec", "vp", "check", "--no-fmt"], { cwd: dir }),
    gate("vp check", vpFiles, expectedVpFiles),
  );
  rung.oxlintTypeAware = sampled(
    "oxlint --type-aware --type-check (same engines, standalone)",
    () =>
      run(
        "pnpm",
        ["exec", "oxlint", "--type-aware", "--type-check", "--format=json", "apps", "packages"],
        { cwd: dir },
      ),
    gate("oxlint --type-aware --type-check", oxFiles),
  );
  // context row, different type-check model: per-file typed lint above vs ONE whole
  // program here — labeled, not summed into a verdict
  const oxPlain = sampled(
    "oxlint (syntactic)",
    () => run("pnpm", ["exec", "oxlint", "--format=json", "apps", "packages"], { cwd: dir }),
    gate("oxlint", oxFiles),
  );
  // corpus gate for the whole-program row: one untimed --listFiles pass must contain
  // every source .ts/.tsx (the program can also pull lib .d.ts — supersets are fine,
  // missing source is not)
  {
    const lf = run(
      "pnpm",
      ["exec", "tsgo", "--noEmit", "-p", "tsconfig.whole.json", "--listFiles"],
      { cwd: dir },
    );
    if (lf.code !== 0) fail(`tsgo --listFiles exited ${lf.code}`);
    const listed = new Set(lf.out.split("\n").map((l) => l.trim()));
    const missing = [...walkLintable(dir, "apps"), ...walkLintable(dir, "packages")]
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts") && !/next\.config/.test(f))
      .filter((f) => !listed.has(join(dir, f)));
    if (missing.length)
      fail(`tsgo whole program is missing ${missing.length} source files (e.g. ${missing[0]})`);
  }
  const tsgoWhole = sampled(
    "tsgo --noEmit -p tsconfig.whole.json (one program)",
    () => run("pnpm", ["exec", "tsgo", "--noEmit", "-p", "tsconfig.whole.json"], { cwd: dir }),
    (r) => {
      if (r.code !== 0) fail(`tsgo whole-program exited ${r.code}:\n${r.out.slice(-600)}`);
    },
  );
  rung.optimalGateShape = {
    note: "different type-check model (one tsgo program over lib source vs tsgolint per-file typed lint) — context, not like-for-like",
    oxlintMs: oxPlain.medianMs,
    tsgoWholeMs: tsgoWhole.medianMs,
    sequentialMs: oxPlain.medianMs + tsgoWhole.medianMs,
  };
  rung.corpusFiles = { lintable: expectedFiles, vpCheckWithRootConfig: expectedVpFiles };
  out.rungs.check = rung;
}

// ---- BUILD rung ----------------------------------------------------------------------------------
console.log(
  `\n== build: vp build vs vite build, one app (${BUILD_SCALE.apps}:${BUILD_SCALE.libs}, --framework vite) ==`,
);
{
  const dir = scaffold("build", BUILD_SCALE, ["--framework", "vite"], {
    "vite-plus": VITE_PLUS_VERSION,
    "@voidzero-dev/vite-plus-core": VITE_PLUS_VERSION,
    typescript: repoDevDeps.typescript,
    turbo: repoDevDeps.turbo,
  });
  const b = run(
    "pnpm",
    ["exec", "turbo", "run", "build", "--filter=./packages/*", `--concurrency=${CORES}`],
    {
      cwd: dir,
      env: { TURBO_TELEMETRY_DISABLED: "1", TURBO_CACHE_DIR: join(dir, ".turbo", "cache") },
    },
  );
  if (b.code !== 0) fail(`build-scaffold lib build failed:\n${b.out.slice(-600)}`);
  const app = readdirSync(join(dir, "apps")).sort()[0];
  const appDir = join(dir, "apps", app);
  const workspaceVite = JSON.parse(
    readFileSync(join(appDir, "node_modules", "vite", "package.json"), "utf8"),
  ).version;
  // the vite that `vp build` actually runs: resolve vite from INSIDE vite-plus-core —
  // the core package's own version is not the bundled vite's version
  const coreDir = join(dir, "node_modules", "@voidzero-dev", "vite-plus-core");
  const coreViteProbe = spawnSync(
    "node",
    ["-e", 'process.stdout.write(require("vite/package.json").version)'],
    { cwd: coreDir, encoding: "utf8" },
  );
  const coreVite = coreViteProbe.status === 0 ? coreViteProbe.stdout.trim() : null;
  if (!coreVite) fail("could not resolve the vite version inside vite-plus-core");

  const hashDist = () => {
    const acc = {};
    const walk = (rel) => {
      for (const e of readdirSync(join(appDir, rel))) {
        const p = join(rel, e);
        if (statSync(join(appDir, p)).isDirectory()) walk(p);
        else
          acc[p] = createHash("sha256")
            .update(readFileSync(join(appDir, p)))
            .digest("hex");
      }
    };
    walk("dist");
    return acc;
  };
  const clean = () => {
    rmSync(join(appDir, "dist"), { recursive: true, force: true });
    rmSync(join(appDir, "node_modules", ".vite"), { recursive: true, force: true });
    rmSync(join(dir, "node_modules", ".vite"), { recursive: true, force: true });
  };
  const gate = (label) => (r) => {
    if (r.code !== 0) fail(`${label} exited ${r.code}:\n${r.out.slice(-600)}`);
    if (!existsSync(join(appDir, "dist", "index.html"))) fail(`${label} produced no dist output`);
  };

  const rung = { app, workspaceVite, vpBundledVite: coreVite };
  let viteDist, vpDist;
  rung.viteBuild = sampled(
    `vite build (workspace vite ${workspaceVite})`,
    () => {
      clean();
      const r = run("pnpm", ["exec", "vite", "build"], { cwd: appDir });
      viteDist = r.code === 0 ? hashDist() : viteDist;
      return r;
    },
    gate("vite build"),
  );
  rung.vpBuild = sampled(
    "vp build (bundled vite-plus-core)",
    () => {
      clean();
      const r = run("pnpm", ["exec", "vp", "build"], { cwd: appDir });
      vpDist = r.code === 0 ? hashDist() : vpDist;
      return r;
    },
    gate("vp build"),
  );
  // identity verdict: recorded, not asserted — a delta is the bundled-version finding
  const keys = new Set([...Object.keys(viteDist), ...Object.keys(vpDist)]);
  const differing = [...keys].filter((k) => viteDist[k] !== vpDist[k]);
  rung.distIdentical = differing.length === 0;
  rung.distFiles = { vite: Object.keys(viteDist).length, vp: Object.keys(vpDist).length };
  rung.distDifferingSample = differing.slice(0, 5);
  // cooperative caching runs through the task runner WITH --cache (a bare repeated
  // `vp build` never engages the task cache): cold then repeat, hits parsed from vp's
  // own summary; if the tracer refuses the build for input modification, the refusal
  // is the recorded finding
  const appPkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).name;
  clean();
  const coopArgs = [
    "exec",
    "vp",
    "run",
    "--filter",
    appPkg,
    "--cache",
    "--log",
    "grouped",
    "build",
  ];
  const coop1 = run("pnpm", coopArgs, { cwd: dir });
  gate("vp run --cache build (cold)")(coop1);
  const coop2 = run("pnpm", coopArgs, { cwd: dir });
  gate("vp run --cache build (repeat)")(coop2);
  const hits = (o) =>
    o
      .match(/vp run:\s+(\d+)\/(\d+)\s+cache hit/)
      ?.slice(1, 3)
      .map(Number);
  // a task refused for input-modification prints no X/Y summary — that refusal is the
  // finding (the same fs-traced boundary vite-task-bench records for next build), so it
  // is recorded, not failed
  const refusalLine = (o) =>
    o
      .split("\n")
      .find((l) => /not cached because it modified its input/i.test(l))
      ?.trim() || null;
  const h2 = hits(coop2.out);
  const refusal = refusalLine(coop2.out) || refusalLine(coop1.out);
  if (!h2 && !refusal)
    fail(
      `vp run --cache build: neither a cache-hit summary nor a refusal line:\n${coop2.out.slice(-400)}`,
    );
  rung.vpTaskCachedBuild = {
    coldMs: coop1.ms,
    repeatMs: coop2.ms,
    repeatHits: h2 ? `${h2[0]}/${h2[1]}` : null,
    repeatServedFromCache: !!h2 && h2[0] === h2[1] && h2[1] > 0,
    inputModificationRefusal: refusal,
  };
  console.log(
    `  dist identical: ${rung.distIdentical} (${rung.distFiles.vite}/${rung.distFiles.vp} files); vp task-cached build repeat: ${coop2.ms}ms (${h2 ? `${h2[0]}/${h2[1]} hits` : "refused: input modification"})`,
  );
  out.rungs.build = rung;
}

// ---- write ---------------------------------------------------------------------------------------
const canonical = SAMPLES === 3;
const dest = canonical ? "vite-plus-tools-bench.json" : "vite-plus-tools-bench.partial.json";
writeFileSync(join(REPO, "bench", dest), JSON.stringify(out, null, 2) + "\n");
console.log(`\n--- bench/${dest} written${canonical ? "" : " (non-canonical → partial)"} ---`);

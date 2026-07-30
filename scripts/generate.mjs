#!/usr/bin/env node
// Generates a pnpm + Turborepo workspace of N tiny Next.js apps and M moderate
// libraries with a realistic, layered dependency graph.
//
//   node scripts/generate.mjs --apps 10000 --libs 300 --modules 16 \
//       --app-deps 4 --lib-deps 3 --layers 6 --universal 1 --clean
//
// Design goals:
//   * Apps are TINY (a layout + a page importing a few libs).
//   * Libs are MODERATE (an index plus `modules` small TS modules).
//   * Libs form a LAYERED DAG so build closures are bounded but non-trivial.
//   * Everything is DETERMINISTIC so benchmarks are reproducible.
//
// Two graph shapes (--shape):
//   * layered (default): the original evenly-layered DAG above.
//   * skewed: the shape measured on a real production fleet of ~30k Next.js
//     apps sharing ~460 libs. Its structure differs from `layered` in four
//     ways that change benchmark behavior:
//       1. A universal foundation tier that every APP imports. Libs are not
//          force-injected with it (in `layered`, --universal is) — a lib
//          reaches a foundation lib only through its own zipf picks, which is
//          what gives the foundation its high-but-partial lib in-degree.
//       2. A "popular tier" of semi-universal libs adopted by a declining
//          fraction of apps (93%..50%) — the measured fleet has ~13 libs
//          imported by more than half the apps, a flat-then-cliff curve a
//          zipf tail cannot produce.
//       3. A bimodal lib graph: ~40% of libs are dependency-less sinks, while
//          a dense mid-index region forms deep narrow chains (depth to ~15)
//          via near-neighbor deps plus zipf-weighted picks that converge on a
//          small shared trunk (foundation-adjacent libs with high in-degree).
//       4. Per-app fanout is variable (median 14 workspace deps) instead of a
//          constant --app-deps.
//     `--preset fleet` selects this shape at the measured scale; see FLEET.md
//     for the target-vs-generated metric table (bench/fleet-shape.json).

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bunWorkspaceNameKey } from "./_wyhash11.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const env = process.env[name.toUpperCase().replace(/-/g, "_")];
  return env ?? def;
};

// Numeric options must be integers >= a sane minimum. parseInt silently accepts
// junk ("abc" -> NaN) and negatives ("--apps -5" -> -5), either of which would
// generate an empty workspace with no error; reject them up front.
const intOpt = (name, def, min) => {
  const raw = opt(name, def);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    console.error(`--${name} must be an integer >= ${min} (got "${raw}")`);
    process.exit(1);
  }
  return n;
};

// A preset supplies DEFAULTS for other options (explicit flags and env vars still
// win — opt() checks those first, and pdef only replaces the hardcoded fallback).
// `fleet` is the measured production-fleet shape at its measured scale.
const PRESETS = {
  fleet: {
    apps: "30000",
    libs: "460",
    modules: "13", // median TS modules per measured lib
    "app-modules": "28", // median measured app is ~30 TS files (layout + page + 28)
    shape: "skewed",
    universal: "5", // libs imported by >=97% of measured apps
    popular: "10", // semi-universal tier, adoption 93%..50%
    "tail-picks": "2", // long-tail lib picks per app (median fanout: 5+~7+2 ~= 14)
  },
};
const PRESET = opt("preset", "");
if (PRESET && !PRESETS[PRESET]) {
  console.error(`unknown --preset "${PRESET}" (use: ${Object.keys(PRESETS).join("|")})`);
  process.exit(1);
}
const pdef = (name, def) => (PRESET ? (PRESETS[PRESET][name] ?? def) : def);

const APPS = intOpt("apps", pdef("apps", "50"), 0); // 0 apps (libs only) is allowed
const LIBS = intOpt("libs", pdef("libs", "50"), 1); // layer math divides by LIBS/LAYERS
const MODULES = intOpt("modules", pdef("modules", "16"), 1); // modules per library (index imports mod-01)
const APP_DEPS = intOpt("app-deps", "4", 0); // lib deps per app (layered shape)
const LIB_DEPS = intOpt("lib-deps", "3", 0); // lib->lib deps (layered shape)
const LAYERS = intOpt("layers", "6", 1); // dependency layers (layerSize divides by it)
// Extra self-contained TS modules per app (beyond layout + page), imported by the
// page so every checker/bundler sees them. 0 = the original two-file app (default).
const APP_MODULES = intOpt("app-modules", pdef("app-modules", "0"), 0);
const SHAPE = opt("shape", pdef("shape", "layered")); // "layered" | "skewed"
if (!["layered", "skewed"].includes(SHAPE)) {
  console.error(`unknown --shape "${SHAPE}" (use layered|skewed)`);
  process.exit(1);
}
// skewed-shape knobs (ignored under layered)
const POPULAR = intOpt("popular", pdef("popular", "10"), 0);
const TAIL_PICKS = intOpt("tail-picks", pdef("tail-picks", "2"), 0);
// Universal foundation tier: the lowest `--universal K` libs (indices 1..K) become a
// dependency of EVERY app and every non-foundation lib — the @acme/core / design-system
// / logger that a real monorepo has everyone import. Each foundation lib is forced to a
// pure sink (depends on nothing), so the tier stays acyclic and revving one has a blast
// radius of the whole repo (every app rebuilds). That whole-repo-blast case is what the
// lib-revision bench measures. 0 = no universal lib (default).
const UNIVERSAL = intOpt("universal", pdef("universal", "0"), 0); // validated against layer size below
// Also emit a `typecheck:tsgo` script in every package (a tsgo-backed twin of the
// `typecheck` task) so a bench can run the same gate under tsc vs tsgo. Off by
// default so the generator's output (and other benches' input hashes) is unchanged.
const TSGO_TASK = flag("tsgo-task");
// Also emit a `test` script (node --test over a per-package smoke test) in every package,
// so a bench can measure the TEST axis through Turbo's `test` task (defined in the root
// turbo.json with no task deps, so a `turbo run test` isolates test-task selection +
// execution from the build axis). The turbo.json `test` task is inert for any package that
// has no `test` script, so it is harmless when this flag is off. Off by default so other
// benches' input hashes and generator output are unchanged.
const TEST_TASK = flag("test-task");
const VERSIONED = flag("versioned"); // stamp real semver + use workspace:^x.y.z specifiers
// Version skew: pin --skew% of apps to off-catalog react/react-dom versions, to
// model a real rollout where not every app is on the catalog version at once.
// Skewed apps stop sharing the catalog version → extra lockfile/store entries and
// divergent Turbo input hashes (fewer cache hits). 0 = fully catalogued (default).
const SKEW_PCT = intOpt("skew", "0", 0);
const SKEW_VERSIONS = ["19.1.0", "19.0.0"]; // real react/react-dom versions off the 19.2.7 catalog
const isSkewed = (i) => SKEW_PCT > 0 && i <= Math.round((APPS * SKEW_PCT) / 100);
const skewVer = (i) => SKEW_VERSIONS[i % SKEW_VERSIONS.length];
const FRAMEWORK = opt("framework", "next"); // "next" | "vite"
if (!["next", "vite"].includes(FRAMEWORK)) {
  console.error(`unknown --framework "${FRAMEWORK}" (use next|vite)`);
  process.exit(1);
}
const CLEAN = flag("clean");

const ROOT = process.cwd();
const APPS_DIR = join(ROOT, "apps");
const LIBS_DIR = join(ROOT, "packages");

const appW = String(APPS).length;
const libW = String(LIBS).length;
const pad = (n, w) => String(n).padStart(w, "0");

const libDir = (i) => `lib-${pad(i, libW)}`;
const libPkg = (i) => `@demo/lib-${pad(i, libW)}`;
const libSym = (i) => `lib${pad(i, libW)}Main`;
const appDir = (i) => `app-${pad(i, appW)}`;
const appPkgBase = (i) => `@demo/app-${pad(i, appW)}`;

// bun keys workspace-name duplicate detection on a u32-TRUNCATED Wyhash11 of
// the package name and refuses the install ("Workspace name already exists") on
// any truncated-hash collision between two distinct names — ~10% odds at 30k
// packages, and this generator's deterministic fleet-scale universe contains one
// such pair (oven-sh/bun#36386: @demo/app-03511 / @demo/app-13215). Pre-scan
// every name this run will emit and rename a colliding APP package — name only:
// nothing imports an app, its directory keeps the plain app-<i> form, and the
// benches that target one app resolve its name from the on-disk manifest
// (scripts/_app-name.mjs), never by index formula. Two LIBS colliding is a hard
// error instead (the `@demo/*` -> `packages/*/src` tsconfig paths mapping ties
// a lib's name to its directory, so a lib rename would need a coordinated
// directory rename); an app colliding with a lib renames the APP, since libs
// claim their buckets first. The workspace ROOT manifest is not scanned: bun's
// duplicate map covers glob-matched members only. Remove all of this once the
// upstream fix ships.
const APP_NAME_REMAP = new Map(); // app index -> replacement package name
{
  // claim(name): record the name's truncated key if free; return the holder if taken
  const claimed = new Map();
  const claim = (name) => {
    const k = bunWorkspaceNameKey(name);
    const holder = claimed.get(k);
    if (holder === undefined) claimed.set(k, name);
    return holder;
  };
  for (let i = 1; i <= LIBS; i++) {
    const holder = claim(libPkg(i));
    if (holder !== undefined) {
      console.error(
        `lib name bun-hash collision: ${libPkg(i)} vs ${holder} (oven-sh/bun#36386) — ` +
          `libs cannot be renamed independently of their directory; change LIBS or the name scheme`,
      );
      process.exit(1);
    }
  }
  for (let i = 1; i <= APPS; i++) {
    let name = appPkgBase(i);
    for (let r = 1; claim(name) !== undefined; r++) name = `${appPkgBase(i)}-r${r}`;
    if (name !== appPkgBase(i)) APP_NAME_REMAP.set(i, name);
  }
}
const appPkg = (i) => APP_NAME_REMAP.get(i) ?? appPkgBase(i);

// ---- dependency graph ----------------------------------------------------
const layerSize = Math.ceil(LIBS / LAYERS);
const layerOf = (i) => Math.floor((i - 1) / layerSize); // 0-based layer
// Keep the foundation tier within layer 0: forcing a foundation lib to a pure sink
// (libDeps -> []) would otherwise silently strip the real layer-below deps of any
// foundation lib that spilled into layer 1+, flattening the graph shape.
if (SHAPE === "layered" && UNIVERSAL > layerSize) {
  console.error(
    `--universal (${UNIVERSAL}) must be <= layer size (${layerSize} = ceil(LIBS/LAYERS))`,
  );
  process.exit(1);
}

// Optional semver mode: stamp real versions and reference internal deps with a
// semver-flavored workspace specifier (`workspace:^1.2.3`). pnpm links the local
// package during dev and rewrites the spec to `^1.2.3` on publish — the
// independently-versioned-internal-packages convention.
const libVersion = (i) => (VERSIONED ? `1.${layerOf(i)}.${i}` : "0.0.0");
const wsSpec = (d) => (VERSIONED ? `workspace:^${libVersion(d)}` : "workspace:*");

// indices 1..UNIVERSAL form the universal foundation tier (see --universal).
const isFoundation = (i) => i >= 1 && i <= UNIVERSAL;
// Fixed once UNIVERSAL is parsed; injected into every non-foundation package's
// dep set, so hoist it out of the per-package hot loop rather than rebuilding it.
const FOUNDATION_DEPS = Array.from({ length: UNIVERSAL }, (_, k) => k + 1);

// ---- skewed shape --------------------------------------------------------
// Constants tuned against the measured fleet's metric vector (see FLEET.md):
// median app fanout 14, ~13 libs adopted by >50% of apps, ~40% sink libs, lib
// graph depth to ~15 with median ~2, mean ~1.7 deps/lib, median app closure ~43.
const SINK_LO = 12; // sink % at the low-index end (dense platform cluster)
const SINK_HI = 72; // sink % at the high-index end (leafy long tail)
const NEAR_SPAN = 6; // near-neighbor dep window that forms deep chains
const DEPTH_CAP = 15; // the measured fleet's max chain depth; deps that would
// push a chain past it are skipped, so chains stay dense but bounded (the
// measured graph is fat in the 8..15 range with a hard max of 15)
const ZIPF_LIB = 1.4; // lib->lib long-range picks converge on a low-index trunk
const ZIPF_TAIL = 1.2; // app long-tail picks
const DEP_COUNTS = [2, 3, 3, 4]; // per-lib dep count cycle (non-sinks)
const POP_BAND_LO = 0.3; // popular tier sits in the 30%..55% index band —
const POP_BAND_HI = 0.55; // mid-chain, so popular libs carry deep closures
const POP_COV_HI = 0.93; // adoption declines linearly across the tier
const POP_COV_LO = 0.5;

// Deterministic 32-bit mix -> uniform [0,1). No Math.random anywhere: the same
// (i, k, salt) triple always yields the same value, on every platform.
const u32 = (x) => x >>> 0;
const lcgStep = (s) => u32(Math.imul(s, 1664525) + 1013904223);
const rnd = (i, k, salt) => {
  const s = u32(Math.imul(i, 2654435761) ^ Math.imul(k, 40503) ^ Math.imul(salt, 69069));
  return lcgStep(lcgStep(s)) / 4294967296;
};

// Pick an index in [lo, hi] with P(rank r) ~ 1/r^s (rank 1 = lo). Cumulative
// weights are cached per (n, s); binary search maps a uniform u onto a rank.
const zipfCache = new Map();
function zipfPick(lo, hi, s, u) {
  const n = hi - lo + 1;
  if (n <= 0) return null;
  const key = n + ":" + s;
  let cum = zipfCache.get(key);
  if (!cum) {
    cum = new Float64Array(n);
    let c = 0;
    for (let r = 1; r <= n; r++) {
      c += 1 / r ** s;
      cum[r - 1] = c;
    }
    zipfCache.set(key, cum);
  }
  const x = u * cum[n - 1];
  let loI = 0;
  let hiI = n - 1;
  while (loI < hiI) {
    const mid = (loI + hiI) >> 1;
    if (cum[mid] < x) loI = mid + 1;
    else hiI = mid;
  }
  return lo + loI;
}

// The popular tier: POPULAR libs at evenly spaced indices inside the
// [POP_BAND_LO, POP_BAND_HI] band of the non-foundation range. They are exempt
// from the sink roll (a lib most apps import has real content and real deps).
const POPULAR_LIBS =
  SHAPE === "skewed"
    ? [
        ...new Set(
          Array.from({ length: POPULAR }, (_, b) =>
            Math.min(
              LIBS,
              UNIVERSAL +
                Math.max(
                  1,
                  Math.round(
                    (POP_BAND_LO + ((POP_BAND_HI - POP_BAND_LO) * b) / Math.max(1, POPULAR - 1)) *
                      (LIBS - UNIVERSAL),
                  ),
                ),
            ),
          ),
        ),
      ].sort((a, b) => a - b)
    : [];
const POPULAR_SET = new Set(POPULAR_LIBS);

// Skewed lib graph: foundation libs are pure sinks; other libs are sinks with a
// probability that ramps SINK_LO -> SINK_HI across the index range (dense
// platform cluster low, leafy tail high). A non-sink takes one near-neighbor dep
// (chains -> depth) plus zipf picks over ALL lower indices — including the
// foundation, so individual libs still import foundation libs (the trunk with
// the highest lib in-degree). What layered does and this shape does NOT do is
// force the foundation into every lib's deps: on the measured fleet the
// universal tier is universal for apps only, and libs average ~1.7 deps.
const skewedDepsMemo = new Map();
const skewedDepthMemo = new Map();
// Chain depth of lib i under the skewed graph (deps only point at j < i, so
// this recursion terminates; memoized, so the whole pass is linear-ish).
function skewedDepth(i) {
  if (skewedDepthMemo.has(i)) return skewedDepthMemo.get(i);
  const ds = skewedLibDeps(i);
  const r = ds.length ? 1 + Math.max(...ds.map(skewedDepth)) : 0;
  skewedDepthMemo.set(i, r);
  return r;
}

function skewedLibDeps(i) {
  if (skewedDepsMemo.has(i)) return skewedDepsMemo.get(i);
  let out = [];
  if (!isFoundation(i)) {
    const span = LIBS - UNIVERSAL;
    const sinkPct = SINK_LO + ((SINK_HI - SINK_LO) * (i - UNIVERSAL)) / Math.max(1, span);
    if (POPULAR_SET.has(i) || rnd(i, 0, 1) * 100 >= sinkPct) {
      const cnt = DEP_COUNTS[i % DEP_COUNTS.length];
      const deps = new Set();
      // a dep is admissible only if it doesn't push this chain past DEPTH_CAP
      const fits = (j) => j !== null && j !== i && skewedDepth(j) < DEPTH_CAP;
      const lo = Math.max(UNIVERSAL + 1, i - NEAR_SPAN);
      if (lo <= i - 1) {
        const j = lo + Math.floor(rnd(i, 100, 2) * (i - lo));
        if (j < i && fits(j)) deps.add(j);
      }
      for (let k = 0; deps.size < cnt && k < cnt * 4; k++) {
        const j = zipfPick(1, i - 1, ZIPF_LIB, rnd(i, k, 3));
        if (fits(j)) deps.add(j);
      }
      out = [...deps].sort((a, b) => a - b);
    }
  }
  skewedDepsMemo.set(i, out);
  return out;
}

// Skewed app fanout: the whole foundation tier, a bernoulli draw per popular-tier
// lib (adoption declining POP_COV_HI -> POP_COV_LO), and TAIL_PICKS zipf picks
// over the rest. Fanout is therefore variable per app (median ~14 at defaults).
function skewedAppDeps(a) {
  const deps = new Set(FOUNDATION_DEPS);
  POPULAR_LIBS.forEach((lib, bi) => {
    const p = POP_COV_HI - ((POP_COV_HI - POP_COV_LO) * bi) / Math.max(1, POPULAR_LIBS.length - 1);
    if (rnd(a, 200 + bi, 5) < p) deps.add(lib);
  });
  let picks = 0;
  for (let k = 0; picks < TAIL_PICKS && k < TAIL_PICKS * 8; k++) {
    const j = zipfPick(UNIVERSAL + 1, LIBS, ZIPF_TAIL, rnd(a, k, 4));
    if (j !== null && !deps.has(j)) {
      deps.add(j);
      picks++;
    }
  }
  return [...deps].sort((a2, b2) => a2 - b2);
}

// Lib i depends on LIB_DEPS libs from the layer below (deterministic spread),
// so closures are bounded by the number of layers but overlap heavily
// (realistic: many features share a few foundation libs).
function layeredLibDeps(i) {
  // A foundation lib is a pure sink: it depends on nothing, so the tier can be
  // injected everywhere below without ever forming a cycle.
  if (isFoundation(i)) return [];
  const layer = layerOf(i);
  const deps = new Set();
  if (layer > 0) {
    const prevStart = (layer - 1) * layerSize + 1;
    const prevEnd = Math.min(layer * layerSize, LIBS);
    const span = prevEnd - prevStart + 1;
    for (let k = 0; k < LIB_DEPS && span > 0; k++) {
      const idx = prevStart + ((i * 7 + k * 13) % span);
      deps.add(idx);
    }
  }
  for (const f of FOUNDATION_DEPS) deps.add(f); // every non-foundation lib imports the foundation tier
  return [...deps].sort((a, b) => a - b);
}

// App i depends on APP_DEPS libs spread deterministically across the whole lib range
// (all layers), plus the whole foundation tier (so revving a foundation lib
// invalidates every app).
function layeredAppDeps(i) {
  const deps = new Set();
  for (let k = 0; k < APP_DEPS; k++) {
    const idx = 1 + ((i * 31 + k * 97) % LIBS);
    deps.add(idx);
  }
  for (const f of FOUNDATION_DEPS) deps.add(f);
  return [...deps].sort((a, b) => a - b);
}

const libDeps = SHAPE === "skewed" ? skewedLibDeps : layeredLibDeps;
const appDeps = SHAPE === "skewed" ? skewedAppDeps : layeredAppDeps;

// ---- file templates ------------------------------------------------------
function moduleSource(libIdx, modIdx) {
  const tag = `${pad(libIdx, libW)}_${pad(modIdx, 2)}`;
  return moduleSourceForTag(
    tag,
    libIdx * 1000 + modIdx,
    `// @demo/lib-${pad(libIdx, libW)} module ${modIdx}`,
  );
}

function moduleSourceForTag(tag, seed, header) {
  return `${header}
export interface Rec_${tag} {
  id: number;
  name: string;
  tags: readonly string[];
  weight: number;
}

export function make_${tag}(id: number): Rec_${tag} {
  return { id, name: "rec-${tag}-" + id, tags: ["${tag}"], weight: id * 1.5 };
}

export function fold_${tag}(xs: readonly number[]): number {
  return xs.reduce((acc, x) => acc + x * 2 - 1, 0);
}

export function classify_${tag}(r: Rec_${tag}): "light" | "heavy" {
  return r.weight > 10 ? "heavy" : "light";
}

export function merge_${tag}(a: Rec_${tag}, b: Rec_${tag}): Rec_${tag} {
  return { id: a.id + b.id, name: a.name + "+" + b.name, tags: [...a.tags, ...b.tags], weight: a.weight + b.weight };
}

export const SEED_${tag} = ${seed};
`;
}

function libIndexSource(i) {
  const deps = libDeps(i);
  const reexports = Array.from(
    { length: MODULES },
    (_, m) => `export * from "./mod-${pad(m + 1, 2)}.js";`,
  ).join("\n");
  const depImports = deps.map((d) => `import { ${libSym(d)} } from "${libPkg(d)}";`).join("\n");
  const firstMod = `import { fold_${pad(i, libW)}_01, SEED_${pad(i, libW)}_01 } from "./mod-01.js";`;
  const depCalls = deps.length ? deps.map((d) => `${libSym(d)}(seed)`).join(" + ") : "0";
  return `${reexports}
${firstMod}
${depImports}

export const ${libDir(i).replace(/-/g, "")}Name = "${libPkg(i)}";

export function ${libSym(i)}(seed: number): number {
  const base = fold_${pad(i, libW)}_01([seed, SEED_${pad(i, libW)}_01, seed * 2]);
  return base + ${depCalls};
}
`;
}

function libPackageJson(i) {
  const deps = libDeps(i);
  const dependencies = Object.fromEntries(deps.map((d) => [libPkg(d), wsSpec(d)]));
  return JSON.stringify(
    {
      name: libPkg(i),
      version: libVersion(i),
      private: true,
      type: "module",
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      scripts: {
        build: "tsc -p tsconfig.json",
        typecheck: "tsc --noEmit -p tsconfig.json",
        ...(TSGO_TASK ? { "typecheck:tsgo": "tsgo --noEmit -p tsconfig.json" } : {}),
        ...(TEST_TASK ? { test: "node --test" } : {}),
      },
      dependencies,
      devDependencies: {
        typescript: "catalog:",
        "@types/node": "catalog:",
      },
    },
    null,
    2,
  );
}

const LIB_TSCONFIG = JSON.stringify(
  {
    extends: "../../tsconfig.base.json",
    compilerOptions: {
      module: "NodeNext",
      moduleResolution: "nodenext",
      outDir: "dist",
      rootDir: "src",
      noEmit: false,
      composite: false,
    },
    include: ["src"],
  },
  null,
  2,
);

function appPackageJson(i) {
  const deps = appDeps(i);
  const libDepsObj = Object.fromEntries(deps.map((d) => [libPkg(d), wsSpec(d)]));
  const vite = FRAMEWORK === "vite";
  // most apps reference the shared catalog version; skewed apps pin an off-catalog one
  const reactSpec = isSkewed(i) ? skewVer(i) : "catalog:";
  // keep @types compatible with a skewed (off-catalog) react: a 19.x range, not the
  // exact catalog @types version, so skewed apps still typecheck/build
  const typesReactSpec = isSkewed(i) ? "^19.0.0" : "catalog:";
  return JSON.stringify(
    {
      name: appPkg(i),
      version: VERSIONED ? "1.0.0" : "0.0.0",
      private: true,
      type: "module",
      scripts: vite
        ? {
            build: "vite build",
            dev: "vite",
            preview: "vite preview",
            typecheck: "tsc --noEmit",
            ...(TSGO_TASK ? { "typecheck:tsgo": "tsgo --noEmit" } : {}),
            ...(TEST_TASK ? { test: "node --test" } : {}),
          }
        : {
            build: "next build",
            dev: "next dev",
            start: "next start",
            typecheck: "tsc --noEmit",
            ...(TSGO_TASK ? { "typecheck:tsgo": "tsgo --noEmit" } : {}),
            ...(TEST_TASK ? { test: "node --test" } : {}),
          },
      dependencies: vite
        ? { react: reactSpec, "react-dom": reactSpec, ...libDepsObj }
        : { next: "catalog:", react: reactSpec, "react-dom": reactSpec, ...libDepsObj },
      devDependencies: vite
        ? {
            vite: "catalog:",
            "@vitejs/plugin-react": "catalog:",
            typescript: "catalog:",
            "@types/node": "catalog:",
            "@types/react": typesReactSpec,
            "@types/react-dom": typesReactSpec,
          }
        : {
            typescript: "catalog:",
            "@types/node": "catalog:",
            "@types/react": typesReactSpec,
            "@types/react-dom": typesReactSpec,
          },
    },
    null,
    2,
  );
}

const APP_TSCONFIG = JSON.stringify(
  {
    extends: "../../tsconfig.base.json",
    compilerOptions: {
      module: "esnext",
      moduleResolution: "bundler",
      jsx: "preserve",
      noEmit: true,
      allowJs: true,
      incremental: true,
      plugins: [{ name: "next" }],
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  },
  null,
  2,
);

const APP_NEXT_CONFIG = `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Typecheck is a dedicated Turbo task, not paid for inside every next build.
  typescript: { ignoreBuildErrors: true }
};
export default nextConfig;
`;

const APP_NEXT_ENV = `/// <reference types="next" />
/// <reference types="next/image-types/global" />
`;

const APP_LAYOUT = `export const metadata = { title: "demo app" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

// Extra per-app modules (--app-modules): the same self-contained template as lib
// modules, tagged per app, all imported by the page so every checker, linter, and
// bundler pays for them. `relLibDir` is the path from the page/App component to
// the module dir ("../lib" for Next's app/, "./lib" for Vite's src/).
const appModTag = (i, m) => `a${pad(i, appW)}_${pad(m, 2)}`;
const appModuleSource = (i, m) =>
  moduleSourceForTag(appModTag(i, m), i * 1000 + m, `// ${appPkg(i)} module ${m}`);
function appModuleImports(i, relLibDir) {
  return Array.from(
    { length: APP_MODULES },
    (_, m) => `import { SEED_${appModTag(i, m + 1)} } from "${relLibDir}/mod-${pad(m + 1, 2)}";`,
  ).join("\n");
}
function appModuleSum(i) {
  return Array.from({ length: APP_MODULES }, (_, m) => `SEED_${appModTag(i, m + 1)}`).join(" + ");
}

function appPageSource(i) {
  const deps = appDeps(i);
  const imports = deps.map((d) => `import { ${libSym(d)} } from "${libPkg(d)}";`).join("\n");
  const modImports = APP_MODULES ? appModuleImports(i, "../lib") + "\n" : "";
  const sum = [
    ...deps.map((d, k) => `${libSym(d)}(${k + 1})`),
    ...(APP_MODULES ? [appModuleSum(i)] : []),
  ].join(" + ");
  return `${imports}
${modImports}
export default function Page() {
  const total = ${sum || "0"};
  return (
    <main>
      <h1>${appPkg(i)}</h1>
      <p>total: {total}</p>
    </main>
  );
}
`;
}

// ---- write ---------------------------------------------------------------
// A self-contained per-package smoke test discovered by `node --test` (it scans the package dir for
// files whose names match its default test glob — here only `index.test.mjs`; node_modules is excluded,
// and the .ts source files are not `*.test.*` so they are not matched). It imports nothing — the
// TEST-axis bench measures Turbo's test-task SELECTION (`--filter` picks the package closure, which is
// what makes the axis O(repo) vs O(closure)) and the per-task orchestration/runner cost, not real test
// runtime; a trivial body keeps that signal clean. Placed at the package root, not in `src`, so tsc's
// `include: ["src"]` never picks it up.
const testSource = (pkg) => `import { test } from "node:test";
import assert from "node:assert/strict";

test(${JSON.stringify(`${pkg} smoke`)}, () => {
  assert.equal(1 + 1, 2);
});
`;

function writeLib(i) {
  const dir = join(LIBS_DIR, libDir(i));
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  for (let m = 1; m <= MODULES; m++) {
    writeFileSync(join(src, `mod-${pad(m, 2)}.ts`), moduleSource(i, m));
  }
  writeFileSync(join(src, "index.ts"), libIndexSource(i));
  writeFileSync(join(dir, "package.json"), libPackageJson(i));
  writeFileSync(join(dir, "tsconfig.json"), LIB_TSCONFIG);
  if (TEST_TASK) writeFileSync(join(dir, "index.test.mjs"), testSource(libPkg(i)));
}

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], build: { outDir: "dist" } });
`;
const VITE_MAIN = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
`;
const VITE_APP_TSCONFIG = JSON.stringify(
  {
    extends: "../../tsconfig.base.json",
    compilerOptions: {
      module: "esnext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      noEmit: true,
      lib: ["ES2022", "DOM", "DOM.Iterable"],
    },
    include: ["src", "vite.config.ts"],
  },
  null,
  2,
);
const viteHtml = (i) => `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>${appPkg(i)}</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
function viteAppSource(i) {
  const deps = appDeps(i);
  const imports = deps.map((d) => `import { ${libSym(d)} } from "${libPkg(d)}";`).join("\n");
  const modImports = APP_MODULES ? appModuleImports(i, "./lib") + "\n" : "";
  const sum = [
    ...deps.map((d, k) => `${libSym(d)}(${k + 1})`),
    ...(APP_MODULES ? [appModuleSum(i)] : []),
  ].join(" + ");
  return `${imports}
${modImports}
export function App() {
  const total = ${sum || "0"};
  return (
    <main>
      <h1>${appPkg(i)}</h1>
      <p>total: {total}</p>
    </main>
  );
}
`;
}

// --app-modules: write the per-app module files. For Next they live in
// <app>/lib (the page imports "../lib/mod-XX"; the tsconfig's "**/*.ts"
// includes them). For Vite they live in <app>/src/lib (inside the tsconfig's
// "src" include; the App component imports "./lib/mod-XX").
function writeAppModules(i, dir) {
  if (!APP_MODULES) return;
  const lib = join(dir, FRAMEWORK === "vite" ? "src/lib" : "lib");
  mkdirSync(lib, { recursive: true });
  for (let m = 1; m <= APP_MODULES; m++) {
    writeFileSync(join(lib, `mod-${pad(m, 2)}.ts`), appModuleSource(i, m));
  }
}

function writeApp(i) {
  const dir = join(APPS_DIR, appDir(i));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), appPackageJson(i));
  if (TEST_TASK) writeFileSync(join(dir, "index.test.mjs"), testSource(appPkg(i)));
  writeAppModules(i, dir);
  if (FRAMEWORK === "vite") {
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(dir, "index.html"), viteHtml(i));
    writeFileSync(join(dir, "vite.config.ts"), VITE_CONFIG);
    writeFileSync(join(dir, "tsconfig.json"), VITE_APP_TSCONFIG);
    writeFileSync(join(src, "main.tsx"), VITE_MAIN);
    writeFileSync(join(src, "App.tsx"), viteAppSource(i));
  } else {
    const app = join(dir, "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), APP_TSCONFIG);
    writeFileSync(join(dir, "next.config.mjs"), APP_NEXT_CONFIG);
    writeFileSync(join(dir, "next-env.d.ts"), APP_NEXT_ENV);
    writeFileSync(join(app, "layout.tsx"), APP_LAYOUT);
    writeFileSync(join(app, "page.tsx"), appPageSource(i));
  }
}

function main() {
  const t0 = process.hrtime.bigint();
  if (CLEAN) {
    for (const d of [APPS_DIR, LIBS_DIR]) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  }
  mkdirSync(APPS_DIR, { recursive: true });
  mkdirSync(LIBS_DIR, { recursive: true });

  for (let i = 1; i <= LIBS; i++) {
    writeLib(i);
    if (i % 50 === 0) process.stdout.write(`  libs ${i}/${LIBS}\r`);
  }
  process.stdout.write(`  libs ${LIBS}/${LIBS}\n`);

  for (let i = 1; i <= APPS; i++) {
    writeApp(i);
    if (i % 500 === 0) process.stdout.write(`  apps ${i}/${APPS}\r`);
  }
  process.stdout.write(`  apps ${APPS}/${APPS}\n`);

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // +1 per package for the index.test.mjs emitted under --test-task
  const fileCount = LIBS * (MODULES + 3) + APPS * (6 + APP_MODULES) + (TEST_TASK ? LIBS + APPS : 0);
  console.log(
    JSON.stringify({
      apps: APPS,
      libs: LIBS,
      modulesPerLib: MODULES,
      appModules: APP_MODULES,
      shape: SHAPE,
      ...(PRESET ? { preset: PRESET } : {}),
      ...(SHAPE === "skewed"
        ? { popular: POPULAR, tailPicks: TAIL_PICKS }
        : { appDeps: APP_DEPS, libDeps: LIB_DEPS, layers: LAYERS }),
      universal: UNIVERSAL,
      tsgoTask: TSGO_TASK,
      testTask: TEST_TASK,
      skew: SKEW_PCT,
      framework: FRAMEWORK,
      versioned: VERSIONED,
      approxFiles: fileCount,
      // apps renamed to dodge bun's truncated-name-hash false duplicate
      // (oven-sh/bun#36386); [] whenever the name universe has no collision
      bunNameHashRenames: [...APP_NAME_REMAP.entries()].map(([i, name]) => ({
        app: appPkgBase(i),
        renamedTo: name,
      })),
      generateMs: Math.round(ms),
    }),
  );
}

main();

#!/usr/bin/env node
// Generates a pnpm + Turborepo workspace of N tiny Next.js apps and M moderate
// libraries with a realistic, layered dependency graph.
//
//   node scripts/generate.mjs --apps 10000 --libs 300 --modules 16 \
//       --app-deps 4 --lib-deps 3 --layers 6 --clean
//
// Design goals:
//   * Apps are TINY (a layout + a page importing a few libs).
//   * Libs are MODERATE (an index plus `modules` small TS modules).
//   * Libs form a LAYERED DAG so build closures are bounded but non-trivial.
//   * Everything is DETERMINISTIC so benchmarks are reproducible.

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

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

const APPS = intOpt("apps", "50", 0); // 0 apps (libs only) is allowed
const LIBS = intOpt("libs", "50", 1); // layer math divides by LIBS/LAYERS
const MODULES = intOpt("modules", "16", 1); // modules per library (index imports mod-01)
const APP_DEPS = intOpt("app-deps", "4", 0); // lib deps per app
const LIB_DEPS = intOpt("lib-deps", "3", 0); // lib->lib deps
const LAYERS = intOpt("layers", "6", 1); // dependency layers (layerSize divides by it)
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
const appPkg = (i) => `@demo/app-${pad(i, appW)}`;

// ---- dependency graph ----------------------------------------------------
const layerSize = Math.ceil(LIBS / LAYERS);
const layerOf = (i) => Math.floor((i - 1) / layerSize); // 0-based layer

// Optional semver mode: stamp real versions and reference internal deps with a
// semver-flavored workspace specifier (`workspace:^1.2.3`). pnpm links the local
// package during dev and rewrites the spec to `^1.2.3` on publish — the
// independently-versioned-internal-packages convention.
const libVersion = (i) => (VERSIONED ? `1.${layerOf(i)}.${i}` : "0.0.0");
const wsSpec = (d) => (VERSIONED ? `workspace:^${libVersion(d)}` : "workspace:*");

// Lib i depends on LIB_DEPS libs from the layer below (deterministic spread),
// so closures are bounded by the number of layers but overlap heavily
// (realistic: many features share a few foundation libs).
function libDeps(i) {
  const layer = layerOf(i);
  if (layer === 0) return [];
  const prevStart = (layer - 1) * layerSize + 1;
  const prevEnd = Math.min(layer * layerSize, LIBS);
  const span = prevEnd - prevStart + 1;
  const deps = new Set();
  for (let k = 0; k < LIB_DEPS && span > 0; k++) {
    const idx = prevStart + ((i * 7 + k * 13) % span);
    deps.add(idx);
  }
  return [...deps].sort((a, b) => a - b);
}

// App i depends on APP_DEPS libs biased toward the top (feature) layers.
function appDeps(i) {
  const deps = new Set();
  for (let k = 0; k < APP_DEPS; k++) {
    const idx = 1 + ((i * 31 + k * 97) % LIBS);
    deps.add(idx);
  }
  return [...deps].sort((a, b) => a - b);
}

// ---- file templates ------------------------------------------------------
function moduleSource(libIdx, modIdx) {
  const tag = `${pad(libIdx, libW)}_${pad(modIdx, 2)}`;
  return `// @demo/lib-${pad(libIdx, libW)} module ${modIdx}
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

export const SEED_${tag} = ${libIdx * 1000 + modIdx};
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
        ? { build: "vite build", dev: "vite", preview: "vite preview", typecheck: "tsc --noEmit" }
        : { build: "next build", dev: "next dev", start: "next start", typecheck: "tsc --noEmit" },
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

function appPageSource(i) {
  const deps = appDeps(i);
  const imports = deps.map((d) => `import { ${libSym(d)} } from "${libPkg(d)}";`).join("\n");
  const sum = deps.map((d, k) => `${libSym(d)}(${k + 1})`).join(" + ");
  return `${imports}

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
  const sum = deps.map((d, k) => `${libSym(d)}(${k + 1})`).join(" + ");
  return `${imports}

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

function writeApp(i) {
  const dir = join(APPS_DIR, appDir(i));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), appPackageJson(i));
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
  const fileCount = LIBS * (MODULES + 3) + APPS * 6;
  console.log(
    JSON.stringify({
      apps: APPS,
      libs: LIBS,
      modulesPerLib: MODULES,
      appDeps: APP_DEPS,
      libDeps: LIB_DEPS,
      layers: LAYERS,
      framework: FRAMEWORK,
      versioned: VERSIONED,
      approxFiles: fileCount,
      generateMs: Math.round(ms),
    }),
  );
}

main();

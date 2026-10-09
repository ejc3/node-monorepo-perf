#!/usr/bin/env node
// Generates ONE large Next.js App Router app: the opposite end of the shape axis
// from the many-tiny-apps workspace. Thousands of routes over a first-party tree of
// feature folders, a shared UI kit behind a barrel, and a shared util layer, so a
// single `next build` must construct a whole-app module graph of tens of thousands
// of modules.
//
//   node scripts/monolith-gen.mjs --out /tmp/monolith --clean
//   node scripts/monolith-gen.mjs --out /tmp/monolith --routes 500 --features 100
//
// Defaults approximate the app described in vercel/next.js#98043 (2,070 routes,
// ~16,000 first-party TS files): --routes 2070 emits that many routes (~81% pages,
// ~19% route handlers) plus the root page, 2,071 in all, over 16,068 TS files.
//
// The tree:
//   app/layout.tsx                         root layout, client providers from @/ui
//   app/(gN)/gNsM/layout.tsx               one layout per section
//   app/(gN)/gNsM/pR[/[id]]/page.tsx       pages; ~30% under a dynamic segment
//   app/(gN)/gNsM/api/pR/route.ts          route handlers
//   instrumentation.ts                     register() importing one util
//   src/lib/uNNN.ts + src/lib/index.ts     pure utils behind a barrel
//   src/ui/cNNN.tsx + src/ui/index.ts      UI kit behind a barrel; half 'use client'
//   src/features/fNNN/mNN.ts(x) + index.ts feature modules: lib, client, server tiers
//
// Import rules (all edges point to lower indices inside a tier, so the graph is a
// DAG): feature lib modules import lower lib modules and utils; client components
// import lib and lower client modules plus UI; server components import any lower
// module, UI through the barrel, and (25%) another feature's index, zipf-weighted
// toward low feature indices (the shared "core" features every app grows). Pages
// import their own feature plus 1-2 zipf picks. Deterministic for a given seed.
//
// The app is standalone (its own package.json, not a workspace member). Install it
// with `pnpm install --ignore-workspace` in --out.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1) {
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
      console.error(`--${name} needs a value`);
      process.exit(1);
    }
    return argv[i + 1];
  }
  return process.env[`MONOLITH_${name.toUpperCase().replace(/-/g, "_")}`] ?? def;
};
const intOpt = (name, def, min, max = Infinity) => {
  const raw = opt(name, def);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`--${name} must be an integer in [${min}, ${max}] (got "${raw}")`);
    process.exit(1);
  }
  return n;
};

const OUT = resolve(opt("out", "monolith"));
// written into monolith.json; --clean deletes only a directory carrying it
const GENERATOR = "node-monorepo-perf scripts/monolith-gen.mjs";
const ROUTES = intOpt("routes", "2070", 1);
const HANDLER_PCT = intOpt("handler-pct", "19", 0, 100); // share of routes that are route.ts
const DYNAMIC_PCT = intOpt("dynamic-pct", "30", 0, 100); // share of pages under [id]
const GROUPS = intOpt("groups", "12", 1); // route groups (gN)
const SECTIONS = intOpt("sections", "16", 1); // sections per group, one layout each
const FEATURES = intOpt("features", "420", 1);
const FEATURE_MODULES = intOpt("feature-modules", "29", 3); // lib + client + server tiers
const UI = intOpt("ui", "700", 3); // the root layout imports C001 and C003
const UTILS = intOpt("utils", "500", 2);
const CROSS_PCT = intOpt("cross-pct", "25", 0, 100); // server modules importing another feature
const SEED = intOpt("seed", "98043", 0);
const NEXT_VERSION = opt("next", "16.4.0");
const REACT_VERSION = opt("react", "19.2.7");

if (existsSync(OUT)) {
  if (!flag("clean")) {
    console.error(`${OUT} exists; pass --clean to replace it`);
    process.exit(1);
  }
  // --clean deletes only a tree this generator wrote (or an empty directory)
  const isGenerated = () => {
    try {
      return JSON.parse(readFileSync(join(OUT, "monolith.json"), "utf8")).generator === GENERATOR;
    } catch {
      return false;
    }
  };
  if (readdirSync(OUT).length && !isGenerated()) {
    console.error(
      `${OUT} is not a generated app (no monolith.json with this generator's signature); refusing to delete it`,
    );
    process.exit(1);
  }
  rmSync(OUT, { recursive: true, force: true });
}

// mulberry32: small, fast, deterministic across node versions
let state = SEED >>> 0;
const rand = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // inclusive
const chance = (pct) => rand() * 100 < pct;
// zipf-ish pick in [1, n]: low indices are much more likely
const zipf = (n) => Math.min(n, 1 + Math.floor(Math.pow(rand(), 2.2) * n));
const pickDistinct = (k, draw) => {
  const s = new Set();
  for (let guard = 0; s.size < k && guard < k * 8; guard++) s.add(draw());
  return [...s];
};

const pad = (n, w) => String(n).padStart(w, "0");
const wU = String(UI).length;
const wL = String(UTILS).length;
const wF = String(FEATURES).length;
const wM = String(FEATURE_MODULES).length;
const ui = (i) => `C${pad(i, wU)}`;
const util = (i) => `u${pad(i, wL)}`;
const feat = (f) => `f${pad(f, wF)}`;
const mod = (m) => `m${pad(m, wM)}`;

let files = 0;
let tsFiles = 0;
function emit(rel, text) {
  if (/\.tsx?$/.test(rel)) tsFiles++;
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  files++;
}

// A function body with real parse/transform work: a type, a constant table, and
// a few small functions. `tag` makes every module's identifiers unique.
function body(tag, n = 3) {
  const rows = Array.from(
    { length: 6 },
    (_, i) => `  { id: ${i}, label: "${tag}-${i}", w: ${randInt(1, 99)} },`,
  );
  const fns = Array.from(
    { length: n },
    (_, i) => `export function ${tag}_fn${i}(input: ${tag}Row[], k = ${randInt(2, 9)}): number {
  let acc = ${randInt(0, 50)};
  for (const r of input) {
    acc = (acc * k + r.w + r.label.length) % ${randInt(1000, 9999)};
    if (r.id % ${randInt(2, 5)} === 0) acc ^= ${randInt(1, 255)};
  }
  return acc;
}`,
  );
  return `export interface ${tag}Row {
  id: number;
  label: string;
  w: number;
}

export const ${tag}_TABLE: ${tag}Row[] = [
${rows.join("\n")}
];

${fns.join("\n\n")}
`;
}

// --- src/lib: utils + barrel ------------------------------------------------
for (let i = 1; i <= UTILS; i++) {
  const deps = i > 3 ? pickDistinct(randInt(0, 2), () => randInt(1, i - 1)) : [];
  const imports = deps.map((d) => `import { ${util(d)}_fn0 } from "./${util(d)}";`).join("\n");
  const use = deps.map((d) => `${util(d)}_fn0(${util(i)}_TABLE)`).join(" + ") || "0";
  emit(
    `src/lib/${util(i)}.ts`,
    `${imports}\n\n${body(util(i))}\nexport const ${util(i)}_score = () => ${use};\n`,
  );
}
emit(
  "src/lib/index.ts",
  Array.from({ length: UTILS }, (_, k) => `export * from "./${util(k + 1)}";`).join("\n") + "\n",
);

// --- src/ui: components + barrel; odd indices are client components ----------
const uiIsClient = (i) => i % 2 === 1;
for (let i = 1; i <= UI; i++) {
  const deps = i > 2 ? pickDistinct(randInt(0, 2), () => randInt(1, i - 1)) : [];
  const u = randInt(1, UTILS);
  const client = uiIsClient(i);
  const imports = [
    ...(client ? [`import { useState } from "react";`] : []),
    `import { ${util(u)}_fn0, ${util(u)}_TABLE } from "../lib/${util(u)}";`,
    ...deps.map((d) => `import { ${ui(d)} } from "./${ui(d)}";`),
  ].join("\n");
  const state = client ? `  const [n, setN] = useState(${randInt(0, 9)});\n` : "  const n = 0;\n";
  const onClick = client ? ` onClick={() => setN(n + 1)}` : "";
  const kids = deps.map((d) => `      <${ui(d)} label={label + "-${d}"} />`).join("\n");
  emit(
    `src/ui/${ui(i)}.tsx`,
    `${client ? '"use client";\n\n' : ""}${imports}

${body(ui(i), 1)}
export function ${ui(i)}({ label, children }: { label: string; children?: React.ReactNode }) {
${state}  const score = ${util(u)}_fn0(${util(u)}_TABLE) + ${ui(i)}_fn0(${ui(i)}_TABLE);
  return (
    <div className="${ui(i).toLowerCase()}" data-score={score}${onClick}>
      <span>{label}:{n}</span>
${kids}
      {children}
    </div>
  );
}
`,
  );
}
emit(
  "src/ui/index.ts",
  Array.from({ length: UI }, (_, k) => `export * from "./${ui(k + 1)}";`).join("\n") + "\n",
);

// --- src/features ---------------------------------------------------------------
// Tiers by module index: [1, LIB_END] lib, (LIB_END, CLIENT_END] client, rest server.
const LIB_END = Math.max(1, Math.round(FEATURE_MODULES * 0.28));
const CLIENT_END = Math.max(LIB_END + 1, Math.round(FEATURE_MODULES * 0.59));
const tierOf = (m) => (m <= LIB_END ? "lib" : m <= CLIENT_END ? "client" : "server");
const compName = (f, m) => `${feat(f).toUpperCase()}${mod(m).toUpperCase()}`;
const featureEntry = (f) => `${feat(f).toUpperCase()}Entry`;
const uiPicks = (k) => pickDistinct(k, () => zipf(UI));

for (let f = 1; f <= FEATURES; f++) {
  const F = feat(f);
  for (let m = 1; m <= FEATURE_MODULES; m++) {
    const tier = tierOf(m);
    const tag = `${F}${mod(m)}`;
    const lines = [];
    if (tier === "lib") {
      const lower = m > 1 ? pickDistinct(randInt(0, 2), () => randInt(1, m - 1)) : [];
      const utils = pickDistinct(randInt(1, 2), () => zipf(UTILS));
      lines.push(...lower.map((d) => `import { ${F}${mod(d)}_fn0 } from "./${mod(d)}";`));
      lines.push(...utils.map((u) => `import { ${util(u)}_fn0 } from "@/lib/${util(u)}";`));
      if (chance(20)) lines.push(`import { ${util(1)}_score } from "@/lib";`);
      const use = [
        ...lower.map((d) => `${F}${mod(d)}_fn0(${tag}_TABLE)`),
        ...utils.map((u) => `${util(u)}_fn0(${tag}_TABLE)`),
      ];
      emit(
        `src/features/${F}/${mod(m)}.ts`,
        `${lines.join("\n")}\n\n${body(tag)}\nexport const ${tag}_value = () => ${use.join(" + ") || "0"};\n`,
      );
      continue;
    }
    // client and server components
    const client = tier === "client";
    const lo = client ? LIB_END + 1 : 1;
    const lowerComp = m - 1 >= lo ? pickDistinct(randInt(1, 3), () => randInt(lo, m - 1)) : [];
    const libDeps = pickDistinct(randInt(1, 2), () => randInt(1, LIB_END));
    const uis = uiPicks(randInt(1, 3));
    if (client) lines.push(`"use client";`, "", `import { useState, useMemo } from "react";`);
    for (const d of lowerComp) {
      if (tierOf(d) === "lib") libDeps.push(d);
      else lines.push(`import { ${compName(f, d)} } from "./${mod(d)}";`);
    }
    const libs = [...new Set(libDeps)];
    lines.push(...libs.map((d) => `import { ${F}${mod(d)}_value } from "./${mod(d)}";`));
    // client components import UI by path; server components go through the barrel
    if (client) lines.push(...uis.map((c) => `import { ${ui(c)} } from "@/ui/${ui(c)}";`));
    else lines.push(`import { ${uis.map(ui).join(", ")} } from "@/ui";`);
    let cross = [];
    if (!client && f > 1 && chance(CROSS_PCT)) {
      cross = pickDistinct(randInt(1, 2), () => zipf(f - 1));
      lines.push(
        ...cross.map((g) => `import { ${featureEntry(g)} } from "@/features/${feat(g)}";`),
      );
    } else if (client && f > 1 && chance(CROSS_PCT / 2)) {
      const g = zipf(f - 1);
      lines.push(`import { ${feat(g)}${mod(1)}_value } from "@/features/${feat(g)}/${mod(1)}";`);
    }
    const kids = [
      ...lowerComp
        .filter((d) => tierOf(d) !== "lib")
        .map((d) => `<${compName(f, d)} id={id + ${d}} />`),
      ...uis.map((c) => `<${ui(c)} label="${tag}" />`),
      ...cross.map((g) => `<${featureEntry(g)} id={id} />`),
    ];
    const calc = libs.map((d) => `${F}${mod(d)}_value()`).join(" + ") || "0";
    const hook = client
      ? `  const [open, setOpen] = useState(false);\n  const v = useMemo(() => ${calc} + ${tag}_fn0(${tag}_TABLE), [open]);\n`
      : `  const v = ${calc} + ${tag}_fn0(${tag}_TABLE);\n`;
    const handler = client ? ` onClick={() => setOpen(!open)}` : "";
    emit(
      `src/features/${F}/${mod(m)}.tsx`,
      `${lines.join("\n")}

${body(tag, 2)}
export function ${compName(f, m)}({ id }: { id: number }) {
${hook}  return (
    <section data-id={id} data-v={v}${handler}>
      <h3>${tag}</h3>
      ${kids.join("\n      ")}
    </section>
  );
}
`,
    );
  }
  // index: the feature's public entry (its top server component) plus its lib API
  const top = FEATURE_MODULES;
  emit(
    `src/features/${F}/index.ts`,
    `export { ${compName(f, top)} as ${featureEntry(f)} } from "./${mod(top)}";
export { ${F}${mod(1)}_value } from "./${mod(1)}";
`,
  );
}

// --- app/ ----------------------------------------------------------------------
emit(
  "app/layout.tsx",
  `import { ${ui(1)}, ${ui(3)} } from "@/ui";

export const metadata = { title: "monolith" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <${ui(1)} label="root">
          <${ui(3)} label="nav" />
          {children}
        </${ui(1)}>
      </body>
    </html>
  );
}
`,
);
emit(
  "app/page.tsx",
  `import { ${featureEntry(1)} } from "@/features/${feat(1)}";

export default function Home() {
  return <${featureEntry(1)} id={0} />;
}
`,
);

const sectionDir = (g, s) => `app/(g${g})/g${g}s${s}`;
const layouts = new Set();
let pages = 1; // app/page.tsx, the root page
let handlers = 0;
for (let r = 1; r <= ROUTES; r++) {
  const g = (r % GROUPS) + 1;
  const s = (Math.floor(r / GROUPS) % SECTIONS) + 1;
  const dir = sectionDir(g, s);
  if (!layouts.has(dir)) {
    layouts.add(dir);
    const lf = ((g * SECTIONS + s) % FEATURES) + 1;
    const nav = randInt(1, UI);
    emit(
      `${dir}/layout.tsx`,
      `import { ${ui(nav)} } from "@/ui";
import { ${featureEntry(lf)} } from "@/features/${feat(lf)}";

export default function SectionLayout({ children }: { children: React.ReactNode }) {
  return (
    <${ui(nav)} label="g${g}s${s}">
      <${featureEntry(lf)} id={${r}} />
      {children}
    </${ui(nav)}>
  );
}
`,
    );
  }
  const own = ((r - 1) % FEATURES) + 1; // every feature is reachable from some route
  if (chance(HANDLER_PCT)) {
    handlers++;
    const u = zipf(UTILS);
    emit(
      `${dir}/api/p${r}/route.ts`,
      `import { ${feat(own)}${mod(1)}_value } from "@/features/${feat(own)}/${mod(1)}";
import { ${util(u)}_fn0, ${util(u)}_TABLE } from "@/lib/${util(u)}";

export async function GET() {
  return Response.json({ route: ${r}, v: ${feat(own)}${mod(1)}_value() + ${util(u)}_fn0(${util(u)}_TABLE) });
}

export async function POST(req: Request) {
  const body = await req.json();
  return Response.json({ route: ${r}, echo: body });
}
`,
    );
    continue;
  }
  pages++;
  const extra = pickDistinct(randInt(1, 2), () => zipf(FEATURES)).filter((x) => x !== own);
  const fs_ = [own, ...extra];
  const dynamic = chance(DYNAMIC_PCT);
  const imports = fs_
    .map((x) => `import { ${featureEntry(x)} } from "@/features/${feat(x)}";`)
    .join("\n");
  const els = fs_.map((x) => `<${featureEntry(x)} id={n} />`).join("\n      ");
  const sig = dynamic
    ? `export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const n = Number((await params).id) || ${r};`
    : `export default function Page() {
  const n = ${r};`;
  emit(
    `${dir}/p${r}/${dynamic ? "[id]/" : ""}page.tsx`,
    `${imports}

export const metadata = { title: "p${r}" };

${sig}
  return (
    <main>
      ${els}
    </main>
  );
}
`,
  );
}

emit(
  "instrumentation.ts",
  `export async function register() {
  const { ${util(1)}_score } = await import("@/lib/${util(1)}");
  ${util(1)}_score();
}
`,
);

// --- project files -------------------------------------------------------------
emit(
  "package.json",
  JSON.stringify(
    {
      name: "@demo/monolith",
      version: "0.0.0",
      private: true,
      scripts: {
        build: "next build",
        "build:compile": "next build --experimental-build-mode=compile",
      },
      dependencies: { next: NEXT_VERSION, react: REACT_VERSION, "react-dom": REACT_VERSION },
      devDependencies: { typescript: "6.0.3", "@types/react": "19.2.17", "@types/node": "^25.0.0" },
    },
    null,
    2,
  ) + "\n",
);
emit(
  "next.config.ts",
  `import type { NextConfig } from "next";

// MONOLITH_DIST_DIR lets parallel builds of one tree write separate outputs;
// MONOLITH_BUILD_ID pins the build id so two builds' outputs can be compared;
// MONOLITH_TP_FS_CACHE=0 turns off Turbopack's persistent cache for the build.
const config: NextConfig = {
  distDir: process.env.MONOLITH_DIST_DIR || ".next",
  generateBuildId: async () => process.env.MONOLITH_BUILD_ID || null,
  typescript: { ignoreBuildErrors: true },
  experimental: { turbopackFileSystemCacheForBuild: process.env.MONOLITH_TP_FS_CACHE !== "0" },
};

export default config;
`,
);
emit(
  "tsconfig.json",
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["dom", "dom.iterable", "esnext"],
        strict: true,
        noEmit: true,
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        skipLibCheck: true,
        isolatedModules: true,
        paths: { "@/*": ["./src/*"] },
        plugins: [{ name: "next" }],
      },
      include: ["**/*.ts", "**/*.tsx"],
      exclude: ["node_modules"],
    },
    null,
    2,
  ) + "\n",
);
emit(".gitignore", "node_modules/\n.next*/\nnext-env.d.ts\n");

// Counts are of the emitted tree: routes = pages (the root page included) + route
// handlers; files excludes this summary; tsFiles counts .ts/.tsx (next.config.ts too).
const summary = {
  generator: GENERATOR,
  out: OUT,
  files,
  tsFiles,
  routes: pages + handlers,
  pages,
  handlers,
  layouts: layouts.size,
  features: FEATURES,
  featureModules: FEATURE_MODULES,
  ui: UI,
  utils: UTILS,
  options: {
    routes: ROUTES,
    handlerPct: HANDLER_PCT,
    dynamicPct: DYNAMIC_PCT,
    groups: GROUPS,
    sections: SECTIONS,
    crossPct: CROSS_PCT,
  },
  seed: SEED,
  next: NEXT_VERSION,
  react: REACT_VERSION,
};
writeFileSync(join(OUT, "monolith.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));

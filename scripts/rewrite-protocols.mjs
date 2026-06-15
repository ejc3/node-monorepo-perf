#!/usr/bin/env node
// Materializes pnpm-only dependency protocols (`catalog:`, `workspace:*`) into
// concrete versions so an artifact can be consumed by tools that don't speak
// them (Vercel's framework detector, `npm publish`, AWS CodeArtifact, etc.).
//
//   node scripts/rewrite-protocols.mjs --dir out [--unprivate]
//
// Reads the catalog from ./pnpm-workspace.yaml (or --catalog <path>).

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

const DIR = opt("dir", "out");
const CATALOG_PATH = opt("catalog", "pnpm-workspace.yaml");
const UNPRIVATE = flag("unprivate");

// crude catalog parse (key: value under a `catalog:` block)
const ws = readFileSync(CATALOG_PATH, "utf8").split("\n");
const catalog = {};
let inCatalog = false;
for (const line of ws) {
  if (/^catalog:\s*$/.test(line)) {
    inCatalog = true;
    continue;
  }
  if (inCatalog) {
    if (/^\s*#/.test(line) || !line.trim()) continue; // skip comments / blank lines
    const m = line.match(/^\s+["']?([^"':]+)["']?:\s*(.+?)\s*$/);
    if (m && /^\s/.test(line)) catalog[m[1]] = m[2].replace(/^["']|["']$/g, "");
    else if (line.trim() && !/^\s/.test(line)) inCatalog = false;
  }
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git" || e === ".next" || e === "dist") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (e === "package.json") acc.push(p);
  }
  return acc;
}

let changed = 0;
for (const file of walk(DIR)) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  let touched = false;
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string") continue;
      if (spec === "catalog:" || spec.startsWith("catalog:")) {
        if (catalog[name]) {
          deps[name] = catalog[name];
          touched = true;
        } else throw new Error(`no catalog entry for ${name} (in ${file})`);
      }
    }
  }
  if (UNPRIVATE && pkg.private) {
    delete pkg.private;
    touched = true;
  }
  if (touched) {
    writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
    changed++;
  }
}
console.log(
  JSON.stringify({
    dir: DIR,
    catalogKeys: Object.keys(catalog),
    packagesRewritten: changed,
    unprivate: UNPRIVATE,
  }),
);

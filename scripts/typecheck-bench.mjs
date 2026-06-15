#!/usr/bin/env node
// Controlled tsc vs tsgo (TypeScript native port) benchmark on a single large
// program (the case tsgo targets). Generates N cross-referencing modules and
// times `--noEmit` for each checker.
//
//   node scripts/typecheck-bench.mjs 3000

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const N = parseInt(process.argv[2] || "3000", 10);
const ROOT = process.cwd();
const DIR = join(ROOT, "bench", "tc");
rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, "src"), { recursive: true });

for (let i = 0; i < N; i++) {
  const imports = [];
  for (let k = 1; k <= 3; k++) { const j = i - k; if (j >= 0) imports.push(j); }
  const importLines = imports.map((j) => `import { v${j}, type T${j} } from "./m${j}.js";`).join("\n");
  const useSum = imports.map((j) => `v${j}`).join(" + ") || "0";
  const depsArr = imports.join(", ");
  writeFileSync(join(DIR, "src", `m${i}.ts`),
`${importLines}
export interface T${i} { id: number; tag: string; deps: readonly number[]; }
export function make${i}(id: number): T${i} { return { id, tag: "m${i}", deps: [${depsArr}] }; }
export function fold${i}(xs: readonly T${i}[]): number { return xs.reduce((a, b) => a + b.id, 0) + ${useSum}; }
export const v${i}: number = ${i} + ${useSum};
`);
}
writeFileSync(join(DIR, "tsconfig.json"), JSON.stringify({
  compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "nodenext", strict: true, noEmit: true, skipLibCheck: true },
  include: ["src"],
}, null, 2));

const tsc = join(ROOT, "node_modules", ".bin", "tsc");
const tsgo = join(ROOT, "node_modules", ".bin", "tsgo");
const cfg = join(DIR, "tsconfig.json");
const run = (bin) => { const t = process.hrtime.bigint(); execSync(`${bin} --noEmit -p ${cfg}`, { stdio: "pipe" }); return Math.round(Number(process.hrtime.bigint() - t) / 1e6); };

const out = { modules: N, tscMs: run(tsc), tsgoMs: existsSync(tsgo) ? run(tsgo) : null };
out.speedup = out.tsgoMs ? +(out.tscMs / out.tsgoMs).toFixed(2) : null;
mkdirSync(join(ROOT, "bench"), { recursive: true });
writeFileSync(join(ROOT, "bench", "typecheck-bench.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));

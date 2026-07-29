#!/usr/bin/env node
// The one-command whole-workspace type check — the pre-push gate for anyone
// editing a lib that many packages import (at the extreme, a universal
// foundation lib, where every app must re-check and there is nothing for
// `--filter` to scope away; FLEET.md).
//
//   make typecheck-whole        (or: node scripts/whole-typecheck.mjs)
//
// One tsgo process reads every app and lib FROM SOURCE (`@demo/*` resolves to
// `packages/*/src`, so no per-lib dist builds are needed) and prints a plain
// verdict: GREEN, or RED with an error digest (count, top error codes, how
// many apps/libs are affected, first sample lines). Exits with tsgo's exit
// code, so it works unchanged as a CI or pre-push gate. Measured on the
// 30,000-app fleet shape: ~1 minute; the clean run records ~51GB peak RSS
// (bench/fleet-gate-bench.json); the same check as optimal-gate-bench's
// "optimal gate" row, packaged as a day-to-day command.
//
// Non-destructive: (re)writes only the derived, gitignored tsconfig.whole.json.
// Needs a generated workspace and an installed node_modules with tsgo.

import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TSGO = join(ROOT, "node_modules", ".bin", "tsgo");
for (const [what, path] of [
  ["a generated workspace (run `make gen` / `make gen-fleet` first)", join(ROOT, "apps")],
  ["an installed node_modules with tsgo (run an install first)", TSGO],
]) {
  if (!existsSync(path)) {
    console.error(`missing ${what}: ${path}`);
    process.exit(1);
  }
}

// Derived on every run so it always matches the checked-in base config; the
// same program shape the fleet gate measures (optimal-gate-bench.mjs).
writeFileSync(
  join(ROOT, "tsconfig.whole.json"),
  JSON.stringify(
    {
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
  ) + "\n",
);

const t0 = process.hrtime.bigint();
let out = "";
let code = 0;
try {
  out = execFileSync(TSGO, ["--noEmit", "-p", "tsconfig.whole.json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 30, // a full fleet-scale breaking run prints ~30k error lines
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  // Node reports a maxBuffer overflow by killing the child (SIGTERM) with
  // code ENOBUFS — that is our buffer, not a tsgo crash; say so instead of
  // "tsgo was killed", and treat it as a tooling fault either way.
  if (e.code === "ENOBUFS") {
    console.error("tsgo output exceeded the capture buffer — raise maxBuffer; not a type verdict");
    process.exit(1);
  }
  // a signal-killed checker is a tooling fault, not a type verdict
  if (e.signal || (e.status != null && e.status >= 128)) {
    console.error(`tsgo was killed (${e.signal ?? `exit ${e.status}`}) — not a type verdict`);
    process.exit(1);
  }
  out = (e.stdout || "") + (e.stderr || "");
  code = e.status ?? 1;
}
const secs = (Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1);

if (code === 0) {
  console.log(`GREEN — whole workspace type-checks clean in ${secs}s`);
  process.exit(0);
}

const errLines = out.split("\n").filter((l) => /error TS\d+/.test(l));
// a non-zero exit with NO TS diagnostics is a tooling fault (panic, loader
// failure), not a type verdict — surface the output instead of "RED — 0 errors"
if (errLines.length === 0) {
  console.error(`tsgo exited ${code} with no TS diagnostics — tooling fault, not a type verdict:`);
  console.error(out.trim().split("\n").slice(-10).join("\n"));
  process.exit(1);
}
const codes = {};
for (const l of errLines) {
  const c = l.match(/error (TS\d+)/)[1];
  codes[c] = (codes[c] || 0) + 1;
}
const topCodes = Object.entries(codes)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([c, n]) => `${c}×${n}`)
  .join("  ");
const apps = new Set(out.match(/apps\/(app-[\w-]+)\//g) || []).size;
const libs = new Set(out.match(/packages\/(lib-[\w-]+)\//g) || []).size;

console.log(`RED — ${errLines.length} type errors in ${secs}s`);
console.log(`  affected: ${apps} apps, ${libs} libs`);
console.log(`  top codes: ${topCodes}`);
console.log(`  first errors:`);
for (const l of errLines.slice(0, 5)) console.log(`    ${l.trim()}`);
if (errLines.length > 5) console.log(`    … ${errLines.length - 5} more`);
process.exit(code);

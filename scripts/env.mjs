#!/usr/bin/env node
// Capture the full benchmark environment for reproducibility. Rigorous
// benchmarks report the system config (CPU, RAM, OS, tool versions), not just
// ratios. Writes bench/env.json and prints it.

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { cpus, totalmem, platform, release, arch, homedir } from "node:os";
import { join } from "node:path";
import { tsNativeShim, ts6Tsc, ts6Tsserver } from "./_ts.mjs";

const sh = (c) => {
  try {
    return execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};
const cpuModel = (() => {
  const m = sh("lscpu | grep -i 'model name'");
  if (m) return m.split(":").slice(1).join(":").trim();
  return cpus()[0]?.model?.trim() || "unknown";
})();

const env = {
  cpuModel,
  cores: cpus().length,
  arch: arch(),
  memGB: Math.round(totalmem() / 1e9),
  os: `${platform()} ${release()}`,
  node: process.version,
  pnpm: sh("pnpm --version"),
  bun: sh(`${join(homedir(), ".bun/bin/bun")} --version`),
  turbo: sh("pnpm exec turbo --version 2>/dev/null") || sh("./node_modules/.bin/turbo --version"),
  // Direct paths (never .bin — .bin/tsc is a ts7/ts6 collision): tsc7 is the
  // native TypeScript compiler shipped as typescript@7 (formerly tsgo); tsc6
  // is the last JS release (the typescript6 alias), which also provides the
  // tsserver the editor benches anchor against.
  tsc7: sh(`node ${tsNativeShim(process.cwd())} --version`),
  tsc6: sh(`node ${ts6Tsc(process.cwd())} --version`),
  tsserver: `${ts6Tsserver(process.cwd()).replace(process.cwd() + "/", "")} (typescript6 alias; typescript@7 ships no tsserver)`,
  governor: sh("cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor") || "unknown",
};

mkdirSync("bench", { recursive: true });
writeFileSync("bench/env.json", JSON.stringify(env, null, 2));
console.log(JSON.stringify(env, null, 2));

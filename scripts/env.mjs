#!/usr/bin/env node
// Capture the full benchmark environment for reproducibility. Rigorous
// benchmarks report the system config (CPU, RAM, OS, tool versions), not just
// ratios. Writes bench/env.json and prints it.

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { cpus, totalmem, platform, release, arch, homedir } from "node:os";
import { join } from "node:path";

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
  tsc: sh("./node_modules/.bin/tsc --version"),
  tsgo: sh("./node_modules/.bin/tsgo --version"),
  governor: sh("cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor") || "unknown",
};

mkdirSync("bench", { recursive: true });
writeFileSync("bench/env.json", JSON.stringify(env, null, 2));
console.log(JSON.stringify(env, null, 2));

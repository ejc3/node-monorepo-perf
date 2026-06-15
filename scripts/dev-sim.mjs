#!/usr/bin/env node
// Simulate practical day-to-day development: D developers, each owning distinct
// apps, working independently. Measures what a dev actually pays, scoped with
// `turbo --filter` (turbo's content-hash cache reruns only what changed — the
// same set `--affected` selects from a git diff in CI).
//
//   node scripts/dev-sim.mjs --apps 1000 --libs 200 --devs 5 --rounds 2
//
// NOTE: Turbo's input hashing respects .gitignore, and this repo gitignores the
// GENERATED apps/+packages/. A real monorepo tracks its source, so we move
// .gitignore aside for the run (restored in finally) — otherwise Turbo can't see
// edits and every rebuild is a false cache hit.
//
// Reports:
//   onboarding   - first build of a dev's app closure (O(closure), once)
//   daily loop   - edit your app -> scoped typecheck+build (deps cached) -> ran ~= your app
//   blast radius - editing a shared lib forces its dependents to rebuild (O(dependents))

import { execSync } from "node:child_process";
import { appendFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const APPS = +opt("apps", "1000"), LIBS = +opt("libs", "200");
const DEVS = +opt("devs", "5"), ROUNDS = +opt("rounds", "2");
const ROOT = process.cwd();
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", TURBO_TELEMETRY_DISABLED: "1" };

const appW = String(APPS).length, libW = String(LIBS).length;
const pad = (n, w) => String(n).padStart(w, "0");
const appPkg = (i) => `@demo/app-${pad(i, appW)}`;
const libPkg = (i) => `@demo/lib-${pad(i, libW)}`;
const appPage = (i) => join(ROOT, "apps", `app-${pad(i, appW)}`, "app", "page.tsx");

function run(cmd) { const t0 = process.hrtime.bigint(); const out = execSync(cmd, { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 }); return { ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), out }; }
function tryRun(cmd) { try { return run(cmd); } catch (e) { return { ms: 0, out: (e.stdout || "") + (e.stderr || "") }; } }
function parse(out) {
  const tasks = out.match(/Tasks:\s+(\d+) successful, (\d+) total/);
  const cached = out.match(/Cached:\s+(\d+) cached/);
  const total = tasks ? +tasks[2] : null;
  const c = cached ? +cached[1] : 0;
  return { total, cached: c, ran: total != null ? total - c : null };
}
const turbo = (filter, tasks = "build typecheck") => `pnpm exec turbo run ${tasks} --filter=${filter} --concurrency=100% --output-logs=errors-only`;
const dryCount = (filter) => { const j = JSON.parse(tryRun(`pnpm exec turbo run build --filter=${filter} --dry=json`).out || "{}"); return j.packages?.length ?? null; };

console.log(`# dev simulation: ${APPS} apps / ${LIBS} libs, ${DEVS} devs, ${ROUNDS} rounds`);
console.log("setup: generate + install (one-time, O(repo))");
run(`node scripts/generate.mjs --apps ${APPS} --libs ${LIBS} --modules 16 --clean`);
run(`pnpm install --config.confirm-modules-purge=false`);
execSync("rm -rf .turbo node_modules/.cache/turbo", { cwd: ROOT });

// Move .gitignore aside so Turbo's input hashing sees the generated source
// (simulating a real, source-tracked monorepo). Restored in finally and on signals.
const giPath = join(ROOT, ".gitignore");
const giBak = join(ROOT, ".gitignore.devsim.bak");
if (!existsSync(giPath) && existsSync(giBak)) renameSync(giBak, giPath); // self-heal a prior interrupted run
const hadGi = existsSync(giPath);
const restoreGi = () => { try { if (existsSync(giBak)) renameSync(giBak, giPath); } catch {} };
if (hadGi) renameSync(giPath, giBak);
process.on("SIGINT", () => { restoreGi(); process.exit(130); });
process.on("SIGTERM", () => { restoreGi(); process.exit(143); });

const devApps = Array.from({ length: DEVS }, (_, d) => 1 + Math.floor(((d + 0.5) / DEVS) * APPS));
const result = { apps: APPS, libs: LIBS, devs: DEVS, rounds: ROUNDS, onboarding: [], dailyLoop: [], blast: [] };

try {
  console.log("\n## onboarding: each dev's first build of their app closure");
  for (let d = 0; d < DEVS; d++) {
    const i = devApps[d];
    const r = run(turbo(appPkg(i)));
    const p = parse(r.out);
    result.onboarding.push({ dev: d + 1, app: appPkg(i), ms: r.ms, ran: p.ran, total: p.total, cached: p.cached });
    console.log(`  dev${d + 1} ${appPkg(i)}: ${r.ms}ms  ran ${p.ran}/${p.total} (cached ${p.cached})`);
  }

  console.log("\n## daily loop: each dev edits their app, reruns scoped typecheck+build");
  for (let round = 1; round <= ROUNDS; round++) {
    for (let d = 0; d < DEVS; d++) {
      const i = devApps[d];
      appendFileSync(appPage(i), `\n// dev${d + 1} edit round ${round}\n`);
      const r = run(turbo(appPkg(i)));
      const p = parse(r.out);
      result.dailyLoop.push({ dev: d + 1, app: appPkg(i), round, ms: r.ms, ran: p.ran, total: p.total });
      console.log(`  round${round} dev${d + 1} ${appPkg(i)}: ${r.ms}ms  ran ${p.ran}/${p.total}`);
    }
  }

  console.log("\n## blast radius: editing a shared lib (dependents must rebuild)");
  for (const li of [3, Math.max(1, LIBS - 3)]) { // low layer = many dependents, high layer = few
    const dependents = dryCount(`...${libPkg(li)}`);
    result.blast.push({ lib: libPkg(li), dependentsClosure: dependents });
    console.log(`  edit ${libPkg(li)} -> ${dependents} packages would rebuild (lib + dependents)`);
  }

  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  result.summary = {
    onboardingMedianMs: med(result.onboarding.map((o) => o.ms)),
    dailyLoopMedianMs: med(result.dailyLoop.map((o) => o.ms)),
    dailyLoopMedianRan: med(result.dailyLoop.map((o) => o.ran)),
    totalPackages: APPS + LIBS,
  };
  mkdirSync(join(ROOT, "bench"), { recursive: true });
  writeFileSync(join(ROOT, "bench", "dev-sim.json"), JSON.stringify(result, null, 2));
  console.log(`\n## summary`);
  console.log(`  onboarding median: ${result.summary.onboardingMedianMs}ms (first app-closure build)`);
  console.log(`  daily loop median: ${result.summary.dailyLoopMedianMs}ms, ran ${result.summary.dailyLoopMedianRan} tasks (repo has ${result.summary.totalPackages} packages)`);
  console.log(`  -> daily cost tracks the edited closure, not the ${result.summary.totalPackages}-package repo`);
  console.log("--- bench/dev-sim.json written ---");
} finally {
  restoreGi();
}

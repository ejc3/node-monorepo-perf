#!/usr/bin/env node
// Realistic day-to-day developer simulation. D developers each own a small
// feature area (2 apps + 1 lib) and work independently. After a one-time
// onboarding, it measures the operations a dev actually runs, scoped with
// `turbo --filter` (the same set `--affected` selects from a git diff in CI):
//
//   typecheck-on-save   edit an app -> `turbo run typecheck --filter=<app>`   (the constant fast loop)
//   build-before-push   edit an app -> `turbo run build --filter=<app>...`    (heavier, pre-push/CI)
//   lib-edit            edit your lib -> `turbo run build --filter=...<lib>`  (rebuild the lib + its dependents)
//   independence        another dev rebuilds after your unrelated edit        (must be a full cache hit)
//   blast spectrum      dry-run dependent counts for a low- vs high-layer lib
//
//   node scripts/dev-sim.mjs --apps 1000 --libs 200 --devs 4
//
// Turbo's input hashing respects .gitignore and the generated workspace is
// gitignored, so the sim moves .gitignore aside for the run (real monorepos
// track their source). Restored in finally and on signals.

import { execSync } from "node:child_process";
import { appendFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const APPS = +opt("apps", "1000"),
  LIBS = +opt("libs", "200"),
  DEVS = +opt("devs", "4");
if (!(Number.isInteger(DEVS) && DEVS >= 2)) {
  console.error(
    `--devs must be an integer >= 2 (the sim measures independent developers); got "${opt("devs", "4")}"`,
  );
  process.exit(1);
}
const ROOT = process.cwd();
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", TURBO_TELEMETRY_DISABLED: "1" };

const appW = String(APPS).length,
  libW = String(LIBS).length;
const pad = (n, w) => String(n).padStart(w, "0");
const appPkg = (i) => `@demo/app-${pad(i, appW)}`;
const libPkg = (i) => `@demo/lib-${pad(i, libW)}`;
const appPage = (i) => join(ROOT, "apps", `app-${pad(i, appW)}`, "app", "page.tsx");
const libSrc = (i) => join(ROOT, "packages", `lib-${pad(i, libW)}`, "src", "index.ts");

function run(cmd) {
  const t0 = process.hrtime.bigint();
  execSync(cmd, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
  return Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
}
function runParse(cmd) {
  let out = "";
  const t0 = process.hrtime.bigint();
  try {
    out = execSync(cmd, {
      cwd: ROOT,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    throw new Error(
      `turbo failed (a dev-loop edit must build cleanly): ${cmd}\n${((e.stdout || "") + (e.stderr || "")).slice(-1500)}`,
    );
  }
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  // turbo succeeded; if we can't read its summary, that's a parse failure to
  // surface, not a measurement to silently record as null.
  const t = out.match(/Tasks:\s+(\d+) successful, (\d+) total/);
  if (!t)
    throw new Error(
      `could not parse turbo summary (no "Tasks:" line) from: ${cmd}\n${out.slice(-1500)}`,
    );
  const c = out.match(/Cached:\s+(\d+) cached/);
  const total = +t[2];
  const cached = c ? +c[1] : 0;
  return { ms, total, ran: total - cached };
}
const tc = (f) =>
  `pnpm exec turbo run typecheck --filter=${f} --concurrency=100% --output-logs=errors-only`;
const build = (f) =>
  `pnpm exec turbo run build --filter=${f} --concurrency=100% --output-logs=errors-only`;
const dryCount = (f) => {
  let out;
  try {
    out = execSync(`pnpm exec turbo run build --filter=${f} --dry=json`, {
      cwd: ROOT,
      env,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
  } catch (e) {
    throw new Error(
      `dry-run dependent count failed for ${f}: ${((e.stdout || "") + (e.stderr || "")).slice(-800)}`,
    );
  }
  const pkgs = JSON.parse(out).packages;
  if (!Array.isArray(pkgs))
    throw new Error(`turbo --dry=json for ${f} returned no packages[] array`);
  return pkgs.length;
};

// each dev owns 2 apps (spread) + 1 top-layer lib (few dependents, so lib-edit is measurable)
const devs = Array.from({ length: DEVS }, (_, d) => ({
  id: d + 1,
  apps: [1 + Math.floor(((d + 0.25) / DEVS) * APPS), 1 + Math.floor(((d + 0.75) / DEVS) * APPS)],
  lib: Math.max(1, LIBS - d * 2),
}));

console.log(
  `# realistic dev simulation: ${APPS} apps / ${LIBS} libs, ${DEVS} devs (2 apps + 1 lib each)`,
);
run(`node scripts/generate.mjs --apps ${APPS} --libs ${LIBS} --modules 16 --clean`);
run(`pnpm install --config.confirm-modules-purge=false`);
execSync("rm -rf .turbo node_modules/.cache/turbo", { cwd: ROOT });

const giPath = join(ROOT, ".gitignore"),
  giBak = join(ROOT, ".gitignore.devsim.bak");
if (!existsSync(giPath) && existsSync(giBak)) renameSync(giBak, giPath);
const hadGi = existsSync(giPath);
const restoreGi = () => {
  try {
    if (existsSync(giBak)) renameSync(giBak, giPath);
  } catch {}
};
if (hadGi) renameSync(giPath, giBak);
process.on("SIGINT", () => {
  restoreGi();
  process.exit(130);
});
process.on("SIGTERM", () => {
  restoreGi();
  process.exit(143);
});

const result = {
  apps: APPS,
  libs: LIBS,
  devs: DEVS,
  onboarding: [],
  typecheckOnSave: [],
  buildBeforePush: [],
  libEdit: [],
  independence: null,
  blast: [],
};
try {
  console.log("\n## onboarding: each dev builds their feature area (apps + closure)");
  for (const dev of devs) {
    const filter = dev.apps.map((a) => `--filter=${appPkg(a)}...`).join(" ");
    const r = runParse(
      `pnpm exec turbo run build typecheck ${filter} --concurrency=100% --output-logs=errors-only`,
    );
    result.onboarding.push({
      dev: dev.id,
      apps: dev.apps.map(appPkg),
      ms: r.ms,
      ran: r.ran,
      total: r.total,
    });
    console.log(
      `  dev${dev.id} ${dev.apps.map(appPkg).join(",")}: ${r.ms}ms ran ${r.ran}/${r.total}`,
    );
  }

  console.log("\n## typecheck-on-save (edit an app, typecheck it)");
  for (const dev of devs) {
    appendFileSync(appPage(dev.apps[0]), `\n// dev${dev.id} save\n`);
    const r = runParse(tc(appPkg(dev.apps[0])));
    result.typecheckOnSave.push({ dev: dev.id, app: appPkg(dev.apps[0]), ms: r.ms, ran: r.ran });
    console.log(`  dev${dev.id} ${appPkg(dev.apps[0])}: ${r.ms}ms ran ${r.ran}`);
  }

  console.log("\n## build-before-push (edit an app, build it + closure)");
  for (const dev of devs) {
    appendFileSync(appPage(dev.apps[1]), `\n// dev${dev.id} prepush\n`);
    const r = runParse(build(`${appPkg(dev.apps[1])}...`));
    result.buildBeforePush.push({ dev: dev.id, app: appPkg(dev.apps[1]), ms: r.ms, ran: r.ran });
    console.log(`  dev${dev.id} ${appPkg(dev.apps[1])}: ${r.ms}ms ran ${r.ran}`);
  }

  console.log("\n## lib-edit (edit your owned lib, rebuild lib + dependents)");
  for (const dev of devs) {
    const deps = dryCount(`...${libPkg(dev.lib)}`);
    appendFileSync(libSrc(dev.lib), `\nexport const _dev${dev.id} = ${dev.id};\n`);
    const r = runParse(build(`...${libPkg(dev.lib)}`));
    result.libEdit.push({
      dev: dev.id,
      lib: libPkg(dev.lib),
      dependents: deps,
      ms: r.ms,
      ran: r.ran,
    });
    console.log(`  dev${dev.id} ${libPkg(dev.lib)} (${deps} dependents): ${r.ms}ms ran ${r.ran}`);
  }

  console.log(
    "\n## independence: after one dev edits their area, another dev's rebuild is a full cache hit",
  );
  // Independence = dev1's unrelated edit must add ZERO rebuilds to dev2's closure.
  // `next build` is not cache-stable under turbo's input hashing (with .gitignore
  // moved aside, its emitted files re-enter the hash), so dev2's own app re-runs on
  // EVERY build regardless of upstream changes. So measure a baseline rebuild first,
  // then the rebuild after dev1's edit; isolation is the delta being 0 — dev1 adds
  // nothing beyond dev2's own (non-cacheable) app build.
  const me = devs[1],
    other = devs[0];
  const myApp = appPkg(me.apps[0]);
  runParse(build(`${myApp}...`)); // warm dev2's closure
  const baseline = runParse(build(`${myApp}...`)); // rebuild with NO upstream edit
  appendFileSync(
    appPage(other.apps[0]),
    `\n// dev${other.id} unrelated edit (independence probe)\n`,
  );
  const after = runParse(build(`${myApp}...`)); // rebuild after dev1's edit
  const addedByOther = after.ran - baseline.ran;
  result.independence = {
    editedBy: other.id,
    dev: me.id,
    app: myApp,
    baselineRan: baseline.ran,
    afterRan: after.ran,
    addedByOther,
    total: after.total,
  };
  console.log(
    `  dev${me.id} ${myApp}: baseline ran ${baseline.ran}, after dev${other.id}'s edit ran ${after.ran} -> dev${other.id} added ${addedByOther} (0 = fully isolated)`,
  );

  console.log("\n## blast spectrum (dry-run dependent counts)");
  for (const li of [3, Math.max(1, LIBS - 3)]) {
    const deps = dryCount(`...${libPkg(li)}`);
    result.blast.push({ lib: libPkg(li), dependentsClosure: deps });
    console.log(`  ${libPkg(li)} -> ${deps} packages would rebuild`);
  }

  const med = (xs) => {
    const s = xs.filter((x) => x != null).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : null;
  };
  result.summary = {
    onboardingMedianMs: med(result.onboarding.map((o) => o.ms)),
    typecheckOnSaveMedianMs: med(result.typecheckOnSave.map((o) => o.ms)),
    buildBeforePushMedianMs: med(result.buildBeforePush.map((o) => o.ms)),
    libEditMedianMs: med(result.libEdit.map((o) => o.ms)),
    independenceAddedByOther: result.independence.addedByOther,
    totalPackages: APPS + LIBS,
  };
  mkdirSync(join(ROOT, "bench"), { recursive: true });
  writeFileSync(join(ROOT, "bench/dev-sim.json"), JSON.stringify(result, null, 2));
  console.log(`\n## summary (repo has ${result.summary.totalPackages} packages)`);
  console.log(
    `  typecheck-on-save median ${result.summary.typecheckOnSaveMedianMs}ms · build-before-push median ${result.summary.buildBeforePushMedianMs}ms · lib-edit median ${result.summary.libEditMedianMs}ms`,
  );
  console.log(
    `  independence: dev${result.independence.editedBy}'s unrelated edit added ${result.summary.independenceAddedByOther} rebuilds to another dev's closure (0 = isolated)`,
  );
  console.log("--- bench/dev-sim.json written ---");
} finally {
  restoreGi();
}

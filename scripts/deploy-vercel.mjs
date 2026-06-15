#!/usr/bin/env node
// Reproducible "deploy ONE app out of the monorepo to Vercel" procedure.
// Encodes everything learned the hard way:
//   1. turbo prune the app  (but bypass .gitignore — prune respects it, and our
//      generated apps/ + packages/ are gitignored, so prune would skip them)
//   2. materialize catalog:/workspace: protocols Vercel's detector can't read
//   3. copy root configs prune doesn't (tsconfig.base.json)
//   4. configure the project for a MONOREPO CLOUD BUILD (Root Directory + install
//      and build at the repo root via turbo) — the Vercel-recommended path, NOT
//      --prebuilt (which sandboxes to the project dir and can't see ../../packages)
//   5. deploy, timed, and record the result to bench/deploy.json
//
//   node scripts/deploy-vercel.mjs --app @demo/app-10 \
//     --project nextjs-monorepo-scale-demo --scope ejc3-7031s-projects --prod

import { execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

const APP = opt("app", "@demo/app-10");
const PROJECT = opt("project", "nextjs-monorepo-scale-demo");
const SCOPE = opt("scope", "ejc3-7031s-projects");
const PROD = flag("prod");
const ROOT = process.cwd();
const OUT = join(ROOT, "out");

// Resolve the on-disk app directory by scanning apps/* and matching each
// package.json "name" to APP. Generated app dirs are zero-padded to the app
// count (e.g. apps/app-010 at 200 apps), so we can't derive the dir name from
// APP by string-splitting — we must read the manifests to find the real dir.
const appsRoot = join(ROOT, "apps");
if (!existsSync(appsRoot)) throw new Error(`no apps/ directory at ${appsRoot}`);
const appShort = readdirSync(appsRoot).find((dir) => {
  const pkgPath = join(appsRoot, dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).name === APP;
  } catch {
    return false;
  }
});
if (!appShort) throw new Error(`no apps/*/package.json with name "${APP}" found under ${appsRoot}`);
const appDir = `apps/${appShort}`; // e.g. apps/app-010 (Root Directory)
const authPath = join(homedir(), ".local/share/com.vercel.cli/auth.json");
const TOKEN =
  process.env.VERCEL_TOKEN ||
  (existsSync(authPath) ? JSON.parse(readFileSync(authPath, "utf8")).token : null);
if (!TOKEN)
  throw new Error(
    `no Vercel token: set VERCEL_TOKEN or run \`vercel login\` so ${authPath} exists`,
  );

const sh = (cmd, cwd = ROOT) =>
  execSync(cmd, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 30,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", VERCEL_TELEMETRY_DISABLED: "1" },
  }).toString();

console.log(
  `▶ prune ${APP} → out/ (--use-gitignore=false so generated, gitignored source is copied)`,
);
rmSync(OUT, { recursive: true, force: true });
// turbo prune respects .gitignore by default; our generated apps/+packages/ are
// gitignored, so without this flag prune copies manifests but skips the source.
// --use-gitignore=false also unignores build outputs, so strip a prior local
// build's .next/dist first — otherwise prune sweeps them into the deploy artifact.
sh(
  `find apps packages -mindepth 2 -maxdepth 2 -type d \\( -name .next -o -name dist \\) -exec rm -rf {} + || true`,
);
sh(`pnpm exec turbo prune ${APP} --use-gitignore=false`);

console.log("▶ materialize catalog:/workspace: protocols in the artifact");
sh(`node scripts/rewrite-protocols.mjs --dir out`);

console.log("▶ copy root configs that prune omits (tsconfig.base.json)");
cpSync(join(ROOT, "tsconfig.base.json"), join(OUT, "tsconfig.base.json"));
rmSync(join(OUT, ".gitignore"), { force: true });
writeFileSync(join(OUT, ".vercelignore"), "node_modules\n.turbo\ndist\n.next\n");

console.log(`▶ link out/ to project ${PROJECT} (scope ${SCOPE})`);
mkdirSync(join(OUT, ".vercel"), { recursive: true });
const linkedPath = join(ROOT, appDir, ".vercel", "project.json");
let projectId, orgId;
if (existsSync(linkedPath)) {
  const p = JSON.parse(readFileSync(linkedPath, "utf8"));
  ({ projectId, orgId } = p);
} else {
  sh(`vercel link --yes --project ${PROJECT} --scope ${SCOPE}`, OUT);
  const p = JSON.parse(readFileSync(join(OUT, ".vercel", "project.json"), "utf8"));
  ({ projectId, orgId } = p);
}
writeFileSync(
  join(OUT, ".vercel", "project.json"),
  JSON.stringify({ projectId, orgId, projectName: PROJECT }, null, 2),
);
// persist link in the app dir so subsequent runs reuse it (OUT is recreated each run)
mkdirSync(join(ROOT, appDir, ".vercel"), { recursive: true });
writeFileSync(linkedPath, JSON.stringify({ projectId, orgId, projectName: PROJECT }, null, 2));

console.log(
  "▶ configure project for monorepo cloud build (Root Directory + repo-root install/build)",
);
const settings = {
  rootDirectory: appDir,
  framework: "nextjs",
  buildCommand: `cd ../.. && pnpm exec turbo run build --filter=${APP}`,
  installCommand: "cd ../.. && pnpm install --no-frozen-lockfile",
};
const res = await fetch(`https://api.vercel.com/v9/projects/${projectId}?teamId=${orgId}`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(settings),
});
if (!res.ok) throw new Error(`project PATCH failed: ${res.status} ${await res.text()}`);

console.log(`▶ deploy${PROD ? " --prod" : ""} (timed)`);
const t0 = process.hrtime.bigint();
const out = execSync(`vercel deploy ${PROD ? "--prod " : ""}--yes --scope ${SCOPE}`, {
  cwd: OUT,
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 1 << 30,
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", VERCEL_TELEMETRY_DISABLED: "1" },
}).toString();
const wallMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
const wallSeconds = +(wallMs / 1000).toFixed(1);
const url = (out.match(/https:\/\/[^\s]+\.vercel\.app/g) || []).pop();
if (!url) {
  console.error(out);
  throw new Error("deploy produced no .vercel.app URL");
}

const record = {
  app: APP,
  project: PROJECT,
  scope: SCOPE,
  prod: PROD,
  rootDirectory: appDir,
  url,
  wallMs,
  wallSeconds,
};
mkdirSync(join(ROOT, "bench"), { recursive: true });
writeFileSync(join(ROOT, "bench", "deploy.json"), JSON.stringify(record, null, 2));
console.log(`✓ deployed ${APP} → ${url}  (${wallSeconds}s wall)`);
console.log(JSON.stringify(record));

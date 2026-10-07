#!/usr/bin/env node
// Bootstrap the gym under $GYM_ROOT: clone next.js at a release tag, create the
// gym/base and gym/incumbent branches, build the base binding (and a frame-pointer
// one for perf), generate the two apps and install them.
//
//   GYM_ROOT=/scratch/turbopack-gym node scripts/turbopack-gym/setup.mjs
//   node scripts/turbopack-gym/setup.mjs --tag v16.4.0 --no-fp
//   node scripts/turbopack-gym/setup.mjs --host bigbox   # apps only, on another machine
//
// Idempotent: existing pieces are kept. Needs git, the next.js rust toolchain (rustup
// installs the pinned nightly on first build), Node 22 and pnpm.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { build, CARGO_ENV, FEATURES } from "./build.mjs";
import {
  APPS,
  BINDINGS,
  BINDING_FILE,
  BUILD_CPUS,
  NEXTJS,
  REPO,
  ROOT,
  TARGETS,
  ensureDir,
  parseArgs,
  sh,
} from "./lib.mjs";
import { host, runRemote, sync } from "./hosts.mjs";

const a = parseArgs(process.argv.slice(2), {
  tag: 1,
  "no-fp": "bool",
  host: 1,
  "apps-only": "bool",
});
const TAG = a.tag || "v16.4.0";
const NEXT_VERSION = TAG.replace(/^v/, "");

// The two apps every A/B runs: the full #98043 shape, and a 400-route app for smoke runs.
export const APP_SPECS = {
  monolith: [],
  quick: ["--routes", "400", "--features", "80", "--ui", "200", "--utils", "150"],
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
}

function setupApps() {
  for (const [name, args] of Object.entries(APP_SPECS)) {
    const dir = join(APPS, name);
    if (existsSync(join(dir, "node_modules", "next"))) continue;
    ensureDir(APPS);
    run("node", [
      join(REPO, "scripts", "monolith-gen.mjs"),
      "--out",
      dir,
      "--next",
      NEXT_VERSION,
      ...args,
      "--clean",
    ]);
    // a real install per app: Turbopack rejects a node_modules symlink that leaves the root
    run("pnpm", ["install", "--ignore-workspace"], { cwd: dir });
  }
}

if (a.host) {
  const h = host(a.host);
  sync(h, []);
  const { code } = await runRemote(h, "scripts/turbopack-gym/setup.mjs", [
    "--apps-only",
    "--tag",
    TAG,
  ]);
  process.exit(code);
}

if (a["apps-only"]) {
  setupApps();
  process.exit(0);
}

ensureDir(ROOT);
if (!existsSync(NEXTJS)) {
  run("git", ["clone", "--filter=blob:none", "https://github.com/vercel/next.js.git", NEXTJS]);
}
const has = (ref) =>
  spawnSync("git", ["-C", NEXTJS, "rev-parse", "--verify", "-q", ref]).status === 0;
if (!has("gym/base")) {
  run("git", ["-C", NEXTJS, "fetch", "-q", "origin", "tag", TAG]);
  run("git", ["-C", NEXTJS, "switch", "-q", "-c", "gym/base", TAG]);
}
if (!has("gym/incumbent")) run("git", ["-C", NEXTJS, "branch", "gym/incumbent", "gym/base"]);

if (!existsSync(join(BINDINGS, "base", BINDING_FILE))) console.log(JSON.stringify(build("base")));
if (!existsSync(join(BINDINGS, "incumbent", BINDING_FILE)))
  sh("cp", ["-a", join(BINDINGS, "base"), join(BINDINGS, "incumbent")]);

// Frame pointers for perf call graphs. RUSTFLAGS replaces the repo's .cargo/config.toml
// rustflags, so the ones the build needs (tokio_unstable etc.) are repeated here.
if (!a["no-fp"] && !existsSync(join(BINDINGS, "base-fp", BINDING_FILE))) {
  const target = join(TARGETS, "base-fp");
  run(
    "bash",
    [
      "-c",
      `taskset -c ${BUILD_CPUS} cargo build -p next-napi-bindings --release --features ${FEATURES}`,
    ],
    {
      cwd: NEXTJS,
      env: {
        ...process.env,
        ...CARGO_ENV,
        CARGO_TARGET_DIR: target,
        RUSTFLAGS:
          "--cfg=tokio_unstable -Zshare-generics=y -Zthreads=8 -Zunstable-options -Cforce-frame-pointers=yes",
      },
    },
  );
  ensureDir(join(BINDINGS, "base-fp"));
  copyFileSync(
    join(target, "release", "libnext_napi_bindings.so"),
    join(BINDINGS, "base-fp", BINDING_FILE),
  );
}

setupApps();
console.log(`gym ready under ${ROOT}`);

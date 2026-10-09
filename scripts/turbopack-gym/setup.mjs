#!/usr/bin/env node
// Bootstrap the gym under $GYM_ROOT: clone next.js, point gym/base at a release tag
// (verified), build the base binding through build.mjs (so its provenance is recorded)
// and a frame-pointer one for perf, generate the two apps and install them.
//
//   GYM_ROOT=/scratch/turbopack-gym node scripts/turbopack-gym/setup.mjs
//   node scripts/turbopack-gym/setup.mjs --tag v16.4.0 --no-fp
//   node scripts/turbopack-gym/setup.mjs --host bigbox   # apps + the base binding, on another machine
//                                                         # (run a local setup first: bindings build here)
//
// Idempotent. An app is regenerated and reinstalled when its tree differs from what the
// generator produces now (so a changed generator or spec never leaves a stale app).
// Needs git, the next.js rust toolchain (rustup installs the pinned nightly on first
// build), Node 22, pnpm, python3.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { build, cargoBuild } from "./build.mjs";
import { installBinding } from "./bindings.mjs";
import {
  APPS,
  BINDINGS,
  BINDING_FILE,
  NEXTJS,
  REPO,
  ROOT,
  TARGETS,
  ensureDir,
  parseArgs,
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

// The apps: the full #98043 shape (2,071 routes) and a 401-route app for smoke runs,
// both from monolith-gen.mjs (an args list); and the same two sizes (2,069 and 401
// routes) of a hand-written data-visualization app with npm dependencies, from
// vizdash-gen.mjs (installed from its committed lockfile).
export const APP_SPECS = {
  monolith: [],
  quick: ["--routes", "400", "--features", "80", "--ui", "200", "--utils", "150"],
  vizdash: { gen: "vizdash-gen.mjs", args: [], frozen: true },
  "vizdash-quick": { gen: "vizdash-gen.mjs", args: ["--dashboards", "228"], frozen: true },
};
const specOf = (s) => (Array.isArray(s) ? { gen: "monolith-gen.mjs", args: s, frozen: false } : s);

// the generator reads MONOLITH_* overrides from the environment: clear them so the
// apps are always APP_SPECS
const genEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("MONOLITH_")),
);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
}
const out = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" }).stdout.trim();

// hash of a generated tree (not node_modules, build output or the summary's out path)
function treeHash(dir) {
  const entries = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".next") || e.name === "monolith.json")
        continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else
        entries.push(
          `${r}\t${createHash("sha256")
            .update(readFileSync(join(d, e.name)))
            .digest("hex")}`,
        );
    }
  };
  walk(dir, "");
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

const generate = (dir, { gen, args }) =>
  run(
    "node",
    [join(REPO, "scripts", gen), "--out", dir, "--next", NEXT_VERSION, ...args, "--clean"],
    {
      env: genEnv,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

function setupApps() {
  ensureDir(APPS);
  for (const [name, raw] of Object.entries(APP_SPECS)) {
    const spec = specOf(raw);
    const dir = join(APPS, name);
    const fresh = mkdtempSync(join(tmpdir(), "gym-app-"));
    try {
      generate(join(fresh, name), spec);
      const installed = existsSync(join(dir, "node_modules", "next"));
      if (
        installed &&
        existsSync(join(dir, "monolith.json")) &&
        treeHash(dir) === treeHash(join(fresh, name))
      )
        continue;
      console.error(`[setup] (re)generating ${name}`);
      rmSync(dir, { recursive: true, force: true }); // our own app dir (may predate --clean's marker)
      generate(dir, spec);
      // a real install per app: Turbopack rejects a node_modules symlink that leaves the root
      run(
        "pnpm",
        ["install", "--ignore-workspace", ...(spec.frozen ? ["--frozen-lockfile"] : [])],
        {
          cwd: dir,
        },
      );
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  }
}

// base must be built by build.mjs from the verified tag (it records head and diff)
const baseOk = () => {
  try {
    const link = join(BINDINGS, "base");
    const src = JSON.parse(readFileSync(join(link, "source.json"), "utf8"));
    return (
      src.head === out("git", ["-C", NEXTJS, "rev-parse", "gym/base"]) &&
      existsSync(join(link, BINDING_FILE))
    );
  } catch {
    return false;
  }
};

if (a.host) {
  const h = host(a.host);
  if (!baseOk())
    throw new Error(
      "no verified local base binding: run setup.mjs here first (bindings build here)",
    );
  sync(h, ["base"]);
  const { code } = await runRemote(h, "scripts/turbopack-gym/setup.mjs", [
    "--apps-only",
    "--tag",
    TAG,
  ]);
  process.exit(typeof code === "number" ? code : 1);
}

if (a["apps-only"]) {
  setupApps();
  process.exit(0);
}

ensureDir(ROOT);
if (!existsSync(NEXTJS))
  run("git", ["clone", "--filter=blob:none", "https://github.com/vercel/next.js.git", NEXTJS]);
run("git", ["-C", NEXTJS, "fetch", "-q", "origin", "tag", TAG, "--no-tags"]);
const tagCommit = out("git", ["-C", NEXTJS, "rev-parse", `${TAG}^{commit}`]);
const has = (ref) =>
  spawnSync("git", ["-C", NEXTJS, "rev-parse", "--verify", "-q", ref]).status === 0;
if (!has("gym/base")) run("git", ["-C", NEXTJS, "switch", "-q", "-c", "gym/base", TAG]);
if (out("git", ["-C", NEXTJS, "rev-parse", "gym/base"]) !== tagCommit)
  throw new Error(`gym/base is not ${TAG} (${tagCommit}); move it or use a fresh GYM_ROOT`);
if (out("git", ["-C", NEXTJS, "status", "--porcelain"]))
  throw new Error(`${NEXTJS} has local changes; the base binding builds from a clean ${TAG}`);
if (!has("gym/incumbent")) run("git", ["-C", NEXTJS, "branch", "gym/incumbent", "gym/base"]);

if (!baseOk()) console.log(JSON.stringify(await build("base")));

// Frame pointers for perf call graphs. RUSTFLAGS replaces the repo's .cargo/config.toml
// rustflags, so the ones the build needs (tokio_unstable etc.) are repeated here.
if (!a["no-fp"] && !existsSync(join(BINDINGS, "base-fp", BINDING_FILE))) {
  const target = join(TARGETS, "base-fp");
  await cargoBuild({
    cwd: NEXTJS,
    target,
    log: join(ensureDir(join(ROOT, "logs")), "build-base-fp.log"),
    env: {
      RUSTFLAGS:
        "--cfg=tokio_unstable -Zshare-generics=y -Zthreads=8 -Zunstable-options -Cforce-frame-pointers=yes",
    },
  });
  const tmp = ensureDir(join(BINDINGS, `.build-base-fp-${process.pid}`));
  copyFileSync(join(target, "release", "libnext_napi_bindings.so"), join(tmp, BINDING_FILE));
  installBinding("base-fp", tmp);
}

setupApps();
console.log(`gym ready under ${ROOT}`);

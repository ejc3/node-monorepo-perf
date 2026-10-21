#!/usr/bin/env node
// Builds every engine the route-planner bench runs (ROUTE-PLANNER.md), into ROUTE_ROOT:
//
//   Rust native and WebAssembly    route-planner/engine-rs/build-native.sh, build-wasm.sh
//                                  (CARGO_TARGET_DIR under ROUTE_ROOT; the probe and the
//                                  WebAssembly glue land in engine-rs/pkg/, gitignored)
//   Scriptc                        route-planner/native/build.sh -> ROUTE_ROOT/scriptc/probe
//   Hermes 0.14.1 and V1, shermes  route-planner/hermes/build-hermes.sh -> ROUTE_ROOT/hermes/
//   the JavaScript programs        ROUTE_ROOT/js/: the plan program bundled by esbuild (es2017),
//                                  the same through React Native's Babel preset, and the typed
//                                  ports (ffi.py writes tuned-ffi.js from tuned.js)
//   per trip                       ROUTE_ROOT/trips/<id>/: each program behind a prelude holding
//                                  the pack and the request, compiled by each Hermes
//
// and writes ROUTE_ROOT/build.json: what was built, from which versions. Then bench.mjs runs them.
//
//   ROUTE_ROOT=<dir> node scripts/route-planner/build.mjs [--skip-hermes]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PLANNER, SPEC, pack, planRequest, root, sha256, sourcesSha256, version } from "./lib.mjs";

const ROOT = root();
// The sources as the build starts: an edit while it runs makes bench.mjs refuse the build.
const sources = sourcesSha256();
const run = (cmd, args, opts = {}) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
};
const out = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 2 ** 30, ...opts }).trim();
mkdirSync(ROOT, { recursive: true });

const require = createRequire(join(PLANNER, "package.json"));
try {
  require.resolve("esbuild");
} catch {
  console.error("route-planner/node_modules is missing: run `pnpm install --frozen-lockfile` in route-planner/");
  process.exit(2);
}

// --- Rust ------------------------------------------------------------------------------
const cargoEnv = { ...process.env, CARGO_TARGET_DIR: join(ROOT, "cargo") };
const rs = join(PLANNER, "engine-rs");
run(join(rs, "build-native.sh"), [], { cwd: rs, env: cargoEnv });
run(join(rs, "build-wasm.sh"), [], { cwd: rs, env: cargoEnv });

// --- Scriptc ---------------------------------------------------------------------------
run(join(PLANNER, "native", "build.sh"), [join(ROOT, "scriptc")]);

// --- Hermes ----------------------------------------------------------------------------
const H = join(ROOT, "hermes");
if (!process.argv.includes("--skip-hermes")) run(join(PLANNER, "hermes", "build-hermes.sh"), [H]);
const classic = join(H, "classic", "bin");
const v1 = join(H, "v1", "bin");
const hermesSource = (name) => ({
  tag: out("git", ["-C", join(H, `src-${name}`), "describe", "--tags", "--exact-match"]),
  commit: out("git", ["-C", join(H, `src-${name}`), "rev-parse", "HEAD"]),
});

// --- the JavaScript programs -------------------------------------------------------------
const JS = join(ROOT, "js");
mkdirSync(JS, { recursive: true });
const esbuild = require("esbuild");
const entry = join(PLANNER, "hermes", "plan-entry.ts");
// The plan program as a classic script, ES2017: what Hermes V1 interprets and shermes compiles
// untyped.
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  target: "es2017",
  logLevel: "error",
  outfile: join(JS, "plan.js"),
});
// The same program through React Native's Babel preset, as Metro transforms an app's modules
// for Hermes (the default transform profile; helpers inlined, there being no module system to
// require @babel/runtime from): what Hermes 0.14.1 runs, and V1 too as a variant.
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  target: "esnext",
  logLevel: "error",
  outfile: join(JS, "plan-esm.js"),
});
const babel = require("@babel/core");
const babelOut = babel.transformSync(readFileSync(join(JS, "plan-esm.js"), "utf8"), {
  babelrc: false,
  configFile: false,
  filename: "plan.js",
  presets: [[require.resolve("@react-native/babel-preset"), { enableBabelRuntime: false }]],
  compact: false,
});
writeFileSync(join(JS, "plan-babel.js"), babelOut.code);
// The typed ports, and the tuned one with its primitives as C calls.
for (const f of ["port.js", "tuned.js"]) copyFileSync(join(PLANNER, "hermes", "typed", f), join(JS, f));
run("python3", [
  join(PLANNER, "hermes", "typed", "ffi.py"),
  join(JS, "tuned.js"),
  join(JS, "tuned-ffi.js"),
]);

// --- per trip ----------------------------------------------------------------------------
const { text, sha256: packSha256 } = pack();
writeFileSync(join(ROOT, "pack.json"), text);
const FFI = join(PLANNER, "hermes", "typed", "ffi");
for (const trip of SPEC.trips) {
  const T = join(ROOT, "trips", trip.id);
  mkdirSync(T, { recursive: true });
  const req = planRequest(trip);
  writeFileSync(join(T, "request.json"), req);
  writeFileSync(join(T, "calls.tsv"), `plan\t${req}\n`);
  const prelude = `var PACK = ${JSON.stringify(text)}; var REQUEST = ${JSON.stringify(req)};\n`;
  const withPrelude = (src, name) => {
    writeFileSync(join(T, name), prelude + readFileSync(join(JS, src), "utf8"));
    return join(T, name);
  };
  const plain = withPrelude("plan.js", "plan.js");
  const babeled = withPrelude("plan-babel.js", "plan-babel.js");
  // Hermes 0.14.1 does not parse classes: it runs the Babel output only, as an app's bundle.
  run(join(classic, "hermesc"), ["-O", "-emit-binary", "-out", join(T, "classic.hbc"), babeled]);
  run(join(v1, "hermesc"), ["-O", "-emit-binary", "-out", join(T, "v1.hbc"), plain]);
  run(join(v1, "hermesc"), ["-O", "-emit-binary", "-out", join(T, "v1-babel.hbc"), babeled]);
  run(join(v1, "shermes"), ["-O", "-w", "-o", join(T, "shermes"), plain]);
  for (const [src, name, extra] of [
    ["port.js", "typed-port", []],
    ["tuned.js", "typed-tuned", []],
    ["tuned-ffi.js", "typed-ffi", [`-Wc,-I${FFI}`]],
  ])
    run(join(v1, "shermes"), ["-typed", "-O", ...extra, "-o", join(T, name), withPrelude(src, `${name}.js`)]);
}

const manifest = {
  packSha256,
  sourcesSha256: sources,
  trips: SPEC.trips.map((t) => t.id),
  versions: {
    node: process.version,
    rustc: version("rustc", ["--version"], { cwd: rs }),
    wasmBindgen: version(process.env.WASM_BINDGEN || "wasm-bindgen"),
    scriptc: version(join(process.env.SCRIPTC_HOME || join(process.env.HOME, ".cache", "scriptc-0.4.0"), "bin", "scriptc")),
    cc: version("cc"),
    hermesClassic: hermesSource("classic"),
    hermesV1: hermesSource("v1"),
    esbuild: esbuild.version,
    babelCore: babel.version,
    reactNativeBabelPreset: require("@react-native/babel-preset/package.json").version,
  },
  programs: Object.fromEntries(
    ["plan.js", "plan-babel.js", "port.js", "tuned.js", "tuned-ffi.js"].map((f) => [
      f,
      sha256(readFileSync(join(JS, f))),
    ]),
  ),
};
writeFileSync(join(ROOT, "build.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${join(ROOT, "build.json")}`);

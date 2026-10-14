// Runs Next.js's route bundle stats step once and prints its time as JSON. route-stats.mjs
// starts one of these per run, so no run reuses another's module cache.
//
//   node route-stats-child.cjs <app dir> <compiled route-bundle-stats.js> <dist dir> <project dir>
//
// The compiled file is loaded as the app's next/dist/build/route-bundle-stats.js (same file
// name), so its relative requires resolve as they do in a build. The inputs are the ones the
// build passes: the app routes from app-path-routes-manifest.json, the pages from
// server/pages-manifest.json and build-manifest.json.
"use strict";
const Module = require("module");
const fs = require("fs");
const path = require("path");

const [appDir, compiled, distDir, projectDir] = process.argv.slice(2);
const target = require.resolve("next/dist/build/route-bundle-stats.js", { paths: [appDir] });
const source = fs.readFileSync(compiled, "utf8");
const load = Module._extensions[".js"];
Module._extensions[".js"] = function (module, filename) {
  if (filename === target) return module._compile(source, filename);
  return load(module, filename);
};

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const app = [
  ...new Set(Object.values(readJson(path.join(distDir, "app-path-routes-manifest.json")))),
];
const pagesManifest = path.join(distDir, "server", "pages-manifest.json");
const pages = fs.existsSync(pagesManifest) ? Object.keys(readJson(pagesManifest)) : [];
const buildManifest = readJson(path.join(distDir, "build-manifest.json"));

const { writeRouteBundleStats } = require(target);
const cpu = process.cpuUsage();
const start = process.hrtime.bigint();
writeRouteBundleStats({ pages, app }, buildManifest, distDir, projectDir).then(() => {
  const s = Number(process.hrtime.bigint() - start) / 1e9;
  const used = process.cpuUsage(cpu);
  process.stdout.write(
    `${JSON.stringify({
      s: Math.round(s * 1e4) / 1e4,
      cpuS: Math.round((used.user + used.system) / 1e2) / 1e4,
      rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20),
    })}\n`,
  );
});

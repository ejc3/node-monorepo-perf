// Preloaded (NODE_OPTIONS=--require) into a build's node processes by next-ab.mjs: loads
// compiled replacements for some of the app's next/dist files. GYM_NEXT_OVERLAY is a JSON map
// from a dist file's real path to the compiled file to run in its place; the replacement is
// compiled under the dist file's own name, so its relative requires resolve as they do there.
// Next.js passes NODE_OPTIONS on to the workers it starts. Each load of a replacement appends
// "<pid> <dist file>" to GYM_NEXT_OVERLAY_LOG, when it is set.
"use strict";
const Module = require("module");
const fs = require("fs");

const overlay = JSON.parse(process.env.GYM_NEXT_OVERLAY || "{}");
const log = process.env.GYM_NEXT_OVERLAY_LOG;
const load = Module._extensions[".js"];
Module._extensions[".js"] = function (module, filename) {
  const replacement = overlay[filename];
  if (!replacement) return load(module, filename);
  if (log) fs.appendFileSync(log, `${process.pid} ${filename}\n`);
  return module._compile(fs.readFileSync(replacement, "utf8"), filename);
};

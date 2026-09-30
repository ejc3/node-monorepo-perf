// _ts.mjs — the single resolver for the TypeScript toolchain paths.
//
// typescript@7 (the native compiler, formerly tsgo) and the typescript6 alias
// (npm:typescript@6 — the last JS release: the tsc oracle plus tsserver) are
// both installed at the repo root, so `node_modules/.bin/tsc` is a bin-name
// collision. Nothing may resolve tsc through `.bin` or bare PATH — every bench
// imports these direct paths and asserts the resolved binary's version once
// (untimed) before timing it.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// typescript@7's node shim (bin/tsc). On node >=22.15 the shim EXECVE-REPLACES
// the node process with the native binary, so a process spawned as
// `node <shim>` BECOMES the checker itself — same pid, no wrapper-with-child
// geometry, and GNU-time/RSS attribution is direct. Like-for-like with the old
// `.bin/tsgo` node shim the existing records were measured through, which
// exec'd the same way.
export function tsNativeShim(root) {
  return join(root, "node_modules", "typescript", "bin", "tsc");
}

// Sync mirror of getExePath's installed-package resolution, for call sites
// that cannot await: the platform package @typescript/typescript-<platform>-
// <arch>, resolved through the typescript package itself (pnpm geometry), exe
// at lib/tsc.
export function tsNativeExeSync(root) {
  // realpath through the package-manager symlink (pnpm isolation): the platform
  // package is only resolvable from the typescript package's REAL location.
  const tsPkgJson = realpathSync(join(root, "node_modules", "typescript", "package.json"));
  const pkg = JSON.parse(readFileSync(tsPkgJson, "utf8"));
  const baseName = pkg.name.startsWith("@") ? pkg.name.split("/")[1] : pkg.name;
  const platformPkg = `@typescript/${baseName}-${process.platform}-${process.arch}`;
  const require = createRequire(tsPkgJson);
  const platformPkgJson = require.resolve(`${platformPkg}/package.json`);
  return join(dirname(platformPkgJson), "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
}

// TypeScript 6 — the last JS release, kept as the oracle checker and the
// tsserver the editor benches anchor against. Both are node scripts.
export function ts6Tsc(root) {
  return join(root, "node_modules", "typescript6", "bin", "tsc");
}

export function ts6Tsserver(root) {
  return join(root, "node_modules", "typescript6", "lib", "tsserver.js");
}

// Version asserts: every bench runs `--version` on the binary it resolved,
// once, untimed, and passes the output through one of these before timing.
export function assertTs7(versionOutput) {
  if (!/Version 7\./.test(versionOutput ?? "")) {
    throw new Error(`expected the native TypeScript 7 compiler, got: ${versionOutput}`);
  }
  return versionOutput.trim();
}

export function assertTs6(versionOutput) {
  if (!/Version 6\./.test(versionOutput ?? "")) {
    throw new Error(
      `expected the TypeScript 6 JS compiler (typescript6 alias), got: ${versionOutput}`,
    );
  }
  return versionOutput.trim();
}

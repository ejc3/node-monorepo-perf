// build-hermes.sh rebuilds a cached Hermes when a build input changes (here the compiler), with
// git, cmake, ninja and the compilers stubbed: build.mjs would otherwise record today's versions
// over binaries an older toolchain built.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { PLANNER } from "./lib.mjs";

test("build-hermes.sh rebuilds when the compiler changes, and only then", () => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-cache-"));
  try {
    const bin = join(dir, "bin");
    const root = join(dir, "root");
    const calls = join(dir, "calls");
    mkdirSync(bin);
    const stub = (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    // git: each tree is already cloned (below); describe answers the tag in the tree's .tag
    stub("git", 'case "$*" in *clone*) ;; *describe*) cat "$2/.tag";; *rev-parse*) echo 0;; esac');
    stub("cmake", `[ "$1" = --version ] && exit 0; echo cmake >> ${calls}; while [ "$1" != -B ]; do shift; done; mkdir -p "$2"`);
    stub("ninja", `[ "$1" = --version ] && exit 0; echo ninja >> ${calls}`);
    stub("c++", 'echo "c++ $CXX_VERSION"');
    stub("cc", 'echo "cc $CXX_VERSION"');
    const run = (cxx) => {
      writeFileSync(calls, "");
      const r = spawnSync("bash", [join(PLANNER, "hermes", "build-hermes.sh"), root], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CXX_VERSION: cxx },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      return readFileSync(calls, "utf8").split("\n").filter((l) => l === "cmake").length;
    };
    for (const [name, tag] of [
      ["classic", "hermes-v0.14.1"],
      ["v1", "hermes-v250829098.0.4"],
    ]) {
      mkdirSync(join(root, `src-${name}`, ".git"), { recursive: true });
      writeFileSync(join(root, `src-${name}`, ".tag"), `${tag}\n`);
    }
    assert.equal(run("1"), 2, "the first build configures both trees");
    assert.equal(run("1"), 0, "the same inputs build nothing");
    assert.equal(run("2"), 2, "another compiler rebuilds both");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

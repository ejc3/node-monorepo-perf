// bench.mjs refuses a ROUTE_ROOT whose build.json names other sources than today's: it would
// otherwise time old compiled programs against today's TypeScript in Node.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { REPO, SPEC, pack, planRequest, sourcesSha256 } from "./lib.mjs";

function rootWith(sources) {
  const root = mkdtempSync(join(tmpdir(), "route-root-"));
  writeFileSync(join(root, "build.json"), JSON.stringify({ packSha256: pack().sha256, sourcesSha256: sources }));
  for (const t of SPEC.trips) {
    mkdirSync(join(root, "trips", t.id), { recursive: true });
    writeFileSync(join(root, "trips", t.id, "request.json"), planRequest(t));
  }
  return root;
}

test("bench.mjs refuses a build from other route-planner sources before running an engine", () => {
  const root = rootWith("0".repeat(64));
  try {
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "route-planner", "bench.mjs"), "--out", join(root, "out.json")], {
      env: { ...process.env, ROUTE_ROOT: root, ROUTE_ROUNDS: "2" },
      encoding: "utf8",
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /built from other route-planner sources/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the sources hash is stable and covers the engine", () => {
  assert.equal(sourcesSha256(), sourcesSha256());
  assert.match(sourcesSha256(), /^[0-9a-f]{64}$/);
});

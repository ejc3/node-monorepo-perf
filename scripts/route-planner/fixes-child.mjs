// One plan in a fresh Node process on one variant of the TypeScript engine, for fixes.mjs:
// load the area (untimed), time planTrip and its JSON, and print one line of JSON: the time,
// the answer's hash, the engine's counters when the variant carries them (globalThis.__rp),
// the movement statistics' sizes and the map's.
//
//   node scripts/route-planner/fixes-child.mjs <variant dir> <pack.json> <request.json> [<answer file>]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, packFile, reqFile, answerFile] = process.argv.slice(2);
globalThis.__rp = {
  searches: 0,
  settled: 0,
  buckets: 0,
  boundSettled: 0,
  simulations: 0,
  mornings: 0,
  crossings: 0,
  edgeDraws: 0,
};
const { loadArea, planTrip } = await import(join(dir, "engine", "src", "compute.ts"));
const packJson = JSON.parse(readFileSync(packFile, "utf8"));
const area = loadArea("area", packJson);
const req = JSON.parse(readFileSync(reqFile, "utf8"));
const t0 = performance.now();
const answer = JSON.stringify(planTrip(area, req));
const ms = performance.now() - t0;
if (answerFile) writeFileSync(answerFile, `{"ok":${answer}}`);
const g = area.g;
process.stdout.write(
  JSON.stringify({
    ms: +ms.toFixed(1),
    // the hash of the answer as engine-lib.ts's call wraps it, as bench.mjs records it
    answerSha256: createHash("sha256").update(`{"ok":${answer}}`).digest("hex"),
    routes: JSON.parse(answer).routes.length,
    counters: globalThis.__rp,
    movements: area.stats.movements.size,
    movementPairs: area.stats.stats.size,
    map: {
      ways: packJson.ways.length,
      nodes: packJson.nodes.length / 5,
      vertices: g.vertices.length,
      junctions: g.vertices.filter((v) => v.degree >= 3).length,
      edges: g.edges.length,
      complexes: g.complexes.length,
      restrictions: packJson.restrictions.length / 4,
    },
  }) + "\n",
);

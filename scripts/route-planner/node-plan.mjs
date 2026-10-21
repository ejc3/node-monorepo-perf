// One plan call in a fresh Node process, for bench.mjs: load the area (untimed), time the
// plan call, print the answer and then "plan ms N" (with a fraction: performance.now()).
//
//   node scripts/route-planner/node-plan.mjs <ts|wasm> <pack.json> <request.json>
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { PLANNER } from "./lib.mjs";

const [engine, packFile, reqFile] = process.argv.slice(2);
const text = readFileSync(packFile, "utf8");
const req = readFileSync(reqFile, "utf8");
let callPlan;
if (engine === "ts") {
  const { load, call } = await import(join(PLANNER, "native", "engine-lib.ts"));
  const h = load("area", text);
  callPlan = () => call(h, "plan", req);
} else if (engine === "wasm") {
  const wasm = createRequire(import.meta.url)(
    join(PLANNER, "engine-rs", "pkg", "node", "route_planner_engine.js"),
  );
  const e = new wasm.Engine();
  const h = e.load("area", Buffer.from(text, "utf8"));
  callPlan = () => e.call(h, "plan", req);
} else throw new Error(`unknown engine ${engine}: ts or wasm`);
const t0 = performance.now();
const out = callPlan();
const ms = performance.now() - t0;
process.stdout.write(out + "\n");
process.stdout.write(`plan ms ${ms.toFixed(1)}\n`);

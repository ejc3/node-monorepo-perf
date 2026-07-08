// Wedge retest: the 500k one-edit recheck pressure that wedged flow 0.321 in 3 of 5
// canonical-bench sweeps, against (a) released flow-bin 0.321.0 and (b) the fixed
// flow main build. Per binary: generate the same layered 500k Flow corpus, start the
// server, then run EDIT_CYCLES force-recheck+status cycles. A status that exceeds
// HANG_MS with a panic in the server log = wedge (the recorded failure signature).
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const BIN = process.argv[2]; // path to flow binary
const LABEL = process.argv[3] || "flow";
const N = Number(process.env.RETEST_N || 500_000);
const LAYERS = 100;
const EDIT_CYCLES = Number(process.env.RETEST_CYCLES || 10);
const HANG_MS = Number(process.env.RETEST_HANG_MS || 8 * 60 * 1000);
const WORK = `/mnt/fcvm-btrfs/flow-wedge-retest-${LABEL}`;
const DIR = join(WORK, "corpus");

if (!BIN || !existsSync(BIN)) {
  console.error(`usage: node flow-wedge-retest.mjs <flow-binary> <label>`);
  process.exit(2);
}
const shard = (i) => String(Math.floor(i / 1000)).padStart(4, "0");
const modBody = (i) => {
  // mirrors tsgo-scale-bench's flow corpus: layered fixed-depth, ≤3 imports from the
  // previous layer, // @flow pragma so every file is checked
  const layer = i % LAYERS;
  const imports = [];
  if (layer > 0) {
    for (const back of [1, 1 + LAYERS, 1 + 2 * LAYERS]) {
      const j = i - back;
      if (j >= 0 && j % LAYERS === layer - 1) imports.push(j);
    }
  }
  const importLines = imports
    .map((j, k) => `import { v${j} } from "../${shard(j)}/m${j}";`)
    .join("\n");
  const sum = imports.length ? imports.map((j) => `v${j}`).join(" + ") : "0";
  return `// @flow
${importLines}
export const v${i}: number = ${i} + ${sum};
const priv${i}: string = "m${i}";
export function f${i}(x: number): number { return x + v${i} + priv${i}.length; }
`;
};

console.log(`[${LABEL}] generating ${N.toLocaleString()}-module corpus at ${DIR}`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
writeFileSync(join(DIR, ".flowconfig"), "[options]\n");
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  if (i % 1000 === 0) mkdirSync(join(DIR, "src", shard(i)), { recursive: true });
  writeFileSync(join(DIR, "src", shard(i), `m${i}.js`), modBody(i));
}
console.log(`[${LABEL}] generated in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

const flow = (args, opts = {}) =>
  spawnSync(BIN, args, { cwd: DIR, encoding: "utf8", maxBuffer: 1 << 28, ...opts });
const serverLog = () => {
  try {
    const enc = DIR.replaceAll("/", "zS");
    return readFileSync(`/tmp/flow/${enc}.log`, "utf8");
  } catch {
    return "";
  }
};

console.log(`[${LABEL}] flow start --wait (init = full check of 500k)...`);
const ts = Date.now();
const start = flow(["start", "--wait"], { timeout: 30 * 60 * 1000 });
if (start.status !== 0) {
  console.log(`[${LABEL}] RESULT: server failed to start (exit ${start.status})`);
  console.log(serverLog().split("\n").slice(-10).join("\n"));
  process.exit(1);
}
console.log(`[${LABEL}] server up in ${((Date.now() - ts) / 1000).toFixed(0)}s`);

// the wedge trigger: the recorded panics all fired when the WATCHER reported changes
// while a check was in flight (cancellation mid-check). Per cycle: edit A + notify,
// then while that recheck runs, edit B in another module (the watcher's report lands
// mid-check and cancels it), then ask for status.
const pick = (frac) => {
  let i = Math.floor(N * frac);
  if (i % LAYERS === 0) i += 1;
  return i;
};
const eiA = pick(0.5);
const eiB = pick(0.25);
const tA = join(DIR, "src", shard(eiA), `m${eiA}.js`);
const tB = join(DIR, "src", shard(eiB), `m${eiB}.js`);
const origA = readFileSync(tA, "utf8");
const origB = readFileSync(tB, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wedged = false;
for (let c = 1; c <= EDIT_CYCLES; c++) {
  writeFileSync(tA, origA + `const retestEditA${c}: number = ${c};\n`);
  const tc = Date.now();
  // async notify so the recheck runs while we land edit B mid-check
  const frA = spawn(BIN, ["force-recheck", "--no-auto-start", tA], { cwd: DIR, stdio: "ignore" });
  await sleep(120 + (c % 5) * 90); // vary the collision offset across cycles
  writeFileSync(tB, origB + `const retestEditB${c}: number = ${c};\n`);
  spawnSync(BIN, ["force-recheck", "--no-auto-start", tB], { cwd: DIR, timeout: HANG_MS });
  const st = flow(["status", "--no-auto-start"], { timeout: HANG_MS });
  const ms = Date.now() - tc;
  frA.kill();
  const timedOut = (st.error && st.error.code === "ETIMEDOUT") || false;
  const panic = /panicked at/.test(serverLog());
  console.log(
    `[${LABEL}] cycle ${c}: ${timedOut ? `HUNG >${HANG_MS / 60000}min` : `${ms}ms (exit ${st.status})`}${panic ? " — PANIC IN SERVER LOG" : ""}`,
  );
  if (timedOut || panic) {
    wedged = true;
    const tail = serverLog().split("\n").slice(-8).join("\n");
    console.log(`[${LABEL}] server log tail:\n${tail}`);
    break;
  }
}
writeFileSync(tA, origA);
writeFileSync(tB, origB);
flow(["stop"], { stdio: "ignore" });
rmSync(WORK, { recursive: true, force: true });
console.log(
  `[${LABEL}] RESULT: ${wedged ? "WEDGED (panic/hang reproduced)" : `survived ${EDIT_CYCLES} edit-recheck cycles, no panic`}`,
);

// The engines the parity harness runs one script of calls through, on one area:
//   ts      the TypeScript engine, through native/engine-lib.ts (its load and call: the same
//           `{"ok": …}` or `{"error": …}` text the native library answers);
//   wasm    the Rust engine's WebAssembly build (build-wasm.sh), in this process;
//   native  a static library linked into native/probe.c: Rust's (build-native.sh), or
//           Scriptc's (native/build.sh).
// Each answer is the call's raw text, with the time it took.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call as tsCall, load as tsLoad } from "../../native/engine-lib.ts";
import { loadWasm } from "./wasm.ts";

export interface Call { op: string; req: string }
export interface Answer { text: string; ms: number }

export const PROBE = process.env["DM_PROBE"] ?? new URL("../pkg/native/probe", import.meta.url).pathname;

/** An area loaded in one engine: calls run one at a time, in order, on the same area model. */
export interface Loaded { call(c: Call): Answer }

export function loadTs(id: string, packText: string): Loaded {
  const h = tsLoad(id, packText);
  return { call: (c) => { const t = performance.now(); const text = tsCall(h, c.op, c.req); return { text, ms: performance.now() - t }; } };
}

export function loadRustWasm(id: string, packText: string): Loaded & { free(): void } {
  const wasm = loadWasm();
  const engine = new wasm.Engine();
  const h = engine.load(id, Buffer.from(packText, "utf8"));
  return {
    call: (c) => { const t = performance.now(); const text = engine.call(h, c.op, c.req); return { text, ms: performance.now() - t }; },
    free: () => engine.free(),
  };
}

/**
 * The whole script through a probe at once (one process, one load): the probe prints each
 * answer on its own line and each call's time on stderr.
 */
export function runNative(packFile: string, calls: Call[], probe = PROBE): Answer[] {
  if (!existsSync(probe)) throw new Error(`${probe} is missing: run engine-rs/build-native.sh first`);
  const dir = mkdtempSync(join(tmpdir(), "rp-engine-parity-"));
  try {
    const script = join(dir, "calls.tsv");
    for (const c of calls) if (c.op.includes("\t") || c.op.includes("\n") || c.req.includes("\n")) throw new Error(`call ${c.op} does not fit a line`);
    writeFileSync(script, calls.map((c) => `${c.op}\t${c.req}`).join("\n") + "\n");
    const r = spawnSync(probe, [packFile, script], { encoding: "utf8", maxBuffer: 2 ** 31 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`the probe exited ${r.status}: ${r.stderr.slice(-2000)}`);
    const lines = r.stdout.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const times = r.stderr.trim().split("\n").map((l) => Number(/ (\d+) ms$/.exec(l)?.[1] ?? NaN));
    if (lines.length !== calls.length) throw new Error(`the probe answered ${lines.length} calls of ${calls.length}`);
    return lines.map((text, i) => ({ text, ms: times[i] ?? NaN }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The Rust engine's WebAssembly build for Node (build-wasm.sh writes pkg/node/), typed here by
// hand so the tests typecheck without a build.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

export interface WasmArea {
  counts(): string;
  canonicalBytes(): Uint8Array;
  calibrationJson(): string;
  free(): void;
}

export interface WasmRng {
  next(): number;
  uniform(a: number, b: number): number;
  exponential(rate: number): number;
  normal(): number;
  geometric(p: number): number;
  draws(kind: "next" | "uniform" | "exponential" | "normal" | "geometric" | "mixed", n: number, a: number, b: number): Float64Array;
  free(): void;
}

/** The engine: `load` gives a handle; `call` answers `{"ok": …}` or `{"error": …}`, as `dm_call` does. */
export interface WasmEngine {
  load(id: string, pack: Uint8Array): number;
  call(handle: number, op: string, request: string): string;
  free(): void;
}

export interface EngineWasm {
  Engine: new () => WasmEngine;
  Area: { load(bytes: Uint8Array): WasmArea };
  Rng: new (seed: number) => WasmRng;
  hash(s: string): number;
  hashUnits(units: Uint16Array): number;
  math(op: string, x: Float64Array, y: Float64Array): Float64Array;
  toUint32(x: Float64Array): Uint32Array;
  numbersToString(x: Float64Array): string;
  jsonNumbers(x: Float64Array): string;
  toFixed(x: Float64Array, digits: number): string;
  parseNumbers(text: string): Float64Array;
  jsonString(s: string): string;
}

const MODULE = new URL("../pkg/node/route_planner_engine.js", import.meta.url).pathname;

export function loadWasm(): EngineWasm {
  if (!existsSync(MODULE)) throw new Error(`${MODULE} is missing: run engine-rs/build-wasm.sh first`);
  return createRequire(import.meta.url)(MODULE) as EngineWasm;
}

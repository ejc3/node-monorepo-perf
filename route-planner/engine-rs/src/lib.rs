//! The route planner's engine in Rust (ROUTE-PLANNER.md): the TypeScript engine's plan call
//! (`engine/src/compute.ts`), native and WebAssembly.
//!
//! - Contracts: `pack` (an area pack decoded as `fromPack` decodes it), `random` (`random.ts`
//!   bit for bit), `jsmath` (the engine's `Math` through `libm`, with JavaScript's semantics,
//!   and `pow` from ARM optimized-routines), `jsnum` (JavaScript's number conversions and
//!   spellings).
//! - The engine, module for module with `engine/src`: `geo`, `osm`, `graph`, `traffic`,
//!   `intersection`, `router`, `simulate`, `plan`, `describe`; and `compute` (`compute.ts`),
//!   `engine` (`native/engine-lib.ts`).
//! - Interfaces: `ffi` (the C interface of `native/profile.json`) on native targets, `wasm`
//!   (`wasm-bindgen` exports) on wasm32.
//!
//! Every result is the TypeScript's arithmetic in the TypeScript's order: no fused
//! multiply-add, floats summed in the same order, the same tie-breaking in heaps and stable
//! sorts, insertion-ordered maps wherever the TypeScript iterates a Map.

pub mod compute;
pub mod describe;
pub mod engine;
pub mod fxhash;
pub mod geo;
pub mod graph;
pub mod intersection;
pub mod jsmath;
pub mod jsnum;
pub mod json;
pub mod osm;
pub mod pack;
pub mod plan;
pub mod pow;
mod pow_data;
pub mod random;
pub mod router;
pub mod simulate;
pub mod text;
pub mod traffic;

#[cfg(not(target_arch = "wasm32"))]
pub mod ffi;

#[cfg(target_arch = "wasm32")]
mod wasm;

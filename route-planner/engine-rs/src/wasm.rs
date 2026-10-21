//! The WebAssembly exports: the engine (`Engine`: `load` and `call`, as `native/engine-lib.ts`
//! and the C interface have them), and the pieces the parity harness (engine-rs/test/) compares
//! with the TypeScript engine one by one.

use wasm_bindgen::prelude::*;

use crate::{engine, jsmath, jsnum, pack, random};

/// The engine: loaded areas, and one call at a time on them, JSON in and out.
#[wasm_bindgen]
pub struct Engine(engine::Engine);

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Engine {
        Engine(engine::Engine::new())
    }

    /// Loads an area from its pack's JSON text (UTF-8 bytes): the handle its calls take.
    pub fn load(&mut self, id: &str, pack: &[u8]) -> Result<f64, JsError> {
        self.0.load(id, pack).map_err(|e| JsError::new(&e))
    }

    /// A call ("plan"): `{"ok": result}` or
    /// `{"error": message}`, the same bytes as the native library's `dm_call`.
    pub fn call(&mut self, handle: f64, op: &str, request: &str) -> String {
        self.0.call(handle, op, request.as_bytes())
    }
}

/// A decoded area pack.
#[wasm_bindgen]
pub struct Area(pack::AreaPack);

#[wasm_bindgen]
impl Area {
    /// Decodes a pack's JSON text (UTF-8 bytes).
    pub fn load(bytes: &[u8]) -> Result<Area, JsError> {
        pack::decode(bytes).map(Area).map_err(|e| JsError::new(&e.to_string()))
    }

    /// The counts, as JSON.
    pub fn counts(&self) -> String {
        serde_json::to_string(&self.0.counts()).expect("counts serialize")
    }

    /// The decoded records in the harness's byte layout (`AreaPack::canonical_bytes`).
    #[wasm_bindgen(js_name = canonicalBytes)]
    pub fn canonical_bytes(&self) -> Vec<u8> {
        self.0.canonical_bytes()
    }

    /// The calibration as canonical JSON, or "null".
    #[wasm_bindgen(js_name = calibrationJson)]
    pub fn calibration_json(&self) -> String {
        self.0
            .calibration
            .as_ref()
            .map_or("null".to_owned(), pack::Calibration::canonical_json)
    }
}

/// `rng(seed)`.
#[wasm_bindgen]
pub struct Rng(random::Rng);

#[wasm_bindgen]
impl Rng {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: f64) -> Rng {
        Rng(random::Rng::from_js_number(seed))
    }
    pub fn next(&mut self) -> f64 {
        self.0.next()
    }
    pub fn uniform(&mut self, a: f64, b: f64) -> f64 {
        self.0.uniform(a, b)
    }
    pub fn exponential(&mut self, rate: f64) -> f64 {
        self.0.exponential(rate)
    }
    pub fn normal(&mut self) -> f64 {
        self.0.normal()
    }
    pub fn geometric(&mut self, p: f64) -> f64 {
        self.0.geometric(p)
    }
    /// `n` draws of one kind in a row ("next", "uniform" (a, b), "exponential" (a = rate),
    /// "normal", "geometric" (a = p)), or "mixed": next, normal, exponential(a), uniform(a, b),
    /// geometric(0.5) in turn, so the draws share one stream as the engine's do.
    pub fn draws(&mut self, kind: &str, n: u32, a: f64, b: f64) -> Result<Vec<f64>, JsError> {
        if !["next", "uniform", "exponential", "normal", "geometric", "mixed"].contains(&kind) {
            return Err(JsError::new(&format!("unknown draw kind {kind}")));
        }
        let r = &mut self.0;
        Ok((0..n)
            .map(|i| match (kind, i % 5) {
                ("next", _) | ("mixed", 0) => r.next(),
                ("normal", _) | ("mixed", 1) => r.normal(),
                ("exponential", _) | ("mixed", 2) => r.exponential(a),
                ("uniform", _) | ("mixed", 3) => r.uniform(a, b),
                ("geometric", _) => r.geometric(a),
                _ => r.geometric(0.5),
            })
            .collect())
    }
}

/// `hash(str)` (the string arrives as UTF-8, so a lone surrogate is already U+FFFD; use
/// `hashUnits` for that).
#[wasm_bindgen]
pub fn hash(s: &str) -> u32 {
    random::hash(s)
}

/// `hash` over a string's UTF-16 code units, exactly as `charCodeAt` reads them.
#[wasm_bindgen(js_name = hashUnits)]
pub fn hash_units(units: &[u16]) -> u32 {
    random::hash_utf16(units.iter().copied())
}

/// One `jsmath` function over arrays: `op(x[i])`, or `op(x[i], y[i])` for "atan2", "pow",
/// "max", "min" and "rem".
#[wasm_bindgen]
pub fn math(op: &str, x: &[f64], y: &[f64]) -> Result<Vec<f64>, JsError> {
    let unary: Option<fn(f64) -> f64> = match op {
        "sin" => Some(jsmath::sin),
        "cos" => Some(jsmath::cos),
        "tan" => Some(jsmath::tan),
        "asin" => Some(jsmath::asin),
        "exp" => Some(jsmath::exp),
        "expm1" => Some(jsmath::expm1),
        "log" => Some(jsmath::ln),
        "sqrt" => Some(jsmath::sqrt),
        "abs" => Some(jsmath::abs),
        "floor" => Some(jsmath::js_floor),
        "ceil" => Some(jsmath::js_ceil),
        "round" => Some(jsmath::js_round),
        _ => None,
    };
    if let Some(f) = unary {
        return Ok(x.iter().map(|&v| f(v)).collect());
    }
    let binary: fn(f64, f64) -> f64 = match op {
        "atan2" => jsmath::atan2,
        "pow" => jsmath::js_pow,
        "max" => jsmath::js_max,
        "min" => jsmath::js_min,
        "rem" => jsmath::js_rem,
        _ => return Err(JsError::new(&format!("unknown math op {op}"))),
    };
    if x.len() != y.len() {
        return Err(JsError::new("math: x and y differ in length"));
    }
    Ok(x.iter().zip(y).map(|(&a, &b)| binary(a, b)).collect())
}

/// `x >>> 0` over an array.
#[wasm_bindgen(js_name = toUint32)]
pub fn to_uint32(x: &[f64]) -> Vec<u32> {
    x.iter().map(|&v| jsnum::to_uint32(v)).collect()
}

/// `xs.map(String).join("\n")`.
#[wasm_bindgen(js_name = numbersToString)]
pub fn numbers_to_string(xs: &[f64]) -> String {
    xs.iter()
        .map(|&x| jsnum::number_to_string(x))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `JSON.stringify(xs)`.
#[wasm_bindgen(js_name = jsonNumbers)]
pub fn json_numbers(xs: &[f64]) -> String {
    format!(
        "[{}]",
        xs.iter().map(|&x| jsnum::json_number(x)).collect::<Vec<_>>().join(",")
    )
}

/// `xs.map((x) => x.toFixed(digits)).join("\n")`.
#[wasm_bindgen(js_name = toFixed)]
pub fn to_fixed(xs: &[f64], digits: u32) -> Result<String, JsError> {
    if digits > 20 {
        return Err(JsError::new("toFixed: digits 0..=20"));
    }
    Ok(xs
        .iter()
        .map(|&x| jsnum::to_fixed(x, digits))
        .collect::<Vec<_>>()
        .join("\n"))
}

/// `JSON.parse(text)` for an array of numbers, as the pack decoder parses them.
#[wasm_bindgen(js_name = parseNumbers)]
pub fn parse_numbers(text: &str) -> Result<Vec<f64>, JsError> {
    serde_json::from_str(text).map_err(|e| JsError::new(&e.to_string()))
}

/// `JSON.stringify(s)` for a string.
#[wasm_bindgen(js_name = jsonString)]
pub fn json_string(s: &str) -> String {
    jsnum::json_string(s)
}

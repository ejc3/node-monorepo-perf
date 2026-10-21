//! `native/engine-lib.ts`: loaded areas by handle, and one call at a time on them, JSON in and
//! out. The C interface (`ffi`) and the WebAssembly exports (`wasm`) are thin layers over this.

use crate::compute::{load_area, plan_trip, AreaModel};
use crate::jsnum::{json_string, number_to_string};
use crate::pack;

#[derive(Default)]
pub struct Engine {
    areas: Vec<AreaModel>,
}

impl Engine {
    pub const fn new() -> Self {
        Engine { areas: Vec::new() }
    }

    /// `load(id, packJson)`: decodes and builds an area; its handle is what its calls take.
    pub fn load(&mut self, id: &str, pack_json: &[u8]) -> Result<f64, String> {
        let p = pack::decode(pack_json).map_err(|e| e.to_string())?;
        self.areas.push(load_area(id, &p));
        Ok((self.areas.len() - 1) as f64)
    }

    /// `call(handle, op, requestJson)`: `{"ok": result}`, or `{"error": message}` when the call
    /// refuses (no route from here, no such area, an unknown call, a malformed request).
    pub fn call(&mut self, handle: f64, op: &str, request_json: &[u8]) -> String {
        match self.run(handle, op, request_json) {
            Ok(r) => {
                let mut out = String::with_capacity(r.len() + 7);
                out.push_str("{\"ok\":");
                out.push_str(&r);
                out.push('}');
                out
            }
            Err(e) => format!("{{\"error\":{}}}", json_string(&e)),
        }
    }

    fn run(&mut self, handle: f64, op: &str, req: &[u8]) -> Result<String, String> {
        // `areas[handle]`: only a whole number in range names an area (-0 is 0).
        let area = if handle.fract() == 0.0 && handle >= 0.0 && handle < self.areas.len() as f64 {
            &mut self.areas[handle as usize]
        } else {
            return Err(format!("no area {}", number_to_string(handle)));
        };
        let parse = |what| move |e: serde_json::Error| format!("{what} request: {e}");
        match op {
            "plan" => plan_trip(area, &serde_json::from_slice(req).map_err(parse("plan"))?),
            _ => Err(format!("unknown call {op}")),
        }
    }
}

//! The C interface of `native/profile.json`, as the Scriptc library exports it, so `native/probe.c`
//! links this library unchanged:
//!
//! - `dm_init()`, and `dm_collect()` (a no-op: there is no collector);
//! - `dm_set_panic_sink(fn, ctx)`: where a panic is reported, `fn(ctx, message, length, 0)`;
//! - `dm_load(id, id_len, pack, pack_len) -> handle`;
//! - `dm_call(handle, op, op_len, req, req_len, &out, &out_len)`: `{"ok": …}` or `{"error": …}`,
//!   in a buffer the library owns until its next call.
//!
//! A panic never unwinds into C: it is caught at the boundary and reported to the sink. The
//! host's sink may `longjmp` out of it, so the sink is called with no Rust value left to drop
//! in this frame (the message lives in a static buffer). If the sink returns, `dm_load` gives
//! -1 and `dm_call` answers `{"error": "panic: …"}`.

use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, MutexGuard};

use crate::engine::Engine;
use crate::jsnum::json_string;

type Sink = extern "C" fn(*mut c_void, *const u8, usize, u64);
/// The sink to call with a stored panic message: the sink, its context, the message.
type SinkCall = (Sink, usize, *const u8, usize);

struct State {
    engine: Engine,
    /// The last call's answer, valid until the next call.
    out: Vec<u8>,
    /// The last panic's message, valid while the sink runs.
    panic: Vec<u8>,
    sink: Option<(Sink, usize)>,
}

static STATE: Mutex<State> = Mutex::new(State {
    engine: Engine::new(),
    out: Vec::new(),
    panic: Vec::new(),
    sink: None,
});

/// The state, whether or not a panic poisoned its lock (the host stops calling after one).
fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|p| p.into_inner())
}

fn bytes<'a>(p: *const u8, len: usize) -> &'a [u8] {
    if p.is_null() || len == 0 {
        &[]
    } else {
        // SAFETY: the caller passes `len` readable bytes at `p` for the call's duration.
        unsafe { std::slice::from_raw_parts(p, len) }
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_owned()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "the engine panicked".to_owned()
    }
}

/// Stores a panic's message, and returns the sink to call with it: plain values only, so the
/// caller holds nothing that needs dropping when the sink jumps away.
fn report(message: String) -> Option<SinkCall> {
    let mut s = state();
    s.panic = message.into_bytes();
    let (ptr, len) = (s.panic.as_ptr(), s.panic.len());
    s.sink.map(|(f, ctx)| (f, ctx, ptr, len))
}

#[no_mangle]
pub extern "C" fn dm_init() {
    drop(state());
}

#[no_mangle]
pub extern "C" fn dm_collect() {}

/// # Safety
/// `ctx` is passed back to `sink` as given; the library never reads it.
#[no_mangle]
pub unsafe extern "C" fn dm_set_panic_sink(sink: Option<Sink>, ctx: *mut c_void) {
    state().sink = sink.map(|f| (f, ctx as usize));
}

fn load_inner(id: &[u8], pack: &[u8]) -> Result<f64, Option<SinkCall>> {
    let r = catch_unwind(AssertUnwindSafe(|| {
        let id = String::from_utf8_lossy(id);
        state().engine.load(&id, pack)
    }));
    match r {
        Ok(Ok(h)) => Ok(h),
        // A pack that does not decode fails the load, as JSON.parse throwing does in the
        // TypeScript library (where it is a panic).
        Ok(Err(e)) => Err(report(e)),
        Err(p) => Err(report(panic_message(p.as_ref()))),
    }
}

/// # Safety
/// `id` and `pack` point at `id_len` and `pack_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn dm_load(id: *const u8, id_len: usize, pack: *const u8, pack_len: usize) -> f64 {
    match load_inner(bytes(id, id_len), bytes(pack, pack_len)) {
        Ok(h) => h,
        Err(sink) => {
            if let Some((f, ctx, msg, len)) = sink {
                f(ctx as *mut c_void, msg, len, 0);
            }
            -1.0
        }
    }
}

/// What a call into the library leaves: its answer, and the sink to call when it panicked.
/// Plain values only, so nothing is left to drop when the sink jumps away.
struct Outcome {
    out: (*const u8, usize),
    sink: Option<SinkCall>,
}

/// Runs `work` on the engine at the boundary: its answer becomes the library's result buffer;
/// a panic becomes `{"error": "panic: …"}` there, and its message the sink's.
fn answer(work: impl FnOnce(&mut Engine) -> String) -> Outcome {
    let r = catch_unwind(AssertUnwindSafe(|| {
        let mut s = state();
        let a = work(&mut s.engine);
        s.out = a.into_bytes();
        (s.out.as_ptr(), s.out.len())
    }));
    match r {
        Ok(out) => Outcome { out, sink: None },
        Err(p) => {
            let message = panic_message(p.as_ref());
            let mut s = state();
            s.out = format!("{{\"error\":{}}}", json_string(&format!("panic: {message}"))).into_bytes();
            let out = (s.out.as_ptr(), s.out.len());
            drop(s);
            Outcome {
                out,
                sink: report(message),
            }
        }
    }
}

/// Hands an outcome to the caller, then (after a panic) to the sink, which may not return.
///
/// # Safety
/// `out` and `out_len` are writable.
unsafe fn deliver(o: Outcome, out: *mut *const u8, out_len: *mut usize) {
    *out = o.out.0;
    *out_len = o.out.1;
    if let Some((f, ctx, msg, len)) = o.sink {
        f(ctx as *mut c_void, msg, len, 0);
    }
}

/// # Safety
/// `op` and `req` point at `op_len` and `req_len` readable bytes; `out` and `out_len` are
/// writable. The answer at `*out` stays valid until the next call into the library.
#[no_mangle]
pub unsafe extern "C" fn dm_call(
    handle: f64,
    op: *const u8,
    op_len: usize,
    req: *const u8,
    req_len: usize,
    out: *mut *const u8,
    out_len: *mut usize,
) {
    let (op, req) = (bytes(op, op_len), bytes(req, req_len));
    let o = answer(|e| e.call(handle, &String::from_utf8_lossy(op), req));
    deliver(o, out, out_len);
}

#[cfg(test)]
mod tests {
    use super::*;

    static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

    extern "C" fn record(_ctx: *mut c_void, msg: *const u8, len: usize, _addr: u64) {
        let m = String::from_utf8_lossy(bytes(msg, len)).into_owned();
        SEEN.lock().unwrap().push(m);
    }

    fn call(handle: f64, op: &str, req: &str) -> String {
        let (mut out, mut len) = (std::ptr::null(), 0usize);
        // SAFETY: the pointers are this frame's; the answer is copied before the next call.
        unsafe {
            dm_call(
                handle,
                op.as_ptr(),
                op.len(),
                req.as_ptr(),
                req.len(),
                &mut out,
                &mut len,
            )
        };
        String::from_utf8(bytes(out, len).to_vec()).unwrap()
    }

    fn load(pack: &str) -> f64 {
        // SAFETY: the slices outlive the call.
        unsafe { dm_load(b"t".as_ptr(), 1, pack.as_ptr(), pack.len()) }
    }

    /// One test, as the library's state is one per process.
    #[test]
    fn the_c_interface_answers_refuses_and_reports_panics_to_the_sink() {
        dm_init();
        // SAFETY: the sink ignores its context.
        unsafe { dm_set_panic_sink(Some(record), std::ptr::null_mut()) };

        // A pack that does not decode fails the load, through the sink.
        assert_eq!(load("not json"), -1.0);
        assert!(SEEN.lock().unwrap().pop().unwrap().starts_with("area pack: "));

        // A plus-shaped junction: Main St east-west, Elm St north-south, 200 m arms.
        let pack = r#"{"v":1,"id":"t","name":"T","bbox":{"south":-1,"west":-1,"north":1,"east":1},"osmTimestamp":"",
            "calibration":null,"names":["Main St","Elm St"],
            "ways":[[100,"primary",0,0,0,0,0,0,10,1,11],[200,"residential",0,1,0,0,0,0,20,1,21]],
            "nodes":[10,0,-18000,0,0,1,0,0,0,0,11,0,18000,0,0,20,18000,0,0,0,21,-18000,0,0,0],"restrictions":[]}"#;
        let h = load(pack);
        assert!(h >= 0.0 && h.fract() == 0.0, "handle {h}");
        let plan = r#"{"from":{"lat":0,"lon":-0.0018},"to":{"lat":0.0018,"lon":0},
            "goal":{"arriveByMinute":490,"confidence":0.95,"earlyMinutes":0},"runs":30,"windowMinutes":10,"stepMinutes":5}"#;
        let a = call(h, "plan", plan);
        assert!(
            a.starts_with(r#"{"ok":{"routes":[{"key":"r0","via":["Main St","Elm St"]"#),
            "{a}"
        );
        assert_eq!(call(h, "nonsense", "{}"), r#"{"error":"unknown call nonsense"}"#);
        assert_eq!(
            call(h + 99.0, "plan", plan),
            format!(r#"{{"error":"no area {}"}}"#, h + 99.0)
        );
        assert_eq!(call(h, "track", "{}"), r#"{"error":"unknown call track"}"#);
        assert!(call(h, "plan", "{").starts_with(r#"{"error":"plan request: "#));
        assert!(SEEN.lock().unwrap().is_empty(), "no refusal is a panic");

        // A panic at the boundary: the caller gets an error, the sink the message.
        let (mut out, mut len) = (std::ptr::null(), 0usize);
        let o = answer(|_| panic!("boom"));
        // SAFETY: the pointers are this frame's.
        unsafe { deliver(o, &mut out, &mut len) };
        assert_eq!(bytes(out, len), br#"{"error":"panic: boom"}"#);
        assert_eq!(SEEN.lock().unwrap().pop().as_deref(), Some("boom"));
        // And the library still answers after it.
        assert!(call(h, "plan", plan).starts_with(r#"{"ok":"#));
        dm_collect();
    }
}

//! `engine/src/random.ts`, bit for bit: mulberry32 and the draws built on it.
//!
//! Every operation is the TypeScript one: the JavaScript integer operators are u32 wrapping
//! arithmetic, and the transcendentals go through `jsmath` (libm).

use crate::jsmath::{cos, js_floor, ln, sqrt, PI};
use crate::jsnum::to_uint32;

/// `rng(seed)`: a seeded generator.
#[derive(Clone, Debug)]
pub struct Rng {
    s: u32,
}

impl Rng {
    /// `rng(seed)` for a seed already reduced to 32 bits (`seed >>> 0`).
    pub fn new(seed: u32) -> Self {
        // `seed >>> 0 || 0x9e3779b9`: a zero seed is replaced.
        Rng {
            s: if seed == 0 { 0x9e37_79b9 } else { seed },
        }
    }

    /// `rng(seed)` for any JavaScript number, with `>>> 0`'s ToUint32 (NaN and ±Infinity are 0).
    pub fn from_js_number(seed: f64) -> Self {
        Rng::new(to_uint32(seed))
    }

    /// `next()`: [0, 1), a multiple of 2^-32. Named as in random.ts; this is not an iterator.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f64 {
        // s = (s + 0x6d2b79f5) >>> 0
        self.s = self.s.wrapping_add(0x6d2b_79f5);
        let mut t = self.s;
        // t = Math.imul(t ^ (t >>> 15), t | 1)
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        // t ^= t + Math.imul(t ^ (t >>> 7), t | 61): the sum is reduced by ^'s ToInt32, so it wraps.
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        // ((t ^ (t >>> 14)) >>> 0) / 4294967296
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }

    /// `uniform(a, b)`: `a + (b - a) * next()`.
    pub fn uniform(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.next()
    }

    /// `exponential(rate)`: `-Math.log(1 - next()) / rate`.
    pub fn exponential(&mut self, rate: f64) -> f64 {
        -ln(1.0 - self.next()) / rate
    }

    /// `normal()`: Box–Muller, `sqrt(-2 log u) * cos(2π v)` with `u = 1 - next()` drawn first.
    pub fn normal(&mut self) -> f64 {
        let u = 1.0 - self.next();
        let v = self.next();
        sqrt(-2.0 * ln(u)) * cos(2.0 * PI * v)
    }

    /// `geometric(p)`: failures before the first success. `p <= 0` draws nothing.
    pub fn geometric(&mut self, p: f64) -> f64 {
        if p <= 0.0 {
            0.0
        } else {
            js_floor(ln(1.0 - self.next()) / ln(p))
        }
    }
}

/// `hash(str)`: FNV-1a over the string's UTF-16 code units (`charCodeAt`), as a u32.
pub fn hash(s: &str) -> u32 {
    hash_utf16(s.encode_utf16())
}

/// `hash` over UTF-16 code units directly, for a JavaScript string that is not valid UTF-16.
pub fn hash_utf16(units: impl IntoIterator<Item = u16>) -> u32 {
    let mut h: u32 = 2_166_136_261;
    for c in units {
        h = (h ^ u32::from(c)).wrapping_mul(16_777_619);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    // Values printed by the TypeScript engine (node -e with engine/src/random.ts).
    #[test]
    fn next_matches_the_typescript_stream() {
        let mut r = Rng::new(1);
        let got: Vec<u64> = (0..4).map(|_| r.next().to_bits()).collect();
        let want = [
            0.6270739405881613f64,
            0.002735721180215478,
            0.5274470399599522,
            0.9810509674716741,
        ];
        assert_eq!(got, want.map(f64::to_bits));
    }

    #[test]
    fn seed_zero_and_nan_are_the_default_seed() {
        let a = Rng::new(0x9e37_79b9).next();
        assert_eq!(Rng::new(0).next(), a);
        assert_eq!(Rng::from_js_number(f64::NAN).next(), a);
        assert_eq!(Rng::from_js_number(4_294_967_296.0).next(), a);
        assert_eq!(Rng::from_js_number(-1.0).next(), Rng::new(u32::MAX).next());
    }

    #[test]
    fn geometric_draws_nothing_for_p_zero() {
        let mut r = Rng::new(7);
        assert_eq!(r.geometric(0.0), 0.0);
        assert_eq!(r.next(), Rng::new(7).next());
    }

    #[test]
    fn hash_reads_utf16_code_units() {
        assert_eq!(hash(""), 2_166_136_261);
        assert_eq!(hash("12>34"), 2_745_209_355);
        // One astral character is two code units, as charCodeAt sees it.
        assert_eq!(hash("\u{1F697}"), 1_647_489_645);
        assert_eq!(hash("\u{1F697}"), hash_utf16([0xD83D, 0xDE97]));
    }

    #[test]
    fn draws_match_the_typescript_ones() {
        let mut r = Rng::new(42);
        assert_eq!(r.normal().to_bits(), (-1.2848381576290195f64).to_bits());
        assert_eq!(r.exponential(0.5).to_bits(), 3.8273904430985937f64.to_bits());
        assert_eq!(r.geometric(0.3), 0.0);
        assert_eq!(r.uniform(2.0, 5.0).to_bits(), 2.5244416962377727f64.to_bits());
    }
}

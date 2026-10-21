//! The engine's `Math`, with JavaScript's semantics.
//!
//! - Every transcendental goes through the `libm` crate, on every target, so the native build
//!   and the WebAssembly build compute the same bits (ROUTE-PLANNER.md, Parity).
//!   The one exception is `**`: `libm`'s fdlibm `pow` was over half of a calibrated plan, so
//!   `pow.rs` ports ARM optimized-routines' (pure Rust too, the same bits on every target).
//!   Never call `f64::sin` and friends: on a native target they are the platform's libm.
//! - `sqrt`, `floor`, `ceil`, `abs` and `%` are exact in IEEE 754, so any implementation gives
//!   the same bits; they go through `libm` too, for one rule.
//! - Where JavaScript's semantics differ from Rust's or C's, the function says so: `js_round`
//!   (halves toward +∞), `js_max`/`js_min` (NaN wins, +0 > -0), `js_pow` (`1 ** NaN` is NaN).
//!
//! Rust never fuses a multiply and an add on its own, so `a * b + c` rounds twice, as in
//! JavaScript.

/// `Math.PI`: the double nearest π.
pub const PI: f64 = core::f64::consts::PI;

/// `Math.sin`.
#[inline]
pub fn sin(x: f64) -> f64 {
    libm::sin(x)
}

/// `Math.cos`.
#[inline]
pub fn cos(x: f64) -> f64 {
    libm::cos(x)
}

/// `Math.tan`.
#[inline]
pub fn tan(x: f64) -> f64 {
    libm::tan(x)
}

/// `Math.asin`.
#[inline]
pub fn asin(x: f64) -> f64 {
    libm::asin(x)
}

/// `Math.atan2(y, x)`.
#[inline]
pub fn atan2(y: f64, x: f64) -> f64 {
    libm::atan2(y, x)
}

/// `Math.exp`.
#[inline]
pub fn exp(x: f64) -> f64 {
    libm::exp(x)
}

/// `Math.expm1`.
#[inline]
pub fn expm1(x: f64) -> f64 {
    libm::expm1(x)
}

/// `Math.log` (the natural logarithm).
#[inline]
pub fn ln(x: f64) -> f64 {
    libm::log(x)
}

/// `Math.sqrt` (correctly rounded everywhere).
#[inline]
pub fn sqrt(x: f64) -> f64 {
    libm::sqrt(x)
}

/// `Math.abs`.
#[inline]
pub fn abs(x: f64) -> f64 {
    libm::fabs(x)
}

/// `Math.floor`.
#[inline]
pub fn js_floor(x: f64) -> f64 {
    libm::floor(x)
}

/// `Math.ceil`.
#[inline]
pub fn js_ceil(x: f64) -> f64 {
    libm::ceil(x)
}

/// JavaScript's `a % b`: the remainder with the dividend's sign (C's `fmod`).
#[inline]
pub fn js_rem(a: f64, b: f64) -> f64 {
    libm::fmod(a, b)
}

/// `Math.round`: the nearest integer, halves toward +∞ (`Math.round(-2.5)` is -2, `Math.round(2.5)`
/// is 3), and -0 for every x in [-0.5, -0]. Not Rust's `round`, which takes halves away from zero.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let r = js_floor(x);
    // x - floor(x) is exact for every finite double, so the comparison with 0.5 is too
    // (unlike floor(x + 0.5), which is 1 for 0.49999999999999994).
    let n = if x - r >= 0.5 { r + 1.0 } else { r };
    if n == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        n
    }
}

/// `x ** y` and `Math.pow(x, y)`, through `pow::pow` (ARM optimized-routines' algorithm behind
/// fdlibm's exact shortcuts). C's `pow` differs in two cases: JavaScript gives NaN for a NaN
/// exponent (C: `pow(1, NaN)` is 1) and for `(±1) ** ±Infinity` (C: 1).
pub fn js_pow(x: f64, y: f64) -> f64 {
    if y.is_nan() || (y.is_infinite() && abs(x) == 1.0) {
        return f64::NAN;
    }
    #[cfg(feature = "fdlibm-pow")]
    return libm::pow(x, y);
    #[cfg(not(feature = "fdlibm-pow"))]
    crate::pow::pow(x, y)
}

/// `Math.max(a, b)`: NaN if either is NaN, and +0 over -0. (Rust's `f64::max` ignores a NaN.)
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else if b > a {
        b
    } else if a.is_sign_positive() {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN if either is NaN, and -0 under +0.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else if b < a {
        b
    } else if a.is_sign_negative() {
        a
    } else {
        b
    }
}

/// `Math.max(...xs)`: -Infinity for none.
pub fn js_max_of(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(f64::NEG_INFINITY, js_max)
}

/// `Math.min(...xs)`: +Infinity for none.
pub fn js_min_of(xs: impl IntoIterator<Item = f64>) -> f64 {
    xs.into_iter().fold(f64::INFINITY, js_min)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn same(a: f64, b: f64) -> bool {
        a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan())
    }

    #[test]
    fn round_takes_halves_toward_plus_infinity() {
        let cases = [
            (0.5, 1.0),
            (1.5, 2.0),
            (2.5, 3.0),
            (-0.5, -0.0),
            (-1.5, -1.0),
            (-2.5, -2.0),
            (0.49999999999999994, 0.0),
            (-0.49999999999999994, -0.0),
            (-0.0, -0.0),
            (0.0, 0.0),
            (-0.2, -0.0),
            (4503599627370495.5, 4503599627370496.0),
            (-4503599627370495.5, -4503599627370495.0),
            (9007199254740993.0, 9007199254740992.0),
            (1e300, 1e300),
            (f64::INFINITY, f64::INFINITY),
            (f64::NEG_INFINITY, f64::NEG_INFINITY),
        ];
        for (x, want) in cases {
            assert!(
                same(js_round(x), want),
                "Math.round({x:e}) = {want:e}, got {:e}",
                js_round(x)
            );
        }
        assert!(js_round(f64::NAN).is_nan());
    }

    #[test]
    fn max_and_min_let_nan_win_and_order_zeros() {
        assert!(js_max(0.0, f64::NAN).is_nan());
        assert!(js_min(f64::NAN, 0.0).is_nan());
        assert!(same(js_max(-0.0, 0.0), 0.0));
        assert!(same(js_max(0.0, -0.0), 0.0));
        assert!(same(js_min(0.0, -0.0), -0.0));
        assert!(same(js_min(-0.0, 0.0), -0.0));
        assert_eq!(js_max_of([]), f64::NEG_INFINITY);
        assert_eq!(js_min_of([]), f64::INFINITY);
        assert!(js_max_of([1.0, f64::NAN, 3.0]).is_nan());
        assert_eq!(js_max_of([1.0, 5.0, 3.0]), 5.0);
    }

    #[test]
    fn pow_has_javascripts_nan_cases() {
        assert!(js_pow(1.0, f64::NAN).is_nan());
        assert!(js_pow(1.0, f64::INFINITY).is_nan());
        assert!(js_pow(-1.0, f64::NEG_INFINITY).is_nan());
        assert_eq!(js_pow(f64::NAN, 0.0), 1.0);
        assert_eq!(js_pow(3.0, 2.0), 9.0);
        assert_eq!(js_pow(2.0, 14.0), 16384.0);
    }

    #[test]
    fn rem_keeps_the_dividends_sign() {
        assert!(same(js_rem(-30.0, 360.0), -30.0));
        assert!(same(js_rem(390.5, 360.0), 30.5));
        assert!(same(js_rem(-0.0, 360.0), -0.0));
        assert!(js_rem(1.0, 0.0).is_nan());
    }
}

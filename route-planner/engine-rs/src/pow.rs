//! `pow`, ported from ARM optimized-routines (`math/pow.c`, the `pow` glibc and musl ship),
//! on its path without fused multiply-add and without rounding intrinsics, so every target
//! computes the same bits. About 3× faster than the `libm` crate's fdlibm `pow`, which was more
//! than half of a calibrated area's plan, and within 0.54 ulp of the true value (fdlibm's is
//! within 1 ulp).
//!
//! In front of it, the exact shortcuts fdlibm takes and the `libm` crate had: `x ** 1` is x,
//! `x ** -1` is 1 / x, `x ** 2` is x · x and `x ** 0.5` is √x for x ≥ +0. So `x ** 2` (every
//! distance) is the one correctly rounded product, as it is in V8.
//!
//! Checked bit for bit against the C source compiled the same way (no FMA, no rounding
//! intrinsics, no contraction): `pow_vectors.txt`, and the parity harness's 10^6 inputs
//! against V8.
//!
//! Copyright (c) 2018-2026, Arm Limited (the algorithm, `pow_data`).
//! SPDX-License-Identifier: MIT OR Apache-2.0 WITH LLVM-exception

use crate::pow_data::{EXP_POLY, EXP_TAB, INVLN2N, LN2HI, LN2LO, LOG_POLY, LOG_TAB, NEGLN2HIN, NEGLN2LON, SHIFT};

const POW_LOG_TABLE_BITS: u32 = 7;
const EXP_TABLE_BITS: u32 = 7;
const N_EXP: u64 = 1 << EXP_TABLE_BITS;
const OFF: u64 = 0x3fe6955500000000;
const SIGN_BIAS: u64 = 0x800 << EXP_TABLE_BITS;
const ONE_BITS: u64 = 0x3ff0000000000000;
const INF_BITS: u64 = 0x7ff0000000000000;

#[inline(always)]
fn f(u: u64) -> f64 {
    f64::from_bits(u)
}

#[inline(always)]
fn top12(x: f64) -> u32 {
    (x.to_bits() >> 52) as u32
}

/// 0 if not an integer, 1 if an odd integer, 2 if even; for a nonzero finite double's bits.
#[inline]
fn checkint(iy: u64) -> u32 {
    let e = (iy >> 52 & 0x7ff) as i32;
    if e < 0x3ff {
        return 0;
    }
    if e > 0x3ff + 52 {
        return 2;
    }
    if iy & ((1u64 << (0x3ff + 52 - e)) - 1) != 0 {
        return 0;
    }
    if iy & (1u64 << (0x3ff + 52 - e)) != 0 {
        return 1;
    }
    2
}

/// The bits of 0, infinity or NaN.
#[inline(always)]
fn zeroinfnan(i: u64) -> bool {
    (2u64.wrapping_mul(i)).wrapping_sub(1) >= (2 * INF_BITS).wrapping_sub(1)
}

#[inline]
fn issignaling(x: f64) -> bool {
    2u64.wrapping_mul(x.to_bits() ^ 0x0008000000000000) > 2u64.wrapping_mul(0x7ff8000000000000)
}

/// `__math_oflow`, `__math_uflow`: ±∞ and ±0, as the product that would raise the flag.
#[inline(never)]
fn xflow(sign: u64, y: f64) -> f64 {
    (if sign != 0 { -y } else { y }) * y
}

fn oflow(sign: u64) -> f64 {
    xflow(sign, f(0x7000000000000000)) // 0x1p769
}

fn uflow(sign: u64) -> f64 {
    xflow(sign, f(0x1000000000000000)) // 0x1p-767
}

/// log(x) as hi + tail, with about 15 bits beyond hi's. `ix` is x's bits, a subnormal x
/// normalized with the exponent going negative.
#[inline(always)]
fn log_inline(ix: u64) -> (f64, f64) {
    let a = |i: usize| f(LOG_POLY[i]);
    // x = 2^k z, z in [OFF, 2·OFF) and exact; z's subinterval i has c near its centre.
    let tmp = ix.wrapping_sub(OFF);
    let i = ((tmp >> (52 - POW_LOG_TABLE_BITS)) % (1 << POW_LOG_TABLE_BITS)) as usize;
    let k = ((tmp as i64) >> 52) as i32; // arithmetic shift
    let iz = ix.wrapping_sub(tmp & (0xfff_u64 << 52));
    let z = f(iz);
    let kd = f64::from(k);

    let [invc, logc, logctail] = LOG_TAB[i].map(f);

    // r = z/c - 1, split so that rhi, rlo and rhi·rhi are exact and |rlo| <= |r|.
    let zhi = f(iz.wrapping_add(1u64 << 31) & (u64::MAX << 32));
    let zlo = z - zhi;
    let rhi = zhi * invc - 1.0;
    let rlo = zlo * invc;
    let r = rhi + rlo;

    // k·Ln2 + log(c) + r.
    let t1 = kd * f(LN2HI) + logc;
    let t2 = t1 + r;
    let lo1 = kd * f(LN2LO) + logctail;
    let lo2 = t1 - t2 + r;

    let ar = a(0) * r; // a(0) = -0.5
    let ar2 = r * ar;
    let ar3 = r * ar2;
    // k·Ln2 + log(c) + r + A[0]·r·r.
    let arhi = a(0) * rhi;
    let arhi2 = rhi * arhi;
    let hi = t2 + arhi2;
    let lo3 = rlo * (ar + arhi);
    let lo4 = t2 - hi + arhi2;
    // p = log1p(r) - r - A[0]·r·r.
    let p = ar3 * (a(1) + r * a(2) + ar2 * (a(3) + r * a(4) + ar2 * (a(5) + r * a(6))));
    let lo = lo1 + lo2 + lo3 + lo4 + p;
    let y = hi + lo;
    let tail = hi - y + lo;
    (y, tail)
}

/// scale · (1 + tmp) where that may overflow or underflow. `sbits` is scale's bits with an
/// exponent that may have overflowed into the sign bit; (i32) `ki` says which way.
#[inline(never)]
fn specialcase(tmp: f64, sbits: u64, ki: u64) -> f64 {
    if ki & 0x80000000 == 0 {
        // k > 0: the exponent of scale might have overflowed by <= 460.
        let scale = f(sbits.wrapping_sub(1009u64 << 52));
        let y = scale + scale * tmp;
        // (The C checks for upward rounding here; this engine always rounds to nearest.)
        return y * f(0x7f00000000000000); // 0x1p1009
    }
    // k < 0: care in the subnormal range.
    let sbits = sbits.wrapping_add(1022u64 << 52);
    let scale = f(sbits); // signed
    let mut y = scale + scale * tmp;
    if y.abs() < 1.0 {
        // Round y to the right precision before scaling it into the subnormal range.
        let one = if y < 0.0 { -1.0 } else { 1.0 };
        let mut lo = scale - y + scale * tmp;
        let hi = one + y;
        #[allow(clippy::assign_op_pattern)] // the C's order, as the C writes it
        {
            lo = one - hi + y + lo;
        }
        y = (hi + lo) - one;
        // The sign of 0.
        if y == 0.0 {
            y = f(sbits & 0x8000000000000000);
        }
    }
    f(0x0010000000000000) * y // 0x1p-1022
}

/// sign · exp(x + xtail), |xtail| < 2^-8/N and |xtail| <= |x|; `sign_bias` SIGN_BIAS or 0.
#[inline(always)]
fn exp_inline(x: f64, xtail: f64, sign_bias: u64) -> f64 {
    let c = |i: usize| f(EXP_POLY[i]);
    let small = top12(f(0x3c90000000000000)); // 0x1p-54
    let mut abstop = top12(x) & 0x7ff;
    if abstop.wrapping_sub(small) >= top12(512.0).wrapping_sub(small) {
        if abstop.wrapping_sub(small) >= 0x80000000 {
            // Tiny x (0 is common): 1 + x, with no spurious underflow.
            let one = 1.0 + x;
            return if sign_bias != 0 { -one } else { one };
        }
        if abstop >= top12(1024.0) {
            // inf and NaN are handled already.
            return if x.to_bits() >> 63 != 0 {
                uflow(sign_bias)
            } else {
                oflow(sign_bias)
            };
        }
        // Large x is special-cased below.
        abstop = 0;
    }
    // exp(x) = 2^(k/N) · exp(r), x = ln2/N·k + r, k an integer, r in [-ln2/2N, ln2/2N].
    let z = f(INVLN2N) * x;
    // z - kd is in [-1, 1] in non-nearest rounding modes.
    let mut kd = z + f(SHIFT);
    let ki = kd.to_bits();
    kd -= f(SHIFT);
    let mut r = x + kd * f(NEGLN2HIN) + kd * f(NEGLN2LON);
    r += xtail;
    // 2^(k/N) ~= scale · (1 + tail).
    let idx = (2 * (ki % N_EXP)) as usize;
    let top = ki.wrapping_add(sign_bias) << (52 - EXP_TABLE_BITS);
    let tail = f(EXP_TAB[idx]);
    // A valid scale only when -1023·N < k < 1024·N.
    let sbits = EXP_TAB[idx + 1].wrapping_add(top);
    // exp(x) = 2^(k/N) · exp(r) ~= scale + scale · (tail + exp(r) - 1).
    let r2 = r * r;
    let tmp = tail + r + r2 * (c(0) + r * c(1)) + r2 * r2 * (c(2) + r * c(3));
    if abstop == 0 {
        return specialcase(tmp, sbits, ki);
    }
    let scale = f(sbits);
    scale + scale * tmp
}

/// ARM optimized-routines' `pow(x, y)`, C semantics (`pow(1, NaN)` is 1).
pub fn arm_pow(x: f64, y: f64) -> f64 {
    let mut sign_bias: u64 = 0;
    let mut ix = x.to_bits();
    let iy = y.to_bits();
    let mut topx = top12(x);
    let topy = top12(y);
    if topx.wrapping_sub(0x001) >= 0x7ff - 0x001 || (topy & 0x7ff).wrapping_sub(0x3be) >= 0x43e - 0x3be {
        // x < 0x1p-126 or inf or NaN, or |y| < 0x1p-65 or |y| >= 0x1p63 or NaN.
        if zeroinfnan(iy) {
            if 2u64.wrapping_mul(iy) == 0 {
                return if issignaling(x) { x + y } else { 1.0 };
            }
            if ix == ONE_BITS {
                return if issignaling(y) { x + y } else { 1.0 };
            }
            if 2u64.wrapping_mul(ix) > 2 * INF_BITS || 2u64.wrapping_mul(iy) > 2 * INF_BITS {
                return x + y;
            }
            if 2u64.wrapping_mul(ix) == 2 * ONE_BITS {
                return 1.0;
            }
            if (2u64.wrapping_mul(ix) < 2 * ONE_BITS) == (iy >> 63 == 0) {
                return 0.0; // |x| < 1 && y == inf, or |x| > 1 && y == -inf
            }
            return y * y;
        }
        if zeroinfnan(ix) {
            let mut x2 = x * x;
            if ix >> 63 != 0 && checkint(iy) == 1 {
                x2 = -x2;
            }
            return if iy >> 63 != 0 { 1.0 / x2 } else { x2 };
        }
        // x and y are nonzero and finite.
        if ix >> 63 != 0 {
            // Finite x < 0.
            let yint = checkint(iy);
            if yint == 0 {
                return f64::NAN; // __math_invalid: (x - x) / (x - x)
            }
            if yint == 1 {
                sign_bias = SIGN_BIAS;
            }
            ix &= 0x7fffffffffffffff;
            topx &= 0x7ff;
        }
        if (topy & 0x7ff).wrapping_sub(0x3be) >= 0x43e - 0x3be {
            // sign_bias is 0 here: y is not odd.
            if ix == ONE_BITS {
                return 1.0;
            }
            if (topy & 0x7ff) < 0x3be {
                // |y| < 2^-65: x^y ~= 1 + y·log(x).
                return if ix > ONE_BITS { 1.0 + y } else { 1.0 - y };
            }
            return if (ix > ONE_BITS) == (topy < 0x800) {
                oflow(0)
            } else {
                uflow(0)
            };
        }
        if topx == 0 {
            // A subnormal x, normalized so its exponent goes negative.
            ix = (x * f(0x4330000000000000)).to_bits(); // 0x1p52
            ix &= 0x7fffffffffffffff;
            ix = ix.wrapping_sub(52u64 << 52);
        }
    }
    let (hi, lo) = log_inline(ix);
    let yhi = f(iy & (u64::MAX << 27));
    let ylo = y - yhi;
    let lhi = f(hi.to_bits() & (u64::MAX << 27));
    let llo = hi - lhi + lo;
    let ehi = yhi * lhi;
    let elo = ylo * lhi + y * llo; // |elo| < |ehi| · 2^-25
    exp_inline(ehi, elo, sign_bias)
}

/// `pow(x, y)` as the engine computes it: fdlibm's exact shortcuts, then ARM's algorithm.
#[inline]
pub fn pow(x: f64, y: f64) -> f64 {
    if y == 1.0 {
        return x;
    }
    if y == 2.0 {
        return x * x;
    }
    if y == -1.0 {
        return 1.0 / x;
    }
    if y == 0.5 && x.is_sign_positive() && !x.is_nan() {
        return libm::sqrt(x);
    }
    arm_pow(x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `pow_vectors.txt`: x, y and the C source's answer, as bits, one case a line.
    #[test]
    fn the_same_bits_as_the_c_source() {
        let text = include_str!("pow_vectors.txt");
        let mut n = 0;
        for line in text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
            let v: Vec<u64> = line
                .split_whitespace()
                .map(|h| u64::from_str_radix(h, 16).expect("hex"))
                .collect();
            let (x, y, want) = (f64::from_bits(v[0]), f64::from_bits(v[1]), v[2]);
            let got = arm_pow(x, y).to_bits();
            let same = got == want || (f64::from_bits(got).is_nan() && f64::from_bits(want).is_nan());
            assert!(same, "pow({x:e}, {y:e}): {got:016x}, the C source {want:016x}");
            n += 1;
        }
        assert!(n > 1000, "{n} vectors");
    }

    #[test]
    fn the_shortcuts_are_fdlibms() {
        for x in [0.3, 1.7, -2.5, 1e-300, 1e300, f64::INFINITY, -0.0, 0.0] {
            assert_eq!(pow(x, 2.0).to_bits(), (x * x).to_bits());
            assert_eq!(pow(x, 1.0).to_bits(), x.to_bits());
            assert_eq!(pow(x, -1.0).to_bits(), (1.0 / x).to_bits());
            assert_eq!(pow(x, 2.0).to_bits(), libm::pow(x, 2.0).to_bits());
            // A NaN's sign is the hardware's (x86 makes negative ones); to JavaScript NaN is NaN.
            let (a, b) = (pow(x, 0.5), libm::pow(x, 0.5));
            assert!(
                a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan()),
                "{x}: {a} against {b}"
            );
        }
        assert_eq!(pow(-0.0, 0.5).to_bits(), 0.0f64.to_bits());
        assert!(pow(f64::NAN, 0.5).is_nan());
    }

    #[test]
    fn within_an_ulp_of_fdlibm_on_the_engines_domains() {
        let mut r = crate::random::Rng::new(5);
        for _ in 0..200_000 {
            let x = 3.0 * r.next();
            let y = [3.0, 4.0, 5.5, 4.0 * r.next()][(r.next() * 4.0) as usize];
            let (a, b) = (pow(x, y), libm::pow(x, y));
            let ulps = (a.to_bits() as i64 - b.to_bits() as i64).abs();
            assert!(ulps <= 1, "pow({x}, {y}): {a:e} against {b:e}");
        }
    }
}

//! JavaScript's number conversions and spellings: `>>> 0`, `| 0`, `String(x)`, `JSON.stringify`
//! and `toFixed`, so keys and results read the same as the TypeScript engine's.

/// `x >>> 0`: ECMAScript ToUint32 (NaN and ±Infinity are 0; otherwise truncate, then modulo 2^32).
pub fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    let m = t - libm::floor(t / 4_294_967_296.0) * 4_294_967_296.0;
    // Every step is exact: the division and product are by a power of two, and the difference
    // is an integer in [0, 2^32), which a double holds. So m is t modulo 2^32.
    m as u32
}

/// `x | 0`: ECMAScript ToInt32.
pub fn to_int32(x: f64) -> i32 {
    to_uint32(x) as i32
}

/// `String(x)` for a number: ECMAScript Number::toString, the shortest digits that read back
/// as `x` ("0.1", "1e+21", "5e-324", "-0" spelled "0", "NaN", "Infinity").
pub fn number_to_string(x: f64) -> String {
    let mut b = ryu_js::Buffer::new();
    b.format(x).to_owned()
}

/// A number as `JSON.stringify` writes it: `String(x)` for a finite x, `null` otherwise.
pub fn json_number(x: f64) -> String {
    if x.is_finite() {
        number_to_string(x)
    } else {
        "null".to_owned()
    }
}

/// Writes `s` as `JSON.stringify` writes a string, quotes included: `"` and `\` escaped, the
/// control characters as `\b \t \n \f \r` or `\u00xx`, everything else (U+2028 too) as itself.
pub fn json_string_into(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                out.push_str("\\u00");
                out.push(HEX[(c as usize) >> 4] as char);
                out.push(HEX[(c as usize) & 15] as char);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `JSON.stringify(s)` for a string.
pub fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    json_string_into(&mut out, s);
    out
}

/// `x.toFixed(digits)` for `digits` in 0..=20: the decimal with `digits` places nearest the
/// double's exact value, ties to the larger magnitude, a "-" for any x below zero (so a tiny
/// negative is "-0.0000000"), and `String(x)` from 1e21 up.
///
/// Rust's `format!("{:.7}")` is not this: it takes exact ties to even (`0.00390625` is
/// "0.0039062" there and "0.0039063" in JavaScript).
pub fn to_fixed(x: f64, digits: u32) -> String {
    assert!(digits <= 20, "toFixed digits {digits}: only 0..=20 are supported");
    if x.is_nan() {
        return "NaN".to_owned();
    }
    let neg = x < 0.0;
    let a = x.abs();
    if a >= 1e21 {
        return number_to_string(x);
    }
    let bits = a.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    let (m, e) = if biased == 0 {
        (frac, -1074)
    } else {
        (frac | (1u64 << 52), biased - 1075)
    };
    // a = m * 2^e exactly. n = a * 10^digits rounded half up, in integers.
    let n: u128 = if e >= 0 {
        // An integer below 1e21: no fraction to round, and 10^digits would overflow u128.
        let int = (m as u128) << e;
        let mut s = int.to_string();
        if digits > 0 {
            s.push('.');
            s.extend(std::iter::repeat_n('0', digits as usize));
        }
        return if neg { format!("-{s}") } else { s };
    } else {
        let p = (m as u128) * 10u128.pow(digits); // < 2^53 * 10^20 < 2^120
        let shift = (-e) as u32;
        if shift >= 128 {
            0 // p < 2^120 < half of 2^shift
        } else {
            let q = p >> shift;
            let rem = p & ((1u128 << shift) - 1);
            if rem >= (1u128 << (shift - 1)) {
                q + 1
            } else {
                q
            }
        }
    };
    let mut s = n.to_string();
    if digits > 0 {
        let d = digits as usize;
        if s.len() <= d {
            s = format!("{}{s}", "0".repeat(d + 1 - s.len()));
        }
        s.insert(s.len() - d, '.');
    }
    if neg {
        format!("-{s}")
    } else {
        s
    }
}

/// True if `key` is an array index ("0", "17", up to "4294967294", no leading zeros): the keys a
/// JavaScript object lists first, in ascending order, before its other keys in insertion order.
pub fn is_array_index(key: &str) -> bool {
    let b = key.as_bytes();
    if b.is_empty() || b.len() > 10 || !b.iter().all(u8::is_ascii_digit) || (b.len() > 1 && b[0] == b'0') {
        return false;
    }
    key.parse::<u64>().is_ok_and(|n| n < u64::from(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_uint32_is_ecmascripts() {
        assert_eq!(to_uint32(f64::NAN), 0);
        assert_eq!(to_uint32(f64::INFINITY), 0);
        assert_eq!(to_uint32(-1.0), u32::MAX);
        assert_eq!(to_uint32(-1.9), u32::MAX);
        assert_eq!(to_uint32(4_294_967_297.5), 1);
        assert_eq!(to_uint32(-4_294_967_297.0), u32::MAX);
        assert_eq!(to_uint32(2f64.powi(60) + 2f64.powi(12)), 4096);
        assert_eq!(to_uint32(-0.0), 0);
        assert_eq!(to_int32(2_147_483_648.0), i32::MIN);
    }

    #[test]
    fn numbers_spell_as_in_javascript() {
        let cases = [
            (0.1, "0.1"),
            (-0.0, "0"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (37.4545012, "37.4545012"),
            (-122.1823456, "-122.1823456"),
            (123456789012345680000.0, "123456789012345680000"),
            (f64::NAN, "NaN"),
            (f64::NEG_INFINITY, "-Infinity"),
        ];
        for (x, want) in cases {
            assert_eq!(number_to_string(x), want, "String({x:e})");
        }
        assert_eq!(json_number(f64::NAN), "null");
        assert_eq!(json_number(f64::INFINITY), "null");
        assert_eq!(json_number(-0.0), "0");
    }

    #[test]
    fn strings_escape_as_json_stringify() {
        assert_eq!(
            json_string("a\"b\\c\n\u{1}\u{1f}\u{2028}é🚗"),
            "\"a\\\"b\\\\c\\n\\u0001\\u001f\u{2028}é🚗\""
        );
    }

    #[test]
    fn to_fixed_rounds_the_exact_value_ties_up() {
        let cases = [
            (37.4545012, 7, "37.4545012"),
            (-122.1823456, 7, "-122.1823456"),
            (0.00390625, 7, "0.0039063"), // an exact tie: JavaScript takes the larger n
            (-0.00390625, 7, "-0.0039063"),
            (1.005, 2, "1.00"), // 1.005 is 1.00499999999999989...
            (2.5, 0, "3"),
            (-2.5, 0, "-3"),
            (-1e-9, 7, "-0.0000000"),
            (-0.0, 7, "0.0000000"),
            (0.0, 0, "0"),
            (5e-324, 7, "0.0000000"),
            (123.0, 3, "123.000"),
            (1e20, 2, "100000000000000000000.00"),
            (1e21, 7, "1e+21"),
            (-1e21, 7, "-1e+21"),
            (f64::INFINITY, 7, "Infinity"),
            (f64::NAN, 7, "NaN"),
            (0.5, 20, "0.50000000000000000000"),
        ];
        for (x, d, want) in cases {
            assert_eq!(to_fixed(x, d), want, "({x:e}).toFixed({d})");
        }
    }

    #[test]
    fn array_indexes_are_canonical_u32s_below_the_max() {
        for k in ["0", "7", "10", "4294967294"] {
            assert!(is_array_index(k), "{k}");
        }
        for k in ["", "01", "-1", "1.5", "4294967295", "99999999999", "x", " 1"] {
            assert!(!is_array_index(k), "{k}");
        }
    }
}

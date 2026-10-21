//! The engine's street-name shortenings: `name.replace(/\bAvenue\b/, "Ave")` and the rest, each
//! replacing the first whole-word occurrence, with JavaScript's ASCII `\b`.

#[inline]
fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `s.replace(/\bword\b/, to)` for a word of ASCII word characters: the first occurrence with a
/// non-word character (or the string's end) on each side. Non-ASCII characters are non-word
/// characters, as in a JavaScript regular expression without the `u` flag.
pub fn replace_word_first(s: &str, word: &str, to: &str) -> String {
    let b = s.as_bytes();
    let w = word.as_bytes();
    let mut from = 0;
    while let Some(off) = s[from..].find(word) {
        let i = from + off;
        let before = i == 0 || !is_word_byte(b[i - 1]);
        let j = i + w.len();
        let after = j == b.len() || !is_word_byte(b[j]);
        if before && after {
            let mut out = String::with_capacity(s.len());
            out.push_str(&s[..i]);
            out.push_str(to);
            out.push_str(&s[j..]);
            return out;
        }
        from = i + 1;
        while !s.is_char_boundary(from) {
            from += 1;
        }
    }
    s.to_owned()
}

/// The seven shortenings `intersection.ts`'s `short` and `describe.ts`'s `viaNames` make.
const SEVEN: [(&str, &str); 7] = [
    ("Avenue", "Ave"),
    ("Expressway", "Expy"),
    ("Boulevard", "Blvd"),
    ("Lane", "Ln"),
    ("Road", "Rd"),
    ("Street", "St"),
    ("Drive", "Dr"),
];

/// `short` (intersection.ts) and the `viaNames` map.
pub fn short(name: &str) -> String {
    let mut s = name.to_owned();
    for (w, t) in SEVEN {
        s = replace_word_first(&s, w, t);
    }
    s
}

/// `shortName` (maneuvers.ts): the seven, then Court and Place.
pub fn short_name(name: &str) -> String {
    let mut s = short(name);
    for (w, t) in [("Court", "Ct"), ("Place", "Pl")] {
        s = replace_word_first(&s, w, t);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_whole_words_and_only_the_first() {
        assert_eq!(short("Oak Avenue"), "Oak Ave");
        assert_eq!(short("Avenue of the Avenues Avenue"), "Ave of the Avenues Avenue");
        assert_eq!(short("Driveway Drive"), "Driveway Dr");
        assert_eq!(short("Lane-Road Street"), "Ln-Rd St");
        assert_eq!(short("_Avenue"), "_Avenue");
        assert_eq!(short("éAvenue"), "éAve");
        assert_eq!(short_name("Birch Court"), "Birch Ct");
        assert_eq!(short_name("Lincoln Place"), "Lincoln Pl");
        assert_eq!(short(""), "");
    }
}

//! A small JSON writer that spells everything as `JSON.stringify` does: numbers through
//! `ryu-js` (NaN and ±Infinity as null, -0 as 0), strings with its escapes, and object keys in
//! the order the caller writes them (the TypeScript's object-literal order).

use crate::jsnum::json_string_into;

pub struct Json {
    pub out: String,
    /// For each open object or array: whether it has no member yet.
    empty: Vec<bool>,
    /// A key was just written: the value that follows takes no comma.
    after_key: bool,
}

impl Default for Json {
    fn default() -> Self {
        Self::new()
    }
}

impl Json {
    pub fn new() -> Self {
        Json {
            out: String::with_capacity(1 << 16),
            empty: Vec::new(),
            after_key: false,
        }
    }

    /// Before a member of the innermost object or array: a comma unless it is the first.
    #[inline]
    fn member(&mut self) {
        if let Some(e) = self.empty.last_mut() {
            if *e {
                *e = false;
            } else {
                self.out.push(',');
            }
        }
    }

    #[inline]
    fn value(&mut self) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.member();
        }
    }

    pub fn obj(&mut self) -> &mut Self {
        self.value();
        self.out.push('{');
        self.empty.push(true);
        self
    }

    pub fn arr(&mut self) -> &mut Self {
        self.value();
        self.out.push('[');
        self.empty.push(true);
        self
    }

    pub fn end_obj(&mut self) -> &mut Self {
        self.empty.pop();
        self.out.push('}');
        self
    }

    pub fn end_arr(&mut self) -> &mut Self {
        self.empty.pop();
        self.out.push(']');
        self
    }

    /// An object key (plain ASCII, needing no escape); its value is written next.
    pub fn key(&mut self, k: &str) -> &mut Self {
        self.member();
        self.out.push('"');
        self.out.push_str(k);
        self.out.push_str("\":");
        self.after_key = true;
        self
    }

    pub fn num(&mut self, x: f64) -> &mut Self {
        self.value();
        if x.is_finite() {
            let mut b = ryu_js::Buffer::new();
            self.out.push_str(b.format(x));
        } else {
            self.out.push_str("null");
        }
        self
    }

    pub fn str(&mut self, s: &str) -> &mut Self {
        self.value();
        json_string_into(&mut self.out, s);
        self
    }

    pub fn bool(&mut self, b: bool) -> &mut Self {
        self.value();
        self.out.push_str(if b { "true" } else { "false" });
        self
    }

    pub fn null(&mut self) -> &mut Self {
        self.value();
        self.out.push_str("null");
        self
    }

    pub fn opt_num(&mut self, x: Option<f64>) -> &mut Self {
        match x {
            Some(x) => self.num(x),
            None => self.null(),
        }
    }

    pub fn opt_str(&mut self, s: Option<&str>) -> &mut Self {
        match s {
            Some(s) => self.str(s),
            None => self.null(),
        }
    }

    pub fn nums(&mut self, xs: &[f64]) -> &mut Self {
        self.arr();
        for &x in xs {
            self.num(x);
        }
        self.end_arr()
    }

    pub fn strs<S: AsRef<str>>(&mut self, xs: &[S]) -> &mut Self {
        self.arr();
        for x in xs {
            self.str(x.as_ref());
        }
        self.end_arr()
    }

    pub fn pairs(&mut self, xs: &[[f64; 2]]) -> &mut Self {
        self.arr();
        for p in xs {
            self.arr().num(p[0]).num(p[1]).end_arr();
        }
        self.end_arr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_as_json_stringify_does() {
        let mut j = Json::new();
        j.obj()
            .key("a")
            .num(-0.0)
            .key("b")
            .arr()
            .num(f64::NAN)
            .num(0.1)
            .obj()
            .end_obj()
            .end_arr()
            .key("c")
            .str("x\"y")
            .key("d")
            .null()
            .key("e")
            .bool(true)
            .key("f")
            .pairs(&[[1.0, 2.5], [1e21, 5e-324]])
            .end_obj();
        assert_eq!(
            j.out,
            r#"{"a":0,"b":[null,0.1,{}],"c":"x\"y","d":null,"e":true,"f":[[1,2.5],[1e+21,5e-324]]}"#
        );
    }
}

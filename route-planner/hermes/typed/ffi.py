# ffi.py tuned.js tuned-ffi.js: the tuned port with its PRIMS (JS's bit operators and the Math
# functions it calls) as direct C calls through shermes -typed's FFI ($SHBuiltin.extern_c):
# jsops.h for the operators (with JS semantics: the FFI passes c_int arguments through
# ToInt32), math.h for the libm functions Hermes' Math builtins themselves call.
# Each call site names the extern itself: an extern held in a const is reached from other
# functions through the closure environment, as an indirect call the C compiler cannot inline.
import re, sys
s = open(sys.argv[1]).read()
a = s.index("// PRIMS-BEGIN"); b = s.index("// PRIMS-END")
ii = "a: c_int, b: c_int"
d = "x: c_double"
PRIMS = {
    "xor32": ("js_xor", ii, "c_int", "jsops.h"),
    "or32": ("js_or", ii, "c_int", "jsops.h"),
    "ushr": ("js_ushr", ii, "c_uint", "jsops.h"),
    "shr": ("js_shr", ii, "c_int", "jsops.h"),
    "imul": ("js_imul", ii, "c_int", "jsops.h"),
    "exp": ("exp", d, "c_double", "math.h"),
    "expm1": ("expm1", d, "c_double", "math.h"),
    "log": ("log", d, "c_double", "math.h"),
    "cos": ("cos", d, "c_double", "math.h"),
    "floor": ("floor", d, "c_double", "math.h"),
    "pow": ("pow", "x: c_double, y: c_double", "c_double", "math.h"),
}
body = s[:a] + "// PRIMS (ffi.py): each call below is a C call through the FFI.\n" + s[b:]
n = 0
for js, (c, ps, ret, inc) in PRIMS.items():
    ext = f'$SHBuiltin.extern_c({{include: "{inc}"}}, function {c}({ps}): {ret} {{ throw 0; }})('
    body, k = re.subn(rf"(?<![\w.$]){js}\(", lambda m: ext, body)
    n += k
print(f"{n} call sites", file=sys.stderr)
open(sys.argv[2], "w").write(body)

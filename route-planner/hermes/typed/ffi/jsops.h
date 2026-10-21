// JS's bitwise operators and Math.imul with JS semantics, for shermes -typed's FFI:
// the arguments arrive through ToInt32 (_sh_to_int32_double), so these match `a ^ b` etc. exactly.
#include <stdint.h>
#include <math.h>
static inline int32_t js_xor(int32_t a, int32_t b) { return a ^ b; }
static inline int32_t js_or(int32_t a, int32_t b) { return a | b; }
static inline int32_t js_and(int32_t a, int32_t b) { return a & b; }
static inline int32_t js_shr(int32_t a, int32_t b) { return a >> (b & 31); }
static inline uint32_t js_ushr(int32_t a, int32_t b) { return (uint32_t)a >> (b & 31); }
static inline int32_t js_imul(int32_t a, int32_t b) { return (int32_t)((uint32_t)a * (uint32_t)b); }

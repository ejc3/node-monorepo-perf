// A seeded generator: the engine never calls Math.random, so a simulation is repeatable.

export interface Rng {
  next(): number; // [0, 1)
  uniform(a: number, b: number): number;
  exponential(rate: number): number;
  normal(): number;
  /** Failures before the first success, success probability 1 - p: mean p / (1 - p). */
  geometric(p: number): number;
}

export function rng(seed: number): Rng {
  let s = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    uniform: (a, b) => a + (b - a) * next(),
    exponential: (rate) => -Math.log(1 - next()) / rate,
    normal: () => {
      const u = 1 - next(), v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    geometric: (p) => (p <= 0 ? 0 : Math.floor(Math.log(1 - next()) / Math.log(p))),
  };
}

/** A stable 32-bit hash of a string, for seeding per-movement streams. */
export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

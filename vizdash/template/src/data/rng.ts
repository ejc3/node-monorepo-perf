// Deterministic pseudo-random numbers. Every number a page shows is a function of the
// page's seed, its scope and the request's filters, so a dashboard renders the same
// data on every request and in every build.

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  next(): number;
  int(lo: number, hi: number): number;
  range(lo: number, hi: number): number;
  normal(mean?: number, sd?: number): number;
  lognormal(mu: number, sigma: number): number;
  chance(p: number): boolean;
  pick<T>(xs: readonly T[]): T;
  weights(n: number, skew?: number): number[];
  shuffle<T>(xs: readonly T[]): T[];
}

export function rng(...parts: (string | number)[]): Rng {
  const next = mulberry32(hashString(parts.join("␟")));
  const normal = (mean = 0, sd = 1) => {
    // Box-Muller; 1 - u keeps log() away from 0
    const u = 1 - next();
    const v = next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    range: (lo, hi) => lo + next() * (hi - lo),
    normal,
    lognormal: (mu, sigma) => Math.exp(normal(mu, sigma)),
    chance: (p) => next() < p,
    pick: (xs) => xs[Math.floor(next() * xs.length)],
    // n positive weights summing to 1, earlier ones larger (a long tail)
    weights: (n, skew = 1.1) => {
      const raw = Array.from({ length: n }, (_, i) => (0.6 + next()) / Math.pow(i + 1, skew));
      const total = raw.reduce((a, b) => a + b, 0);
      return raw.map((w) => w / total);
    },
    shuffle: (xs) => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

import { scaleDiverging, scaleQuantize, scaleSequential } from "d3-scale";
import {
  interpolateBlues,
  interpolateGreens,
  interpolateOranges,
  interpolatePurples,
  interpolateRdYlGn,
  interpolateViridis,
  schemeBlues,
} from "d3-scale-chromatic";
import { interpolateLab } from "d3-interpolate";

export type Scheme = "blues" | "greens" | "oranges" | "purples" | "viridis";

const INTERPOLATORS: Record<Scheme, (t: number) => string> = {
  blues: interpolateBlues,
  greens: interpolateGreens,
  oranges: interpolateOranges,
  purples: interpolatePurples,
  viridis: interpolateViridis,
};

/** value in [lo, hi] -> color; the bottom 12% of the ramp is skipped (too pale on white). */
export function sequential(
  lo: number,
  hi: number,
  scheme: Scheme = "blues",
): (v: number) => string {
  const f = INTERPOLATORS[scheme];
  return scaleSequential((t: number) => f(0.12 + 0.88 * t)).domain([lo, hi || 1]);
}

/** Change values colored red (bad) to green (good) around zero. */
export function diverging(extent: number, goodIsUp = true): (v: number) => string {
  const s = scaleDiverging(interpolateRdYlGn).domain([-extent, 0, extent]);
  return (v) => s(goodIsUp ? v : -v);
}

/** Five discrete steps, for legends that need countable buckets. */
export function quantized(lo: number, hi: number): (v: number) => string {
  return scaleQuantize<string>().domain([lo, hi]).range(schemeBlues[5]);
}

/** A two-color ramp in Lab space (e.g. from an area accent to white). */
export function ramp(from: string, to: string): (t: number) => string {
  return interpolateLab(from, to);
}

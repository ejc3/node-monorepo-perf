import { format } from "d3-format";

const full = format(",.0f");
const fixed1 = format(",.1f");
const si = format(".3~s");

/** SI suffixes read as finance does: thousand K, million M, billion B. */
export function compactSuffix(s: string): string {
  return s.replace(/G$/, "B").replace(/k$/, "K");
}

export function formatNumber(v: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(v)) return "–";
  if (opts.compact && Math.abs(v) >= 10_000) return compactSuffix(si(v));
  return Math.abs(v) < 10 && !Number.isInteger(v) ? fixed1(v) : full(v);
}

export function formatRatio(v: number): string {
  return Number.isFinite(v) ? `${fixed1(v)}×` : "–";
}

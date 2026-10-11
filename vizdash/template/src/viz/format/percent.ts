import { format } from "d3-format";

const pct1 = format(".1%");
const pct0 = format(".0%");
const signed = format("+.1%");

export function formatPercent(v: number, opts: { precise?: boolean } = {}): string {
  if (!Number.isFinite(v)) return "–";
  // near 0 and near 100% the first decimal is the information (0.4% errors, 99.9% uptime)
  return opts.precise || Math.abs(v) < 0.1 || v > 0.95 ? pct1(v) : pct0(v);
}

/** A period-over-period change, always signed: +4.2%, −1.0%. */
export function formatDelta(v: number): string {
  if (!Number.isFinite(v)) return "–";
  return signed(v).replace("-", "−");
}

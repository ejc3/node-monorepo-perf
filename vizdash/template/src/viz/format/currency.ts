import { format, formatLocale } from "d3-format";
import { compactSuffix } from "./number";

const usd = formatLocale({ decimal: ".", thousands: ",", grouping: [3], currency: ["$", ""] });
const whole = usd.format("$,.0f");
const cents = usd.format("$,.2f");
const si = format(".3~s");

export function formatCurrency(v: number, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(v)) return "–";
  if (opts.compact && Math.abs(v) >= 10_000) {
    const s = compactSuffix(si(Math.abs(v)));
    return `${v < 0 ? "−" : ""}$${s}`;
  }
  return Math.abs(v) < 100 ? cents(v) : whole(v);
}

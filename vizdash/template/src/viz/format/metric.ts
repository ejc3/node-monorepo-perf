import { format } from "d3-format";
import type { Unit } from "@/data/types";
import { formatBytes } from "./bytes";
import { formatCurrency } from "./currency";
import { formatDays, formatDuration } from "./duration";
import { formatNumber, formatRatio } from "./number";
import { formatPercent } from "./percent";

/** A metric value in its unit; `compact` for axes, tiles and tight cells. */
export function formatMetric(v: number, unit: Unit, opts: { compact?: boolean } = {}): string {
  switch (unit) {
    case "currency":
      return formatCurrency(v, opts);
    case "percent":
      return formatPercent(v, { precise: !opts.compact });
    case "duration":
      return formatDuration(v);
    case "days":
      return formatDays(v);
    case "bytes":
      return formatBytes(v);
    case "ratio":
      return formatRatio(v);
    case "count":
    case "number":
      return formatNumber(v, opts);
  }
}

// axis ticks of a zoomed rate axis are a point apart: keep one decimal, trim ".0"
const ratePct = format(".1~%");

export function axisFormatter(unit: Unit): (v: number) => string {
  if (unit === "percent") return (v) => ratePct(v);
  return (v) => formatMetric(v, unit, { compact: true });
}

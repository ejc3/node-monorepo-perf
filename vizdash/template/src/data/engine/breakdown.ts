import { orderBy, sumBy } from "lodash-es";
import { rng } from "../rng";
import type {
  BreakdownResult,
  BreakdownRow,
  DimensionDef,
  MetricDef,
  QueryContext,
} from "../types";
import { aggregate, dailyValues, intervalOf, jitterRate, streamKey } from "./model";

/** The metric over the selected range, split by the values of one dimension. */
export function breakdown(
  ctx: QueryContext,
  metric: MetricDef,
  dim: DimensionDef,
  opts: { top?: number; sort?: "value" | "natural" } = {},
): BreakdownResult {
  const r = rng(...streamKey(ctx, "breakdown", dim.key, metric.key));
  const weights = r.weights(dim.values.length, 0.9);
  const order = r.shuffle(dim.values.map((_, i) => i));
  const total = aggregate(metric, dailyValues(ctx, metric, intervalOf(ctx), "total"));
  const rows = order.map((vi, rank) => {
    const value =
      metric.agg === "sum"
        ? total * weights[rank]
        : metric.unit === "percent"
          ? jitterRate(total, r.normal(0, 0.6))
          : total * (0.75 + r.next() * 0.5);
    return {
      key: dim.values[vi].toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      label: dim.values[vi],
      value,
      share: 0,
      delta: r.normal(0.03, 0.11),
      natural: vi,
    };
  });
  const sum = sumBy(rows, "value") || 1;
  for (const row of rows) row.share = row.value / sum;
  const sorted =
    opts.sort === "natural"
      ? orderBy(rows, ["natural"], ["asc"])
      : orderBy(rows, ["value"], ["desc"]);
  const top = opts.top ?? sorted.length;
  const shown: BreakdownRow[] = sorted.slice(0, top).map(({ natural: _, ...row }) => row);
  // totals of the values left out are one "Other" row, so shares add up to 100%
  if (metric.agg === "sum" && top < sorted.length) {
    const rest = sorted.slice(top);
    const value = sumBy(rest, "value");
    shown.push({
      // a key no dimension value slugs to (a real "Other" value has key "other")
      key: "__rest",
      label: `Other (${rest.length})`,
      value,
      share: value / sum,
      delta: sumBy(rest, (r) => r.value * r.delta) / (value || 1),
      remainder: true,
    });
  }
  return {
    rows: shown,
    unit: metric.unit,
    total: metric.agg === "sum" ? sum : total,
    agg: metric.agg,
  };
}

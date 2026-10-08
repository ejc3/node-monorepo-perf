import { orderBy, sumBy } from "lodash-es";
import { rng } from "../rng";
import type { BreakdownResult, DimensionDef, MetricDef, QueryContext } from "../types";
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
  return {
    rows: sorted.slice(0, opts.top ?? sorted.length).map(({ natural: _, ...row }) => row),
    unit: metric.unit,
    total: metric.agg === "sum" ? sum : total,
  };
}

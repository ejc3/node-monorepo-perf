import { subDays } from "date-fns";
import { ANCHOR, isoDay, previousInterval } from "../calendar";
import type { DailyPoint, GoalResult, Kpi, MetricDef, QueryContext } from "../types";
import { aggregate, bucketValues, dailyValues, intervalOf } from "./model";

/** Headline numbers: the metric over the range, the previous range, and a sparkline. */
export function kpis(ctx: QueryContext, metrics: readonly MetricDef[]): Kpi[] {
  const iv = intervalOf(ctx);
  const prevIv = previousInterval(iv);
  const sparkGrain = ctx.filters.range === "7d" || ctx.filters.range === "30d" ? "day" : "week";
  return metrics.map((m) => {
    const value = aggregate(m, dailyValues(ctx, m, iv, "kpi"));
    const previous = aggregate(m, dailyValues(ctx, m, prevIv, "kpi"));
    return {
      key: m.key,
      label: m.label,
      unit: m.unit,
      value,
      previous,
      delta: previous ? value / previous - 1 : 0,
      good: m.good,
      spark: bucketValues(ctx, m, iv, sparkGrain, "kpi").values,
    };
  });
}

/** One value per day over the last year, for a calendar heatmap. */
export function daily(ctx: QueryContext, metric: MetricDef, days = 365): DailyPoint[] {
  const iv = { start: subDays(ANCHOR, days - 1), end: ANCHOR };
  const values = dailyValues(ctx, metric, iv, "daily");
  return values.map((value, i) => ({ date: isoDay(subDays(ANCHOR, days - 1 - i)), value }));
}

/** The metric over the range against a target of `factor` x the previous range. */
export function goal(ctx: QueryContext, metric: MetricDef, factor: number): GoalResult {
  const [k] = kpis(ctx, [metric]);
  return {
    value: k.value,
    target: k.previous * factor,
    unit: metric.unit,
    label: metric.label,
    good: metric.good,
  };
}

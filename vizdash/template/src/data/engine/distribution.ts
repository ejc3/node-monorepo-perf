import { deviation, mean, median, quantileSorted } from "d3-array";
import { sortBy } from "lodash-es";
import { rng } from "../rng";
import type {
  DimensionDef,
  DistributionResult,
  GroupedDistribution,
  MetricDef,
  QueryContext,
} from "../types";
import { jitterRate, streamKey } from "./model";

function samples(
  ctx: QueryContext,
  metric: MetricDef,
  n: number,
  stream: string,
  shift = 0,
): number[] {
  const r = rng(...streamKey(ctx, "dist", metric.key, stream));
  const sigma = 0.35 + metric.noise * 2;
  const mu = Math.log(Math.max(metric.base, 1e-6)) + shift;
  if (metric.unit === "percent")
    return Array.from({ length: n }, () => jitterRate(metric.base, r.normal(shift * 4, 0.9)));
  return Array.from({ length: n }, () => r.lognormal(mu, sigma));
}

/** Per-item values of the metric (e.g. deal sizes, response times) with summary stats. */
export function distribution(ctx: QueryContext, metric: MetricDef, n = 400): DistributionResult {
  const values = sortBy(samples(ctx, metric, n, "all"));
  return {
    values,
    unit: metric.unit,
    mean: mean(values) ?? 0,
    median: median(values) ?? 0,
    p90: quantileSorted(values, 0.9) ?? 0,
    stdev: deviation(values) ?? 0,
  };
}

/** The same per-item values, one group per value of a dimension (for box plots). */
export function groupedDistribution(
  ctx: QueryContext,
  metric: MetricDef,
  dim: DimensionDef,
  n = 120,
): GroupedDistribution {
  const r = rng(...streamKey(ctx, "dist-shift", metric.key, dim.key));
  return {
    groups: dim.values.map((group) => ({
      group,
      values: sortBy(samples(ctx, metric, n, group, r.normal(0, 0.25))),
    })),
    unit: metric.unit,
  };
}

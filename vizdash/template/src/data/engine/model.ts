// The synthetic data model: each metric is a daily series with a trend, a yearly cycle,
// a weekly cycle (sums only) and noise; a dashboard's scope and the request's segment
// and region filters scale it down to their slice.

import { clamp } from "lodash-es";
import {
  buckets,
  daysOf,
  isoDay,
  rangeInterval,
  weekdayFactor,
  yearPhase,
  yearsFromAnchor,
} from "../calendar";
import type { Bucket, Interval } from "../calendar";
import { hashString, rng } from "../rng";
import type { Grain, MetricDef, QueryContext } from "../types";

/** Share of the whole that a scope value or filter value stands for, in (0.08, 0.6). */
function sliceShare(dim: string, value: string): number {
  return 0.08 + ((hashString(`${dim}=${value}`) % 1000) / 1000) * 0.52;
}

/**
 * A rate moved by `z` standard steps, where a step shrinks toward 0 and 1 (a 93% SLA
 * varies by a few points, a 3% conversion rate by fractions of one).
 */
export function jitterRate(base: number, z: number): number {
  return clamp(base + Math.min(base, 1 - base) * 0.5 * z, 0.0005, 0.9995);
}

/** Multiplier for sums under the context's scope and filters. */
export function sliceLevel(ctx: QueryContext): number {
  let level = 1;
  for (const [dim, value] of Object.entries(ctx.scope ?? {})) level *= sliceShare(dim, value);
  if (ctx.filters.segment) level *= sliceShare("segment", ctx.filters.segment);
  if (ctx.filters.region) level *= sliceShare("region", ctx.filters.region);
  // a scope is a small slice of a large business; keep its sums in a readable range,
  // and below the whole business's
  return Object.keys(ctx.scope ?? {}).length ? Math.min(Math.max(level * 4, 0.02), 0.9) : level;
}

export function streamKey(ctx: QueryContext, ...parts: (string | number)[]): (string | number)[] {
  const scope = Object.entries(ctx.scope ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return [ctx.seed, scope, ctx.filters.segment ?? "", ctx.filters.region ?? "", ...parts];
}

/** One value per day of `iv` for `metric`, at relative size `weight`. */
export function dailyValues(
  ctx: QueryContext,
  metric: MetricDef,
  iv: Interval,
  stream: string,
  weight = 1,
): number[] {
  // seeded by the calendar day, not the instant: the same on hosts in any time zone
  const r = rng(...streamKey(ctx, metric.key, stream, isoDay(iv.start)));
  const phase = (hashString(metric.key) % 360) / 360;
  const level = metric.agg === "sum" ? sliceLevel(ctx) * weight : 1;
  // averages differ a little between slices (not in proportion to their size), the same
  // in every interval, so the previous period compares like with like
  const slice = rng(...streamKey(ctx, metric.key, stream, "offset"));
  const spread = metric.unit === "percent" ? 0.015 : 0.06;
  const offset = metric.agg === "avg" ? 1 + slice.normal(0, spread) + (weight - 1) * spread : 1;
  return daysOf(iv).map((day) => {
    const trend = 1 + metric.trend * yearsFromAnchor(day);
    const season = 1 + metric.season * Math.sin(2 * Math.PI * (yearPhase(day) + phase));
    const weekly = metric.agg === "sum" ? weekdayFactor(day) : 1;
    const noise = Math.max(0.1, 1 + r.normal(0, metric.noise));
    const v = metric.base * level * offset * trend * season * weekly * noise;
    return metric.unit === "percent" ? clamp(v, 0, 1) : Math.max(0, v);
  });
}

export function aggregate(metric: MetricDef, values: number[]): number {
  if (!values.length) return 0;
  const total = values.reduce((a, b) => a + b, 0);
  return metric.agg === "sum" ? total : total / values.length;
}

/** Bucketed values of `metric` over `iv` at `grain`. */
export function bucketValues(
  ctx: QueryContext,
  metric: MetricDef,
  iv: Interval,
  grain: Grain,
  stream: string,
  weight = 1,
): { buckets: Bucket[]; values: number[] } {
  const days = dailyValues(ctx, metric, iv, stream, weight);
  const bs = buckets(iv, grain);
  let i = 0;
  const values = bs.map((b) => {
    const slice = days.slice(i, i + b.days);
    i += b.days;
    return aggregate(metric, slice);
  });
  return { buckets: bs, values };
}

export function intervalOf(ctx: QueryContext): Interval {
  return rangeInterval(ctx.filters.range);
}

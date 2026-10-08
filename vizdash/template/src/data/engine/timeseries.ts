import { previousInterval } from "../calendar";
import { rng } from "../rng";
import type {
  DimensionDef,
  Grain,
  MetricDef,
  QueryContext,
  SeriesRow,
  TimeseriesResult,
} from "../types";
import { bucketValues, intervalOf, streamKey } from "./model";

export interface TimeseriesOptions {
  /** one series per value of this dimension (first metric only) */
  breakdown?: DimensionDef;
  /** keep this many breakdown values; the rest become "Other" */
  top?: number;
  /** running total instead of per-bucket values */
  cumulative?: boolean;
  grain?: Grain;
}

const running = (xs: number[]) => {
  let acc = 0;
  return xs.map((x) => (acc += x));
};

export function timeseries(
  ctx: QueryContext,
  metrics: MetricDef | readonly MetricDef[],
  opts: TimeseriesOptions = {},
): TimeseriesResult {
  const list = Array.isArray(metrics) ? (metrics as readonly MetricDef[]) : [metrics as MetricDef];
  const iv = intervalOf(ctx);
  const grain = opts.grain ?? ctx.filters.grain;
  const compare = ctx.filters.compare && !opts.breakdown;

  type Stream = { key: string; label: string; metric: MetricDef; weight: number };
  let streams: Stream[];
  if (opts.breakdown) {
    const metric = list[0];
    const dim = opts.breakdown;
    const r = rng(...streamKey(ctx, "breakdown", dim.key));
    const weights = r.weights(dim.values.length);
    const order = r.shuffle(dim.values.map((_, i) => i));
    const top = Math.min(opts.top ?? 6, dim.values.length);
    streams = order.slice(0, top).map((vi, rank) => ({
      key: `s${rank}`,
      label: dim.values[vi],
      metric,
      weight: weights[rank],
    }));
    if (top < dim.values.length && metric.agg === "sum") {
      const rest = weights.slice(top).reduce((a, b) => a + b, 0);
      streams.push({ key: "other", label: "Other", metric, weight: rest });
    }
  } else {
    streams = list.map((m) => ({ key: m.key, label: m.label, metric: m, weight: 1 }));
  }

  const columns = streams.map((s) => {
    const { buckets, values } = bucketValues(ctx, s.metric, iv, grain, s.key, s.weight);
    const prev = compare
      ? bucketValues(ctx, s.metric, previousInterval(iv), grain, s.key, s.weight).values
      : null;
    const fix = (xs: number[]) => (opts.cumulative && s.metric.agg === "sum" ? running(xs) : xs);
    return { s, buckets, values: fix(values), prev: prev && fix(prev) };
  });

  const bucketList = columns[0]?.buckets ?? [];
  const rows: SeriesRow[] = bucketList.map((b, i) => {
    const row: SeriesRow = { date: b.key };
    for (const c of columns) {
      row[c.s.key] = c.values[i];
      if (c.prev) row[`${c.s.key}__prev`] = c.prev[i] ?? 0;
    }
    return row;
  });

  return {
    rows,
    series: streams.map((s) => ({ key: s.key, label: s.label })),
    unit: list[0].unit,
    agg: list[0].agg,
    grain,
    compare,
  };
}

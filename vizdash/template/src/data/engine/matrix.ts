import { max } from "d3-array";
import { rng } from "../rng";
import type { DimensionDef, MatrixResult, MetricDef, QueryContext } from "../types";
import { aggregate, dailyValues, intervalOf, jitterRate, streamKey } from "./model";

// Activity by hour: a morning and an afternoon peak, quiet nights.
const hourProfile = (h: number) =>
  0.08 + Math.exp(-((h - 10.5) ** 2) / 6) + 0.85 * Math.exp(-((h - 15) ** 2) / 8);
const weekdayProfile = [1.05, 1.1, 1.08, 1.02, 0.94, 0.42, 0.36];

function profile(dim: DimensionDef, weights: number[], i: number): number {
  if (dim.key === "hour") return hourProfile(i);
  if (dim.key === "weekday") return weekdayProfile[i];
  return weights[i] * dim.values.length;
}

/** The metric over two dimensions at once (rows x columns). */
export function matrix(
  ctx: QueryContext,
  metric: MetricDef,
  rowsDim: DimensionDef,
  colsDim: DimensionDef,
): MatrixResult {
  const r = rng(...streamKey(ctx, "matrix", metric.key, rowsDim.key, colsDim.key));
  const rw = r.weights(rowsDim.values.length, 0.7);
  const cw = r.weights(colsDim.values.length, 0.7);
  const total = aggregate(metric, dailyValues(ctx, metric, intervalOf(ctx), "matrix"));
  const n = rowsDim.values.length * colsDim.values.length;
  const cells = rowsDim.values.map((_, i) =>
    colsDim.values.map((_, j) => {
      const shape = profile(rowsDim, rw, i) * profile(colsDim, cw, j);
      if (metric.unit === "percent")
        return jitterRate(total, (shape - 1) * 0.6 + r.normal(0, 0.25));
      const noise = Math.max(0.2, 1 + r.normal(0, 0.12));
      return metric.agg === "sum"
        ? (total / n) * shape * noise
        : total * (0.7 + 0.3 * shape) * noise;
    }),
  );
  return {
    rows: rowsDim.values,
    cols: colsDim.values,
    cells,
    unit: metric.unit,
    max: max(cells.flat()) ?? 0,
  };
}

import type { DimensionDef, EntityDef, MetricDef } from "./types";

type MetricInput = Pick<MetricDef, "key" | "label" | "unit" | "base"> & Partial<MetricDef>;

export function defineMetric(m: MetricInput): MetricDef {
  const avg = ["percent", "duration", "days", "ratio", "number"].includes(m.unit);
  // rates move a little over a year; volumes grow and cycle
  const rate = m.unit === "percent";
  return {
    trend: rate ? 0.02 : 0.12,
    season: rate ? 0.015 : 0.08,
    noise: 0.07,
    good: "up",
    agg: avg ? "avg" : "sum",
    ...m,
  };
}

export function defineMetrics<const T extends readonly MetricInput[]>(
  list: T,
): { [K in T[number]["key"]]: MetricDef } {
  return Object.fromEntries(list.map((m) => [m.key, defineMetric(m)])) as {
    [K in T[number]["key"]]: MetricDef;
  };
}

export function defineDimension(
  key: string,
  label: string,
  values: readonly string[],
): DimensionDef {
  return { key, label, values };
}

export function defineEntity(e: EntityDef): EntityDef {
  return e;
}

/** Time dimensions every matrix can use. */
export const builtinDimensions = {
  weekday: defineDimension("weekday", "Weekday", ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
  hour: defineDimension(
    "hour",
    "Hour",
    Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`),
  ),
  month: defineDimension("month", "Month", [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]),
} as const;

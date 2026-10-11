import type { TimeseriesResult } from "@/data/types";
import { AreaChart } from "../charts/AreaChart";
import { BarChart } from "../charts/BarChart";
import { LineChart } from "../charts/LineChart";
import { formatMetric } from "../format";
import { Widget, type Span } from "../layout/Widget";

export type TimeseriesVariant =
  "line" | "area" | "stackedArea" | "percentArea" | "bar" | "stackedBar";

function total(data: TimeseriesResult): number {
  let sum = 0;
  for (const row of data.rows) for (const s of data.series) sum += Number(row[s.key]) || 0;
  return sum;
}

function average(data: TimeseriesResult): number {
  const key = data.series[0]?.key;
  if (!key || !data.rows.length) return 0;
  return data.rows.reduce((a, row) => a + (Number(row[key]) || 0), 0) / data.rows.length;
}

export function TimeseriesWidget({
  title,
  subtitle,
  data,
  variant = "line",
  span = 6,
  target,
  height,
  summarize = true,
}: {
  title: string;
  subtitle?: string;
  data: TimeseriesResult;
  variant?: TimeseriesVariant;
  span?: Span;
  target?: number;
  height?: number;
  summarize?: boolean;
}) {
  const footer = !summarize ? undefined : data.agg === "sum" ? (
    <span>
      Total over range: <strong>{formatMetric(total(data), data.unit, { compact: true })}</strong>
    </span>
  ) : data.series.length === 1 ? (
    <span>
      Average over range:{" "}
      <strong>{formatMetric(average(data), data.unit, { compact: true })}</strong>
    </span>
  ) : undefined;
  return (
    <Widget title={title} subtitle={subtitle} span={span} footer={footer}>
      {variant === "line" ? (
        <LineChart data={data} target={target} height={height} />
      ) : variant === "bar" || variant === "stackedBar" ? (
        <BarChart data={data} stacked={variant === "stackedBar"} height={height} />
      ) : (
        <AreaChart
          data={data}
          stacked={variant === "stackedArea"}
          percent={variant === "percentArea"}
          height={height}
        />
      )}
    </Widget>
  );
}

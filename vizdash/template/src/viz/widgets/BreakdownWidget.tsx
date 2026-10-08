import type { BreakdownResult } from "@/data/types";
import { DonutChart } from "../charts/DonutChart";
import { RankedBars } from "../charts/RankedBars";
import { formatMetric } from "../format";
import { Widget, type Span } from "../layout/Widget";

export function BreakdownWidget({
  title,
  subtitle,
  data,
  variant = "ranked",
  span = 6,
  color,
}: {
  title: string;
  subtitle?: string;
  data: BreakdownResult;
  variant?: "ranked" | "donut";
  span?: Span;
  color?: string;
}) {
  return (
    <Widget
      title={title}
      subtitle={subtitle}
      span={span}
      footer={
        <span>
          {data.rows.length} groups · {data.agg === "sum" ? "total" : "overall"}{" "}
          <strong>{formatMetric(data.total, data.unit, { compact: true })}</strong>
        </span>
      }
    >
      {variant === "donut" ? <DonutChart data={data} /> : <RankedBars data={data} color={color} />}
    </Widget>
  );
}

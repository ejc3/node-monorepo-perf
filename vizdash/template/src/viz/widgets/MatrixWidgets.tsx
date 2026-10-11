import type { FlowResult, MatrixResult, TreeNode, Unit } from "@/data/types";
import { Heatmap } from "../charts/Heatmap";
import { SankeyChart } from "../charts/SankeyChart";
import { Treemap } from "../charts/Treemap";
import { formatMetric } from "../format";
import { Widget, type Span } from "../layout/Widget";
import type { Scheme } from "../theme";

export function HeatmapWidget({
  title,
  subtitle,
  data,
  scheme,
  span = 12,
}: {
  title: string;
  subtitle?: string;
  data: MatrixResult;
  scheme?: Scheme;
  span?: Span;
}) {
  return (
    <Widget
      title={title}
      subtitle={subtitle}
      span={span}
      footer={<span>Peak cell: {formatMetric(data.max, data.unit)}</span>}
    >
      <Heatmap data={data} scheme={scheme} />
    </Widget>
  );
}

export function TreemapWidget({
  title,
  subtitle,
  data,
  unit,
  span = 6,
}: {
  title: string;
  subtitle?: string;
  data: TreeNode;
  unit: Unit;
  span?: Span;
}) {
  return (
    <Widget title={title} subtitle={subtitle} span={span}>
      <Treemap data={data} unit={unit} />
    </Widget>
  );
}

export function SankeyWidget({
  title,
  subtitle,
  data,
  span = 12,
}: {
  title: string;
  subtitle?: string;
  data: FlowResult;
  span?: Span;
}) {
  return (
    <Widget title={title} subtitle={subtitle} span={span}>
      <SankeyChart data={data} />
    </Widget>
  );
}

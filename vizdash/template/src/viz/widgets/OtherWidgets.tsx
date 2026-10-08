import type {
  CohortRow,
  DailyPoint,
  DistributionResult,
  FunnelStep,
  GroupedDistribution,
  ScatterResult,
  TimeseriesResult,
  Unit,
} from "@/data/types";
import { BoxPlot } from "../charts/BoxPlot";
import { CalendarHeatmap } from "../charts/CalendarHeatmap";
import { CohortGrid } from "../charts/CohortGrid";
import { ComboChart } from "../charts/ComboChart";
import { FunnelChart } from "../charts/FunnelChart";
import { Gauge } from "../charts/Gauge";
import { Histogram } from "../charts/Histogram";
import { RadarChart, type RadarData } from "../charts/RadarChart";
import { ScatterPlot } from "../charts/ScatterPlot";
import { formatMetric, formatPercent } from "../format";
import { Widget, type Span } from "../layout/Widget";

interface Base {
  title: string;
  subtitle?: string;
  span?: Span;
}

export function FunnelWidget({
  title,
  subtitle,
  steps,
  span = 6,
}: Base & { steps: readonly FunnelStep[] }) {
  const last = steps[steps.length - 1];
  return (
    <Widget
      title={title}
      subtitle={subtitle}
      span={span}
      footer={
        last ? (
          <span>
            End-to-end conversion: <strong>{formatPercent(last.overall, { precise: true })}</strong>
          </span>
        ) : undefined
      }
    >
      <FunnelChart steps={steps} />
    </Widget>
  );
}

export function CohortWidget({
  title,
  subtitle,
  rows,
  span = 12,
  periodLabel,
}: Base & { rows: readonly CohortRow[]; periodLabel?: string }) {
  return (
    <Widget title={title} subtitle={subtitle} span={span}>
      <CohortGrid rows={rows} periodLabel={periodLabel} />
    </Widget>
  );
}

export function DistributionWidget({
  title,
  subtitle,
  data,
  span = 6,
}: Base & { data: DistributionResult }) {
  return (
    <Widget
      title={title}
      subtitle={subtitle}
      span={span}
      footer={
        <span>
          mean {formatMetric(data.mean, data.unit)} · median {formatMetric(data.median, data.unit)}{" "}
          · p90 {formatMetric(data.p90, data.unit)}
        </span>
      }
    >
      <Histogram data={data} />
    </Widget>
  );
}

export function BoxPlotWidget({
  title,
  subtitle,
  data,
  span = 6,
}: Base & { data: GroupedDistribution }) {
  return (
    <Widget title={title} subtitle={subtitle} span={span}>
      <BoxPlot data={data} />
    </Widget>
  );
}

export function ScatterWidget({
  title,
  subtitle,
  data,
  span = 6,
  logX,
}: Base & { data: ScatterResult; logX?: boolean }) {
  return (
    <Widget title={title} subtitle={subtitle} span={span}>
      <ScatterPlot data={data} logX={logX} />
    </Widget>
  );
}

export function GaugeWidget({
  title,
  subtitle,
  value,
  target,
  unit,
  label,
  span = 3,
}: Base & { value: number; target: number; unit: Unit; label: string }) {
  return (
    <Widget title={title} subtitle={subtitle} span={span}>
      <Gauge value={value} target={target} unit={unit} label={label} />
    </Widget>
  );
}

export function CalendarWidget({
  title,
  subtitle,
  days,
  unit,
  span = 12,
}: Base & { days: readonly DailyPoint[]; unit: Unit }) {
  return (
    <Widget title={title} subtitle={subtitle} span={span}>
      <CalendarHeatmap days={days} unit={unit} />
    </Widget>
  );
}

export function RadarWidget({ title, subtitle, data, span = 6 }: Base & { data: RadarData }) {
  return (
    <Widget title={title} subtitle={subtitle} span={span}>
      <RadarChart data={data} />
    </Widget>
  );
}

export function ComboWidget({
  title,
  subtitle,
  bars,
  line,
  span = 6,
}: Base & { bars: TimeseriesResult; line: TimeseriesResult }) {
  return (
    <Widget title={title} subtitle={subtitle} span={span}>
      <ComboChart bars={bars} line={line} />
    </Widget>
  );
}

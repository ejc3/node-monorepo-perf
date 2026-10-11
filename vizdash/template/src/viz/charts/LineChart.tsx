"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart as RLineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TimeseriesResult } from "@/data/types";
import { axisFormatter, formatBucket } from "../format";
import { useSeriesToggle } from "../hooks/useSeriesToggle";
import { AXIS, CHART_HEIGHT, FONT, GRID, seriesColor } from "../theme";
import { timeTooltip } from "./ChartTooltip";

// totals start at zero; rates and averages (a 91% SLA, a 230 ms p95) zoom to their range
const zeroBased = (unit: TimeseriesResult["unit"]) =>
  unit === "currency" || unit === "count" || unit === "bytes";

export function LineChart({
  data,
  height = CHART_HEIGHT.md,
  curve = "monotone",
  target,
}: {
  data: TimeseriesResult;
  height?: number;
  curve?: "monotone" | "linear" | "step";
  /** a horizontal goal line */
  target?: number;
}) {
  const { hidden, toggle } = useSeriesToggle();
  const tick = { fill: AXIS, fontSize: FONT.tick };
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RLineChart data={data.rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(d) => formatBucket(String(d), data.grain)}
          tick={tick}
          tickLine={false}
          axisLine={false}
          minTickGap={28}
        />
        <YAxis
          tickFormatter={axisFormatter(data.unit)}
          tick={tick}
          tickLine={false}
          axisLine={false}
          width={60}
          domain={zeroBased(data.unit) ? [0, "auto"] : ["auto", "auto"]}
        />
        <Tooltip content={timeTooltip(data.unit, data.grain)} />
        {data.series.length > 1 || data.compare ? (
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: FONT.label }}
            onClick={(e) => toggle(String(e.dataKey))}
          />
        ) : null}
        {target !== undefined ? (
          <Line
            dataKey={() => target}
            name="Target"
            stroke={AXIS}
            strokeDasharray="2 4"
            dot={false}
            isAnimationActive={false}
            legendType="none"
          />
        ) : null}
        {data.series.map((s, i) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.label}
            type={curve}
            stroke={seriesColor(i)}
            strokeWidth={2}
            dot={false}
            hide={hidden.has(s.key)}
            isAnimationActive={false}
          />
        ))}
        {data.compare
          ? data.series.map((s, i) => (
              <Line
                key={`${s.key}__prev`}
                dataKey={`${s.key}__prev`}
                name={`${s.label} (previous)`}
                type={curve}
                stroke={seriesColor(i)}
                strokeOpacity={0.45}
                strokeDasharray="4 4"
                dot={false}
                hide={hidden.has(`${s.key}__prev`)}
                isAnimationActive={false}
              />
            ))
          : null}
      </RLineChart>
    </ResponsiveContainer>
  );
}

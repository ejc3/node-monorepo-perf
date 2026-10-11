"use client";

import {
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TimeseriesResult } from "@/data/types";
import { axisFormatter, formatBucket } from "../format";
import { useSeriesToggle } from "../hooks/useSeriesToggle";
import { AXIS, CHART_HEIGHT, FONT, GRID, RADIUS, seriesColor } from "../theme";
import { timeTooltip } from "./ChartTooltip";

/** Bars over time; stacked or grouped by series. */
export function BarChart({
  data,
  height = CHART_HEIGHT.md,
  stacked = false,
}: {
  data: TimeseriesResult;
  height?: number;
  stacked?: boolean;
}) {
  const { hidden, toggle } = useSeriesToggle();
  const tick = { fill: AXIS, fontSize: FONT.tick };
  const last = data.series.length - 1;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RBarChart
        data={data.rows}
        margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
        barCategoryGap="18%"
      >
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(d) => formatBucket(String(d), data.grain)}
          tick={tick}
          tickLine={false}
          axisLine={false}
          minTickGap={20}
        />
        <YAxis
          tickFormatter={axisFormatter(data.unit)}
          tick={tick}
          tickLine={false}
          axisLine={false}
          width={60}
        />
        <Tooltip content={timeTooltip(data.unit, data.grain)} cursor={{ fill: GRID }} />
        {data.series.length > 1 ? (
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: FONT.label }}
            onClick={(e) => toggle(String(e.dataKey))}
          />
        ) : null}
        {data.series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId={stacked ? "a" : undefined}
            fill={seriesColor(i)}
            radius={!stacked || i === last ? [RADIUS, RADIUS, 0, 0] : 0}
            hide={hidden.has(s.key)}
            isAnimationActive={false}
          />
        ))}
      </RBarChart>
    </ResponsiveContainer>
  );
}

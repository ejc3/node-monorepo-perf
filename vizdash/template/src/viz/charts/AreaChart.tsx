"use client";

import { useId } from "react";
import {
  Area,
  AreaChart as RAreaChart,
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
import { AXIS, CHART_HEIGHT, FONT, GRID, seriesColor } from "../theme";
import { timeTooltip } from "./ChartTooltip";

export function AreaChart({
  data,
  height = CHART_HEIGHT.md,
  stacked = false,
  percent = false,
}: {
  data: TimeseriesResult;
  height?: number;
  stacked?: boolean;
  /** stack to 100% (share of total) */
  percent?: boolean;
}) {
  const { hidden, toggle } = useSeriesToggle();
  const tick = { fill: AXIS, fontSize: FONT.tick };
  // gradient ids are document-wide: prefix them per chart so two area charts on one page
  // do not share (and overwrite) each other's fills
  const uid = useId().replace(/:/g, "");
  const id = (i: number) => `area-fill-${uid}-${i}`;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RAreaChart
        data={data.rows}
        stackOffset={percent ? "expand" : undefined}
        margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
      >
        <defs>
          {data.series.map((_, i) => (
            <linearGradient key={i} id={id(i)} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={seriesColor(i)} stopOpacity={stacked ? 0.75 : 0.35} />
              <stop offset="100%" stopColor={seriesColor(i)} stopOpacity={stacked ? 0.45 : 0.02} />
            </linearGradient>
          ))}
        </defs>
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
          tickFormatter={
            percent ? (v) => `${Math.round(Number(v) * 100)}%` : axisFormatter(data.unit)
          }
          tick={tick}
          tickLine={false}
          axisLine={false}
          width={60}
        />
        <Tooltip content={timeTooltip(data.unit, data.grain)} />
        {data.series.length > 1 ? (
          <Legend
            iconType="circle"
            iconSize={8}
            wrapperStyle={{ fontSize: FONT.label }}
            onClick={(e) => toggle(String(e.dataKey))}
          />
        ) : null}
        {data.series.map((s, i) => (
          <Area
            key={s.key}
            dataKey={s.key}
            name={s.label}
            type="monotone"
            stackId={stacked || percent ? "a" : undefined}
            stroke={seriesColor(i)}
            strokeWidth={1.5}
            fill={`url(#${id(i)})`}
            hide={hidden.has(s.key)}
            isAnimationActive={false}
          />
        ))}
      </RAreaChart>
    </ResponsiveContainer>
  );
}

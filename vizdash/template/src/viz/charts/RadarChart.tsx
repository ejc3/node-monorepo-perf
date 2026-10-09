"use client";

import {
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart as RRadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type { ProfileResult } from "@/data/types";
import { AXIS, CHART_HEIGHT, FONT, GRID, seriesColor } from "../theme";
import { categoryTooltip } from "./ChartTooltip";

export type RadarData = ProfileResult;

/** Several groups compared over the same set of scores (values in [0, 1] or a common unit). */
export function RadarChart({
  data,
  height = CHART_HEIGHT.md,
}: {
  data: RadarData;
  height?: number;
}) {
  const rows = data.axes.map((axis, i) => ({
    axis,
    ...Object.fromEntries(data.series.map((s, j) => [`s${j}`, s.values[i]])),
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RRadarChart data={rows} outerRadius="72%">
        <PolarGrid stroke={GRID} />
        <PolarAngleAxis dataKey="axis" tick={{ fill: AXIS, fontSize: FONT.tick }} />
        <PolarRadiusAxis tick={false} axisLine={false} />
        <Tooltip content={categoryTooltip(data.unit)} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: FONT.label }} />
        {data.series.map((s, j) => (
          <Radar
            key={s.label}
            name={s.label}
            dataKey={`s${j}`}
            stroke={seriesColor(j)}
            fill={seriesColor(j)}
            fillOpacity={0.18}
            isAnimationActive={false}
          />
        ))}
      </RRadarChart>
    </ResponsiveContainer>
  );
}

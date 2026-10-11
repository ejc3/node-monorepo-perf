"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TimeseriesResult } from "@/data/types";
import { axisFormatter, formatBucket, formatBucketLong, formatMetric } from "../format";
import { AXIS, CHART_HEIGHT, FONT, GRID, RADIUS, seriesColor } from "../theme";
import type { TooltipEntry } from "./ChartTooltip";

/** Two metrics with different units: bars on the left axis, a line on the right. */
export function ComboChart({
  bars,
  line,
  height = CHART_HEIGHT.md,
}: {
  bars: TimeseriesResult;
  line: TimeseriesResult;
  height?: number;
}) {
  const barKey = bars.series[0].key;
  const lineKey = line.series[0].key;
  const rows = bars.rows.map((r, i) => ({
    ...r,
    [`${lineKey}__line`]: line.rows[i]?.[lineKey] ?? 0,
  }));
  const tick = { fill: AXIS, fontSize: FONT.tick };
  function ComboTooltip(p: {
    active?: boolean;
    payload?: readonly TooltipEntry[];
    label?: unknown;
  }) {
    if (!p.active || !p.payload?.length) return null;
    const units = [bars.unit, line.unit];
    return (
      <div className="chart-tooltip">
        <div className="chart-tooltip__heading">
          {formatBucketLong(String(p.label), bars.grain)}
        </div>
        {p.payload.slice(0, 2).map((e, i) => (
          <div key={i} className="chart-tooltip__row">
            <span className="chart-tooltip__swatch" style={{ background: e.color }} />
            <span className="chart-tooltip__name">{String(e.name)}</span>
            <span className="chart-tooltip__value">{formatMetric(Number(e.value), units[i])}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={(d) => formatBucket(String(d), bars.grain)}
          tick={tick}
          tickLine={false}
          axisLine={false}
          minTickGap={24}
        />
        <YAxis
          yAxisId="l"
          tickFormatter={axisFormatter(bars.unit)}
          tick={tick}
          tickLine={false}
          axisLine={false}
          width={60}
        />
        <YAxis
          yAxisId="r"
          orientation="right"
          tickFormatter={axisFormatter(line.unit)}
          tick={tick}
          tickLine={false}
          axisLine={false}
          width={52}
        />
        <Tooltip content={ComboTooltip} cursor={{ fill: GRID }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: FONT.label }} />
        <Bar
          yAxisId="l"
          dataKey={barKey}
          name={bars.series[0].label}
          fill={seriesColor(0)}
          radius={[RADIUS, RADIUS, 0, 0]}
          isAnimationActive={false}
        />
        <Line
          yAxisId="r"
          dataKey={`${lineKey}__line`}
          name={line.series[0].label}
          type="monotone"
          stroke={seriesColor(1)}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

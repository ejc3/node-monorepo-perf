"use client";

import { bin, max } from "d3-array";
import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { Bar, Line } from "@visx/shape";
import { Text } from "@visx/text";
import type { DistributionResult } from "@/data/types";
import { axisFormatter, formatMetric } from "../format";
import { AXIS, CHART_HEIGHT, MARGIN, seriesColor } from "../theme";
import { CategoryAxis, ValueAxis } from "./axes";
import { Responsive } from "./Responsive";

/** Distribution of per-item values, with median and p90 markers. */
export function Histogram({
  data,
  height = CHART_HEIGHT.md,
  bins = 24,
}: {
  data: DistributionResult;
  height?: number;
  bins?: number;
}) {
  // clip the long tail at p99 so the body of the distribution stays readable
  const hi = data.values[Math.floor(data.values.length * 0.99)] ?? data.p90 * 2;
  const binsOf = bin<number, number>().domain([0, hi]).thresholds(bins);
  const groups = binsOf(data.values.filter((v) => v <= hi));
  const top = max(groups, (b) => b.length) ?? 1;
  return (
    <Responsive height={height}>
      {(width) => {
        const innerW = width - MARGIN.left - MARGIN.right;
        const innerH = height - MARGIN.top - MARGIN.bottom;
        const x = scaleLinear<number>({ domain: [0, hi], range: [0, innerW] });
        const y = scaleLinear<number>({ domain: [0, top], range: [innerH, 0], nice: true });
        const marker = (v: number, label: string) => (
          <Group left={x(v)}>
            <Line
              from={{ x: 0, y: 0 }}
              to={{ x: 0, y: innerH }}
              stroke={AXIS}
              strokeDasharray="3 3"
            />
            <Text
              x={4}
              y={10}
              fontSize={10}
              fill={AXIS}
            >{`${label} ${formatMetric(v, data.unit, { compact: true })}`}</Text>
          </Group>
        );
        return (
          <svg width={width} height={height}>
            <Group left={MARGIN.left} top={MARGIN.top}>
              <ValueAxis scale={y} width={innerW} format={(v) => String(Math.round(v))} ticks={4} />
              <CategoryAxis
                scale={x}
                top={innerH}
                ticks={6}
                format={(v) => axisFormatter(data.unit)(Number(v))}
              />
              {groups.map((b, i) => (
                <Bar
                  key={i}
                  x={x(b.x0 ?? 0) + 1}
                  y={y(b.length)}
                  width={Math.max(0, x(b.x1 ?? 0) - x(b.x0 ?? 0) - 2)}
                  height={innerH - y(b.length)}
                  fill={seriesColor(0)}
                  fillOpacity={0.8}
                  rx={2}
                />
              ))}
              {marker(data.median, "median")}
              {data.p90 <= hi ? marker(data.p90, "p90") : null}
            </Group>
          </svg>
        );
      }}
    </Responsive>
  );
}

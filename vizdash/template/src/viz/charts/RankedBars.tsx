"use client";

import { Group } from "@visx/group";
import { scaleBand, scaleLinear } from "@visx/scale";
import { BarRounded } from "@visx/shape";
import { Text } from "@visx/text";
import type { BreakdownResult } from "@/data/types";
import { formatDelta, formatMetric } from "../format";
import { AXIS, BAD, FONT, GOOD, GRID, seriesColor } from "../theme";
import { Responsive } from "./Responsive";

/** Horizontal bars ranked by value, with share-of-total and period change labels. */
export function RankedBars({
  data,
  rowHeight = 30,
  color = seriesColor(0),
  showDelta = true,
}: {
  data: BreakdownResult;
  rowHeight?: number;
  color?: string;
  showDelta?: boolean;
}) {
  const height = data.rows.length * rowHeight + 8;
  return (
    <Responsive height={height}>
      {(width) => {
        const labelW = Math.min(150, width * 0.32);
        const valueW = showDelta ? 118 : 70;
        const x = scaleLinear<number>({
          domain: [0, Math.max(...data.rows.map((r) => r.value), 1)],
          range: [0, Math.max(10, width - labelW - valueW)],
        });
        const y = scaleBand<string>({
          domain: data.rows.map((r) => r.key),
          range: [0, data.rows.length * rowHeight],
          padding: 0.28,
        });
        return (
          <svg width={width} height={height}>
            {data.rows.map((r) => {
              const top = y(r.key) ?? 0;
              const bw = y.bandwidth();
              return (
                <Group key={r.key} top={top}>
                  <Text
                    x={0}
                    y={bw / 2}
                    verticalAnchor="middle"
                    fontSize={FONT.label}
                    fill="currentColor"
                    width={labelW - 8}
                  >
                    {r.label}
                  </Text>
                  <rect x={labelW} y={0} width={x.range()[1]} height={bw} fill={GRID} rx={3} />
                  <BarRounded
                    x={labelW}
                    y={0}
                    width={Math.max(2, x(r.value))}
                    height={bw}
                    radius={3}
                    right
                    fill={color}
                  />
                  <Text
                    x={labelW + x.range()[1] + 8}
                    y={bw / 2}
                    verticalAnchor="middle"
                    fontSize={FONT.label}
                    fill="currentColor"
                    fontWeight={600}
                  >
                    {formatMetric(r.value, data.unit, { compact: true })}
                  </Text>
                  {showDelta ? (
                    <Text
                      x={width}
                      y={bw / 2}
                      verticalAnchor="middle"
                      textAnchor="end"
                      fontSize={FONT.tick}
                      fill={r.delta >= 0 ? GOOD : BAD}
                    >
                      {formatDelta(r.delta)}
                    </Text>
                  ) : null}
                </Group>
              );
            })}
            <line
              x1={labelW}
              x2={labelW}
              y1={0}
              y2={height - 8}
              stroke={AXIS}
              strokeOpacity={0.4}
            />
          </svg>
        );
      }}
    </Responsive>
  );
}

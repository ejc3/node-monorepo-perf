"use client";

import { HeatmapRect } from "@visx/heatmap";
import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { Text } from "@visx/text";
import type { MatrixResult } from "@/data/types";
import { formatMetric } from "../format";
import { AXIS, FONT, sequential, type Scheme } from "../theme";
import { Responsive } from "./Responsive";

/** A rows x columns grid colored by value (e.g. weekday x hour, region x product). */
export function Heatmap({
  data,
  scheme = "blues",
  cellHeight = 22,
  showValues,
}: {
  data: MatrixResult;
  scheme?: Scheme;
  cellHeight?: number;
  showValues?: boolean;
}) {
  const labelW = 92;
  const top = 22;
  const height = top + data.rows.length * cellHeight + 4;
  // rates start from the smallest cell (a 90-99% SLA grid would be one color from 0)
  const lo = data.unit === "percent" ? Math.min(...data.cells.flat()) : 0;
  const color = sequential(lo, data.max, scheme);
  const columns = data.cols.map((col, j) => ({
    col,
    bins: data.rows.map((row, i) => ({ row, value: data.cells[i][j] })),
  }));
  const values = showValues ?? data.cols.length <= 12;
  return (
    <Responsive height={height}>
      {(width) => {
        const binW = (width - labelW) / data.cols.length;
        const x = scaleLinear<number>({
          domain: [0, data.cols.length],
          range: [0, width - labelW],
        });
        const y = scaleLinear<number>({
          domain: [0, data.rows.length],
          range: [0, data.rows.length * cellHeight],
        });
        const every = Math.ceil(data.cols.length / Math.max(1, Math.floor((width - labelW) / 42)));
        return (
          <svg width={width} height={height}>
            <Group left={labelW} top={0}>
              {data.cols.map((c, j) =>
                j % every === 0 ? (
                  <Text
                    key={c}
                    x={x(j) + binW / 2}
                    y={12}
                    textAnchor="middle"
                    fontSize={FONT.tick}
                    fill={AXIS}
                  >
                    {c}
                  </Text>
                ) : null,
              )}
            </Group>
            <Group left={0} top={top}>
              {data.rows.map((r, i) => (
                <Text
                  key={r}
                  x={labelW - 8}
                  y={y(i) + cellHeight / 2}
                  textAnchor="end"
                  verticalAnchor="middle"
                  fontSize={FONT.tick}
                  fill={AXIS}
                >
                  {r}
                </Text>
              ))}
            </Group>
            <Group left={labelW} top={top}>
              <HeatmapRect
                data={columns}
                bins={(c) => c.bins}
                count={(b) => b.value}
                xScale={(i) => x(i)}
                yScale={(i) => y(i)}
                binWidth={binW}
                binHeight={cellHeight}
                gap={2}
              >
                {(grid) =>
                  grid.map((cols) =>
                    cols.map((cell) => (
                      <g key={`${cell.row}-${cell.column}`}>
                        <rect
                          x={cell.x}
                          y={cell.y}
                          width={Math.max(0, cell.width)}
                          height={Math.max(0, cell.height)}
                          rx={2}
                          fill={color(cell.count ?? 0)}
                        >
                          <title>
                            {`${data.rows[cell.row]} · ${data.cols[cell.column]}: ${formatMetric(cell.count ?? 0, data.unit)}`}
                          </title>
                        </rect>
                        {values && cell.width > 34 ? (
                          <Text
                            x={cell.x + cell.width / 2}
                            y={cell.y + cell.height / 2}
                            textAnchor="middle"
                            verticalAnchor="middle"
                            fontSize={10}
                            fill={
                              (cell.count ?? 0) > lo + (data.max - lo) * 0.55 ? "white" : "#334155"
                            }
                            pointerEvents="none"
                          >
                            {formatMetric(cell.count ?? 0, data.unit, { compact: true })}
                          </Text>
                        ) : null}
                      </g>
                    )),
                  )
                }
              </HeatmapRect>
            </Group>
          </svg>
        );
      }}
    </Responsive>
  );
}

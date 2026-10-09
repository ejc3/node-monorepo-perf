"use client";

import { useMemo } from "react";
import { localPoint } from "@visx/event";
import { GlyphCircle } from "@visx/glyph";
import { Group } from "@visx/group";
import { scaleLinear, scaleLog, scaleSqrt } from "@visx/scale";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { extent } from "d3-array";
import type { ScatterPoint, ScatterResult } from "@/data/types";
import { axisFormatter, formatMetric } from "../format";
import { CHART_HEIGHT, MARGIN, seriesColor } from "../theme";
import { CategoryAxis, ValueAxis } from "./axes";
import { SeriesLegend } from "./Legend";
import { Responsive } from "./Responsive";

export function ScatterPlot({
  data,
  height = CHART_HEIGHT.lg,
  logX = false,
}: {
  data: ScatterResult;
  height?: number;
  logX?: boolean;
}) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<ScatterPoint>();
  const groupIndex = useMemo(() => new Map(data.groups.map((g, i) => [g, i])), [data.groups]);
  const [x0, x1] = extent(data.points, (p) => p.x) as [number, number];
  const [y0, y1] = extent(data.points, (p) => p.y) as [number, number];
  const maxSize = Math.max(...data.points.map((p) => p.size));
  return (
    <div className="chart-surface">
      <Responsive height={height}>
        {(width) => {
          const innerW = width - MARGIN.left - MARGIN.right;
          const innerH = height - MARGIN.top - MARGIN.bottom;
          const x = logX
            ? scaleLog<number>({ domain: [Math.max(x0, 1e-3), x1], range: [0, innerW], nice: true })
            : scaleLinear<number>({
                domain: [x0 * 0.9, x1 * 1.05],
                range: [0, innerW],
                nice: true,
              });
          const y = scaleLinear<number>({
            domain: [y0 * 0.9, y1 * 1.05],
            range: [innerH, 0],
            nice: true,
          });
          const r = scaleSqrt<number>({ domain: [0, maxSize], range: [3, 14] });
          return (
            <svg width={width} height={height}>
              <Group left={MARGIN.left} top={MARGIN.top}>
                <ValueAxis scale={y} width={innerW} format={axisFormatter(data.y.unit)} />
                <CategoryAxis
                  scale={x}
                  top={innerH}
                  ticks={6}
                  format={(v) => formatMetric(Number(v), data.x.unit, { compact: true })}
                />
                {data.points.map((p) => (
                  <GlyphCircle
                    key={p.id}
                    left={x(p.x)}
                    top={y(p.y)}
                    size={Math.PI * r(p.size) ** 2}
                    fill={seriesColor(groupIndex.get(p.group) ?? 0)}
                    fillOpacity={tooltipData?.id === p.id ? 0.95 : 0.62}
                    stroke="white"
                    strokeWidth={0.75}
                    onPointerMove={(e) => {
                      const pt = localPoint(e);
                      if (pt) showTooltip({ tooltipData: p, tooltipLeft: pt.x, tooltipTop: pt.y });
                    }}
                    onPointerLeave={hideTooltip}
                  />
                ))}
              </Group>
            </svg>
          );
        }}
      </Responsive>
      <div className="axis-caption">
        <span>↑ {data.y.label}</span>
        <span>{data.x.label} →</span>
      </div>
      <SeriesLegend labels={data.groups} />
      {tooltipOpen && tooltipData ? (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          className="chart-tooltip"
          unstyled
          applyPositionStyle
        >
          <div className="chart-tooltip__heading">{tooltipData.label}</div>
          <div className="chart-tooltip__row">
            <span className="chart-tooltip__name">{data.x.label}</span>
            <span className="chart-tooltip__value">{formatMetric(tooltipData.x, data.x.unit)}</span>
          </div>
          <div className="chart-tooltip__row">
            <span className="chart-tooltip__name">{data.y.label}</span>
            <span className="chart-tooltip__value">{formatMetric(tooltipData.y, data.y.unit)}</span>
          </div>
          <div className="chart-tooltip__row">
            <span className="chart-tooltip__name">Group</span>
            <span className="chart-tooltip__value">{tooltipData.group}</span>
          </div>
        </TooltipWithBounds>
      ) : null}
    </div>
  );
}

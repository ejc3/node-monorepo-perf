"use client";

import { quantileSorted } from "d3-array";
import { Group } from "@visx/group";
import { scaleBand, scaleLinear } from "@visx/scale";
import { BoxPlot as VBoxPlot } from "@visx/stats";
import type { GroupedDistribution } from "@/data/types";
import { axisFormatter } from "../format";
import { CHART_HEIGHT, MARGIN, seriesColor, shade } from "../theme";
import { CategoryAxis, ValueAxis } from "./axes";
import { Responsive } from "./Responsive";

/** Quartiles and whiskers (1.5 IQR) per group; outliers drawn as points. */
export function BoxPlot({
  data,
  height = CHART_HEIGHT.md,
}: {
  data: GroupedDistribution;
  height?: number;
}) {
  const stats = data.groups.map((g) => {
    const q1 = quantileSorted(g.values, 0.25) ?? 0;
    const q3 = quantileSorted(g.values, 0.75) ?? 0;
    const iqr = q3 - q1;
    const lo = Math.max(g.values[0], q1 - 1.5 * iqr);
    const hi = Math.min(g.values[g.values.length - 1], q3 + 1.5 * iqr);
    return {
      group: g.group,
      q1,
      q3,
      median: quantileSorted(g.values, 0.5) ?? 0,
      min: lo,
      max: hi,
      outliers: g.values.filter((v) => v > hi).slice(-6),
    };
  });
  const top = Math.max(...stats.map((s) => Math.max(s.max, ...s.outliers)));
  return (
    <Responsive height={height}>
      {(width) => {
        const innerW = width - MARGIN.left - MARGIN.right;
        const innerH = height - MARGIN.top - MARGIN.bottom;
        const x = scaleBand<string>({
          domain: stats.map((s) => s.group),
          range: [0, innerW],
          padding: 0.35,
        });
        const y = scaleLinear<number>({ domain: [0, top * 1.05], range: [innerH, 0], nice: true });
        const bw = x.bandwidth();
        return (
          <svg width={width} height={height}>
            <Group left={MARGIN.left} top={MARGIN.top}>
              <ValueAxis scale={y} width={innerW} format={axisFormatter(data.unit)} />
              <CategoryAxis scale={x} top={innerH} />
              {stats.map((s, i) => (
                <VBoxPlot
                  key={s.group}
                  left={x(s.group)}
                  boxWidth={bw}
                  min={s.min}
                  max={s.max}
                  firstQuartile={s.q1}
                  thirdQuartile={s.q3}
                  median={s.median}
                  outliers={s.outliers}
                  valueScale={y}
                  fill={shade(seriesColor(i), 0.3)}
                  stroke={shade(seriesColor(i), -0.15)}
                  strokeWidth={1.25}
                  rx={3}
                  ry={3}
                />
              ))}
            </Group>
          </svg>
        );
      }}
    </Responsive>
  );
}

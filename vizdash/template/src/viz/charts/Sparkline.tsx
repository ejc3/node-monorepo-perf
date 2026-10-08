"use client";

import { curveMonotoneX } from "@visx/curve";
import { LinearGradient } from "@visx/gradient";
import { scaleLinear } from "@visx/scale";
import { AreaClosed, LinePath } from "@visx/shape";
import { extent } from "d3-array";
import { useId } from "react";
import { seriesColor } from "../theme";

/** A small trend line without axes, for KPI tiles and table cells. */
export function Sparkline({
  values,
  width = 120,
  height = 32,
  color = seriesColor(0),
  fill = true,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  if (values.length < 2) return <svg width={width} height={height} />;
  const [lo, hi] = extent(values) as [number, number];
  const x = scaleLinear<number>({ domain: [0, values.length - 1], range: [1, width - 1] });
  const y = scaleLinear<number>({ domain: [lo, hi === lo ? lo + 1 : hi], range: [height - 2, 2] });
  const pts = values.map((v, i) => ({ i, v }));
  return (
    <svg width={width} height={height} className="sparkline" aria-hidden>
      {fill ? (
        <>
          <LinearGradient
            id={`spark-${id}`}
            from={color}
            to={color}
            fromOpacity={0.28}
            toOpacity={0}
          />
          <AreaClosed
            data={pts}
            x={(d) => x(d.i)}
            y={(d) => y(d.v)}
            yScale={y}
            curve={curveMonotoneX}
            fill={`url(#spark-${id})`}
          />
        </>
      ) : null}
      <LinePath
        data={pts}
        x={(d) => x(d.i)}
        y={(d) => y(d.v)}
        curve={curveMonotoneX}
        stroke={color}
        strokeWidth={1.5}
      />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r={2.2} fill={color} />
    </svg>
  );
}

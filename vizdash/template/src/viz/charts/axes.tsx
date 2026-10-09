"use client";

import { AxisBottom, AxisLeft } from "@visx/axis";
import { GridRows } from "@visx/grid";
import type { AnyD3Scale } from "@visx/scale";
import { AXIS, FONT, GRID } from "../theme";

const tickLabel = () => ({ fill: AXIS, fontSize: FONT.tick, fontFamily: FONT.family });

/** Left value axis + horizontal grid lines, styled like the recharts charts. */
export function ValueAxis({
  scale,
  width,
  format,
  ticks = 5,
}: {
  scale: AnyD3Scale;
  width: number;
  format: (v: number) => string;
  ticks?: number;
}) {
  return (
    <>
      <GridRows scale={scale} width={width} numTicks={ticks} stroke={GRID} />
      <AxisLeft
        scale={scale}
        numTicks={ticks}
        hideAxisLine
        hideTicks
        tickFormat={(v) => format(Number(v))}
        tickLabelProps={() => ({ ...tickLabel(), textAnchor: "end", dx: -4, dy: 3 })}
      />
    </>
  );
}

export function CategoryAxis({
  scale,
  top,
  ticks,
  format,
}: {
  scale: AnyD3Scale;
  top: number;
  ticks?: number;
  format?: (v: unknown) => string;
}) {
  return (
    <AxisBottom
      top={top}
      scale={scale}
      numTicks={ticks}
      stroke={GRID}
      hideTicks
      tickFormat={format ? (v) => format(v) : undefined}
      tickLabelProps={() => ({ ...tickLabel(), textAnchor: "middle", dy: 4 })}
    />
  );
}

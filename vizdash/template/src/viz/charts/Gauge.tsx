"use client";

import { useMemo } from "react";
import type { Unit } from "@/data/types";
import { formatMetric } from "../format";
import { BAD, CHART_HEIGHT, GOOD, GRID, SERIES } from "../theme";
import { EChart, type EChartsOption } from "./EChart";

/** Progress toward a target (e.g. quota attainment, SLA, availability). */
export function Gauge({
  value,
  target,
  unit,
  label,
  height = CHART_HEIGHT.md - 40,
}: {
  value: number;
  target: number;
  unit: Unit;
  label: string;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(() => {
    const max = Math.max(target * 1.25, value * 1.05);
    return {
      series: [
        {
          type: "gauge",
          startAngle: 205,
          endAngle: -25,
          min: 0,
          max,
          radius: "96%",
          center: ["50%", "62%"],
          progress: {
            show: true,
            width: 14,
            itemStyle: { color: value >= target ? GOOD : SERIES[0] },
          },
          axisLine: { lineStyle: { width: 14, color: [[1, GRID]] } },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          pointer: { show: false },
          anchor: { show: false },
          title: { offsetCenter: [0, "34%"], fontSize: 12, color: "#64748b" },
          detail: {
            offsetCenter: [0, "2%"],
            fontSize: 22,
            fontWeight: 650,
            color: "inherit",
            formatter: (v: number) => formatMetric(v, unit, { compact: true }),
          },
          markLine: undefined,
          data: [
            { value, name: `${label} · target ${formatMetric(target, unit, { compact: true })}` },
          ],
        },
        {
          type: "gauge",
          startAngle: 205,
          endAngle: -25,
          min: 0,
          max,
          radius: "96%",
          center: ["50%", "62%"],
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { show: false },
          pointer: {
            show: true,
            icon: "rect",
            length: "16%",
            width: 3,
            offsetCenter: [0, "-78%"],
            itemStyle: { color: BAD },
          },
          detail: { show: false },
          title: { show: false },
          data: [{ value: target }],
        },
      ],
    };
  }, [value, target, unit, label]);
  return <EChart option={option} height={height} />;
}

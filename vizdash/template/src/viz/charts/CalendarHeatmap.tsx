"use client";

import { useMemo } from "react";
import { max } from "d3-array";
import type { DailyPoint, Unit } from "@/data/types";
import { formatMetric } from "../format";
import { AXIS } from "../theme";
import { EChart, type EChartsOption } from "./EChart";

/** One cell per day over the last year (GitHub-contribution style). */
export function CalendarHeatmap({
  days,
  unit,
  height = 150,
}: {
  days: readonly DailyPoint[];
  unit: Unit;
  height?: number;
}) {
  const option = useMemo<EChartsOption>(() => {
    const top = max(days, (d) => d.value) ?? 1;
    return {
      tooltip: {
        formatter: (p: unknown) => {
          const [date, v] = (p as { value: [string, number] }).value;
          return `${date}<br/><b>${formatMetric(v, unit)}</b>`;
        },
      },
      visualMap: {
        min: 0,
        max: top,
        show: false,
        inRange: { color: ["#eef2ff", "#a5b4fc", "#4f46e5", "#312e81"] },
      },
      calendar: {
        range: [days[0].date, days[days.length - 1].date],
        top: 24,
        left: 36,
        right: 8,
        cellSize: ["auto", 14],
        itemStyle: { borderWidth: 2, borderColor: "transparent" },
        splitLine: { show: false },
        yearLabel: { show: false },
        dayLabel: { firstDay: 1, nameMap: "en", color: AXIS, fontSize: 10 },
        monthLabel: { color: AXIS, fontSize: 10 },
      },
      series: [
        {
          type: "heatmap",
          coordinateSystem: "calendar",
          data: days.map((d) => [d.date, d.value]),
        },
      ],
    };
  }, [days, unit]);
  return <EChart option={option} height={height} />;
}

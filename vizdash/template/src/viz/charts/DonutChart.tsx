"use client";

import { useState } from "react";
import { Group } from "@visx/group";
import { Pie } from "@visx/shape";
import { Text } from "@visx/text";
import type { BreakdownResult } from "@/data/types";
import { formatMetric, formatPercent } from "../format";
import { CHART_HEIGHT, seriesColor, shade } from "../theme";

/** Share of total by category, with the total (or the hovered slice) in the middle. */
export function DonutChart({
  data,
  size = CHART_HEIGHT.md - 20,
}: {
  data: BreakdownResult;
  size?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const r = size / 2;
  const focus = active === null ? null : data.rows[active];
  return (
    <div className="donut">
      <svg width={size} height={size}>
        <Group top={r} left={r}>
          <Pie
            data={data.rows}
            pieValue={(d) => d.value}
            outerRadius={r - 4}
            innerRadius={r * 0.62}
            padAngle={0.012}
            cornerRadius={3}
            pieSort={null}
          >
            {(pie) =>
              pie.arcs.map((arc, i) => (
                <path
                  key={arc.data.key}
                  d={pie.path(arc) ?? ""}
                  fill={active === i ? shade(seriesColor(i), -0.08) : seriesColor(i)}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive(null)}
                />
              ))
            }
          </Pie>
          <Text
            textAnchor="middle"
            verticalAnchor="end"
            fontSize={20}
            fontWeight={650}
            fill="currentColor"
          >
            {formatMetric(focus ? focus.value : data.total, data.unit, { compact: true })}
          </Text>
          <Text
            textAnchor="middle"
            verticalAnchor="start"
            dy={6}
            fontSize={12}
            fill="currentColor"
            opacity={0.65}
          >
            {focus
              ? `${focus.label} · ${formatPercent(focus.share)}`
              : data.agg === "sum"
                ? "Total"
                : "Overall"}
          </Text>
        </Group>
      </svg>
      <ul className="donut__legend">
        {data.rows.map((row, i) => (
          <li
            key={row.key}
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
          >
            <span className="swatch" style={{ background: seriesColor(i) }} />
            <span className="donut__label">{row.label}</span>
            <span className="donut__share">{formatPercent(row.share)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

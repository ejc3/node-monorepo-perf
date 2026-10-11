"use client";

import type { Grain, Unit } from "@/data/types";
import { formatBucketLong, formatMetric } from "../format";

export interface TooltipEntry {
  name?: string | number;
  value?: unknown;
  color?: string;
  dataKey?: unknown;
}

/** Tooltip body shared by every chart: a heading and one row per series. */
export function TooltipCard({
  heading,
  entries,
  unit,
}: {
  heading: string;
  entries: readonly TooltipEntry[];
  unit: Unit;
}) {
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip__heading">{heading}</div>
      {entries.map((e, i) => (
        <div key={i} className="chart-tooltip__row">
          <span className="chart-tooltip__swatch" style={{ background: e.color }} />
          <span className="chart-tooltip__name">{String(e.name ?? "")}</span>
          <span className="chart-tooltip__value">{formatMetric(Number(e.value), unit)}</span>
        </div>
      ))}
    </div>
  );
}

/** Adapter for recharts' `content` prop over a time axis. */
export function timeTooltip(unit: Unit, grain: Grain) {
  function TimeTooltip(props: {
    active?: boolean;
    payload?: readonly TooltipEntry[];
    label?: unknown;
  }) {
    if (!props.active || !props.payload?.length) return null;
    return (
      <TooltipCard
        heading={formatBucketLong(String(props.label), grain)}
        entries={props.payload}
        unit={unit}
      />
    );
  }
  return TimeTooltip;
}

/** Adapter for recharts' `content` prop over a category axis. */
export function categoryTooltip(unit: Unit) {
  function CategoryTooltip(props: {
    active?: boolean;
    payload?: readonly TooltipEntry[];
    label?: unknown;
  }) {
    if (!props.active || !props.payload?.length) return null;
    return <TooltipCard heading={String(props.label ?? "")} entries={props.payload} unit={unit} />;
  }
  return CategoryTooltip;
}

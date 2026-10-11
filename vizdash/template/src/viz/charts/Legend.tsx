"use client";

import { LegendItem, LegendLabel, LegendOrdinal } from "@visx/legend";
import { scaleOrdinal } from "@visx/scale";
import { seriesColor } from "../theme";

/** Ordinal legend for the visx charts; clicking an item calls `onToggle`. */
export function SeriesLegend({
  labels,
  hidden,
  onToggle,
}: {
  labels: readonly string[];
  hidden?: ReadonlySet<string>;
  onToggle?: (label: string) => void;
}) {
  const scale = scaleOrdinal<string, string>({
    domain: [...labels],
    range: labels.map((_, i) => seriesColor(i)),
  });
  return (
    <LegendOrdinal scale={scale}>
      {(items) => (
        <div className="legend">
          {items.map((item) => (
            <LegendItem
              key={item.text}
              className="legend__item"
              onClick={() => onToggle?.(item.text)}
              style={{ opacity: hidden?.has(item.text) ? 0.35 : 1 }}
            >
              <svg width={10} height={10}>
                <circle cx={5} cy={5} r={4} fill={item.value} />
              </svg>
              <LegendLabel margin="0 0 0 6px">{item.text}</LegendLabel>
            </LegendItem>
          ))}
        </div>
      )}
    </LegendOrdinal>
  );
}

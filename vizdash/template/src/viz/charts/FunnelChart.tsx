"use client";

import { scaleLinear } from "@visx/scale";
import type { FunnelStep } from "@/data/types";
import { formatNumber, formatPercent } from "../format";
import { seriesColor, shade } from "../theme";

/** Conversion steps as centered bars, with step and overall conversion. */
export function FunnelChart({ steps }: { steps: readonly FunnelStep[] }) {
  const w = scaleLinear<number>({ domain: [0, steps[0]?.value || 1], range: [6, 100] });
  return (
    <ol className="funnel">
      {steps.map((s, i) => (
        <li key={s.step} className="funnel__step">
          <div className="funnel__label">
            <span>{s.step}</span>
            <strong>{formatNumber(s.value, { compact: true })}</strong>
          </div>
          <div className="funnel__track">
            <div
              className="funnel__bar"
              style={{ width: `${w(s.value)}%`, background: shade(seriesColor(0), i * 0.06) }}
            />
          </div>
          <div className="funnel__rates">
            {i === 0
              ? "entry"
              : `${formatPercent(s.rate)} of previous · ${formatPercent(s.overall, { precise: true })} overall`}
          </div>
        </li>
      ))}
    </ol>
  );
}

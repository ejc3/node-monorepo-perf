import type { Kpi } from "@/data/types";
import { Sparkline } from "../charts/Sparkline";
import { formatMetric } from "../format";
import { BAD, GOOD, seriesColor } from "../theme";
import { Delta } from "./Delta";

/** A headline metric: value over the range, change vs the previous range, trend. */
export function KpiCard({
  kpi,
  accent,
  compareLabel = "vs prev.",
}: {
  kpi: Kpi;
  accent?: string;
  compareLabel?: string;
}) {
  const improving = kpi.good === "up" ? kpi.delta >= 0 : kpi.delta <= 0;
  return (
    <article className="kpi-card">
      <header className="kpi-card__label">{kpi.label}</header>
      <div className="kpi-card__value">{formatMetric(kpi.value, kpi.unit, { compact: true })}</div>
      <div className="kpi-card__foot">
        <Delta value={kpi.delta} good={kpi.good} label={compareLabel} />
        <Sparkline
          values={kpi.spark}
          width={96}
          height={28}
          color={accent ?? (improving ? GOOD : kpi.delta ? BAD : seriesColor(0))}
        />
      </div>
    </article>
  );
}

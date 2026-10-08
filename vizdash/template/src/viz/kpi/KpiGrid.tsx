import type { Kpi } from "@/data/types";
import { formatMetric } from "../format";
import { Delta } from "./Delta";
import { KpiCard } from "./KpiCard";

export function KpiGrid({ kpis, accent }: { kpis: readonly Kpi[]; accent?: string }) {
  return (
    <section className="kpi-grid" style={{ ["--kpi-cols" as string]: Math.min(kpis.length, 6) }}>
      {kpis.map((k) => (
        <KpiCard key={k.key} kpi={k} accent={accent} />
      ))}
    </section>
  );
}

/** A compact one-line strip of KPIs, for summaries embedded in other pages. */
export function KpiStrip({ kpis }: { kpis: readonly Kpi[] }) {
  return (
    <dl className="kpi-strip">
      {kpis.map((k) => (
        <div key={k.key}>
          <dt>{k.label}</dt>
          <dd>
            <KpiValue kpi={k} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function KpiValue({ kpi }: { kpi: Kpi }) {
  return (
    <>
      <strong>{formatMetric(kpi.value, kpi.unit, { compact: true })}</strong>{" "}
      <Delta value={kpi.delta} good={kpi.good} />
    </>
  );
}

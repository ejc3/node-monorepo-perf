import Link from "next/link";
import type { Kpi } from "@/data/types";
import { Sparkline } from "@/viz/charts/Sparkline";
import { formatMetric } from "@/viz/format";
import { Delta } from "@/viz/kpi";

/** A dashboard in a directory listing, with one headline KPI. */
export function DashboardCard({
  title,
  href,
  subtitle,
  kpi,
  accent,
}: {
  title: string;
  href: string;
  subtitle?: string;
  kpi?: Kpi;
  accent?: string;
}) {
  return (
    <Link href={href} className="dash-card" prefetch={false}>
      <div className="dash-card__title">{title}</div>
      {subtitle ? <div className="muted dash-card__sub">{subtitle}</div> : null}
      {kpi ? (
        <div className="dash-card__kpi">
          <div>
            <div className="muted">{kpi.label}</div>
            <strong>{formatMetric(kpi.value, kpi.unit, { compact: true })}</strong>{" "}
            <Delta value={kpi.delta} good={kpi.good} />
          </div>
          <Sparkline values={kpi.spark} width={88} height={26} color={accent} />
        </div>
      ) : null}
    </Link>
  );
}

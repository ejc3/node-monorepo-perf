import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { DEFAULT_FILTERS, kpis } from "@/data";
import { AREAS } from "@/generated/areas";
import { DIRECTORY } from "@/generated/directory";
import { AreaIcon, DashboardCard } from "@/shell";
import { DashboardHeader, KpiStrip, Section } from "@/viz";

export default function Overview() {
  const featured = AREAS.flatMap((a) => DIRECTORY.filter((d) => d.area === a.key).slice(0, 2));
  return (
    <main className="page">
      <DashboardHeader
        title="Overview"
        description="Headline numbers of every area over the last 30 days. Open an area for its dashboards."
      />
      <div className="card-grid">
        {AREAS.map((a) => (
          <Link
            key={a.key}
            href={a.href}
            className="dash-card"
            style={{ ["--accent" as string]: a.accent }}
          >
            <div className="area-hero">
              <span className="area-hero__icon" style={{ background: a.accent }}>
                <AreaIcon name={a.icon} size={18} />
              </span>
              <div>
                <div className="dash-card__title">{a.label}</div>
                <div className="muted dash-card__sub">{a.dashboards} dashboards</div>
              </div>
              <ArrowUpRight size={16} className="muted" style={{ marginLeft: "auto" }} />
            </div>
            <KpiStrip
              kpis={kpis({ seed: `area:${a.key}`, filters: DEFAULT_FILTERS }, a.headline)}
            />
          </Link>
        ))}
      </div>
      <Section title="Featured dashboards">
        <div className="card-grid">
          {featured.map((d) => (
            <DashboardCard key={d.id} title={d.title} href={d.href} subtitle={d.areaLabel} />
          ))}
        </div>
      </Section>
    </main>
  );
}

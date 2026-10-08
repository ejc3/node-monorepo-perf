import type { Metadata } from "next";
import { DIRECTORY } from "@/generated/directory";
import { DashboardCard } from "@/shell";
import { DashboardHeader, EmptyState } from "@/viz";

export const metadata: Metadata = { title: "Search" };

export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const q = ((await searchParams).q ?? "").trim().toLowerCase();
  const terms = q.split(/\s+/).filter(Boolean);
  const hits = terms.length
    ? DIRECTORY.filter((d) =>
        terms.every((t) => `${d.title} ${d.areaLabel}`.toLowerCase().includes(t)),
      ).slice(0, 60)
    : [];
  return (
    <main className="page">
      <DashboardHeader
        title={q ? `Results for “${q}”` : "Search"}
        description={`${hits.length} dashboards shown`}
      />
      {hits.length ? (
        <div className="card-grid">
          {hits.map((d) => (
            <DashboardCard key={d.id} title={d.title} href={d.href} subtitle={d.areaLabel} />
          ))}
        </div>
      ) : (
        <EmptyState title="No dashboards match" hint="Try an area, a region or a metric name." />
      )}
    </main>
  );
}

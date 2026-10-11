import Link from "next/link";
import { ChevronRight, Clock, User } from "lucide-react";

export interface Crumb {
  label: string;
  href?: string;
}

export function DashboardHeader({
  title,
  description,
  crumbs = [],
  owner,
  refresh,
  tags = [],
  actions,
}: {
  title: string;
  description?: string;
  crumbs?: readonly Crumb[];
  owner?: string;
  refresh?: string;
  tags?: readonly string[];
  actions?: React.ReactNode;
}) {
  return (
    <header className="dash-header">
      {crumbs.length ? (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <span key={i} className="crumbs__item">
              {i > 0 ? <ChevronRight size={12} className="muted" /> : null}
              {c.href ? <Link href={c.href}>{c.label}</Link> : <span>{c.label}</span>}
            </span>
          ))}
        </nav>
      ) : null}
      <div className="dash-header__row">
        <div>
          <h1>{title}</h1>
          {description ? <p className="dash-header__desc">{description}</p> : null}
          <div className="dash-header__meta">
            {owner ? (
              <span>
                <User size={12} /> {owner}
              </span>
            ) : null}
            {refresh ? (
              <span>
                <Clock size={12} /> {refresh}
              </span>
            ) : null}
            {tags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </div>
        </div>
        {actions ? <div className="dash-header__actions">{actions}</div> : null}
      </div>
    </header>
  );
}

import { Info } from "lucide-react";
import clsx from "clsx";

export type Span = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/** A card on the dashboard grid: title, optional subtitle and footer, a 12-column span. */
export function Widget({
  title,
  subtitle,
  info,
  span = 6,
  footer,
  actions,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  info?: string;
  span?: Span;
  footer?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("widget", className)} style={{ gridColumn: `span ${span}` }}>
      <header className="widget__header">
        <div>
          <h3 className="widget__title">
            {title}
            {info ? (
              <span className="widget__info" title={info}>
                <Info size={13} />
              </span>
            ) : null}
          </h3>
          {subtitle ? <p className="widget__subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="widget__actions">{actions}</div> : null}
      </header>
      <div className="widget__body">{children}</div>
      {footer ? <footer className="widget__footer">{footer}</footer> : null}
    </section>
  );
}

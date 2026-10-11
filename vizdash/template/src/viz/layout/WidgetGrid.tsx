export function WidgetGrid({ children }: { children: React.ReactNode }) {
  return <div className="widget-grid">{children}</div>;
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="section">
      <header className="section__header">
        <h2>{title}</h2>
        {description ? <p className="muted">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

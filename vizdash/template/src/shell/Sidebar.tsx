"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { ChartColumn } from "lucide-react";
import { AreaIcon } from "./icons";

export interface NavArea {
  key: string;
  label: string;
  icon: string;
  accent: string;
  href: string;
  dashboards: number;
}

export function Sidebar({ areas }: { areas: readonly NavArea[] }) {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <Link href="/" className="sidebar__brand">
        <ChartColumn size={18} />
        <span>Vizdash</span>
      </Link>
      <nav>
        <Link href="/" className={clsx("sidebar__link", pathname === "/" && "sidebar__link--on")}>
          <AreaIcon name="dashboard" />
          <span>Overview</span>
        </Link>
        <div className="sidebar__heading">Areas</div>
        {areas.map((a) => {
          const on = pathname === a.href || pathname.startsWith(`${a.href}/`);
          return (
            <Link
              key={a.key}
              href={a.href}
              className={clsx("sidebar__link", on && "sidebar__link--on")}
              style={{ ["--accent" as string]: a.accent }}
            >
              <AreaIcon name={a.icon} />
              <span>{a.label}</span>
              <span className="sidebar__count">{a.dashboards}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

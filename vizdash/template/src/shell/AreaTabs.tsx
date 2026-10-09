"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

export function AreaTabs({ tabs }: { tabs: readonly { label: string; href: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="tabs">
      {tabs.map((t, i) => {
        const on =
          i === 0 ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link key={t.href} href={t.href} className={clsx("tabs__item", on && "tabs__item--on")}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

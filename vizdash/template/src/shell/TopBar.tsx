import { Bell, Search } from "lucide-react";
import { ThemeToggle } from "@/viz/theme";
import { ANCHOR, isoDay } from "@/data/calendar";
import { formatDate } from "@/viz/format";

export function TopBar() {
  return (
    <header className="topbar">
      <form action="/search" className="topbar__search">
        <Search size={14} />
        <input name="q" placeholder="Search dashboards" aria-label="Search dashboards" />
      </form>
      <span className="muted topbar__asof">Data as of {formatDate(isoDay(ANCHOR))}</span>
      <button className="icon-button" aria-label="Notifications">
        <Bell size={16} />
      </button>
      <ThemeToggle />
      <span className="avatar" aria-hidden>
        AK
      </span>
    </header>
  );
}

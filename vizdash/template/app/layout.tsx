import type { Metadata } from "next";
import { AREAS } from "@/generated/areas";
import { Sidebar, TopBar } from "@/shell";
import { ThemeProvider } from "@/viz/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Vizdash", template: "%s · Vizdash" },
  description: "Operational dashboards for every team",
};

const nav = AREAS.map(({ key, label, icon, accent, href, dashboards }) => ({
  key,
  label,
  icon,
  accent,
  href,
  dashboards,
}));

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <div className="app">
            <Sidebar areas={nav} />
            <div className="main">
              <TopBar />
              {children}
            </div>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}

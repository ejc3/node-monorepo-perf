"use client";

import { Download } from "lucide-react";
import { useSearchParams } from "next/navigation";

/** Link to a dashboard's export route handler, carrying the current filters. */
export function ExportButton({ href, format = "csv" }: { href: string; format?: "csv" | "json" }) {
  const params = useSearchParams();
  const qs = new URLSearchParams(params.toString());
  qs.set("format", format);
  return (
    <a className="button button--ghost" href={`${href}?${qs.toString()}`} download>
      <Download size={14} /> Export {format.toUpperCase()}
    </a>
  );
}

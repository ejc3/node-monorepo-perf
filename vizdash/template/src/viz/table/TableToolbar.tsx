"use client";

import { Download, Search } from "lucide-react";
import { formatNumber } from "../format";
import { useCsvDownload } from "../hooks/useCsvDownload";

export function TableToolbar({
  value,
  onChange,
  placeholder,
  count,
  csvName,
  csvRows,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  count: number;
  csvName?: string;
  csvRows: readonly Record<string, unknown>[];
}) {
  const download = useCsvDownload(csvName ?? "export");
  return (
    <div className="table-toolbar">
      <label className="search-input">
        <Search size={14} />
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      </label>
      <span className="muted">{formatNumber(count)} rows</span>
      {csvName ? (
        <button className="button button--ghost" onClick={() => download(csvRows)}>
          <Download size={14} /> CSV
        </button>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback } from "react";
import { toCsv } from "@/data/csv";

/** Returns a callback that saves `rows` as a CSV file in the browser. */
export function useCsvDownload(filename: string) {
  return useCallback(
    (rows: readonly Record<string, unknown>[], columns?: readonly string[]) => {
      const blob = new Blob([toCsv(rows, columns)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
    [filename],
  );
}

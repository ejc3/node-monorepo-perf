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
      // attached for browsers that ignore clicks on detached anchors; the URL outlives the
      // click because some browsers start the download asynchronously
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    [filename],
  );
}

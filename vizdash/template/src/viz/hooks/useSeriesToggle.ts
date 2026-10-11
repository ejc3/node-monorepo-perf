"use client";

import { useCallback, useState } from "react";

/** Series a user hid by clicking the legend. */
export function useSeriesToggle() {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  return { hidden, toggle };
}

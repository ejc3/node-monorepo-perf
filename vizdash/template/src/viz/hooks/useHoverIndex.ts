"use client";

import { useCallback, useState } from "react";
import { localPoint } from "@visx/event";
import { bisector } from "d3-array";

/** Index of the data point nearest the pointer along x, for crosshair charts. */
export function useHoverIndex<T>(
  data: readonly T[],
  x: (d: T) => number,
  invert: (px: number) => number,
) {
  const [index, setIndex] = useState<number | null>(null);
  const bisect = bisector<T, number>(x).center;
  const onMove = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      const p = localPoint(event);
      if (!p) return;
      setIndex(bisect(data, invert(p.x)));
    },
    [bisect, data, invert],
  );
  const onLeave = useCallback(() => setIndex(null), []);
  return { index, onMove, onLeave };
}

"use client";

import { Calendar } from "lucide-react";
import clsx from "clsx";
import { RANGES } from "@/data/calendar";
import type { RangeKey } from "@/data/types";

export function RangeSelect({
  value,
  onChange,
  options = Object.keys(RANGES) as RangeKey[],
}: {
  value: RangeKey;
  onChange: (v: RangeKey) => void;
  options?: readonly RangeKey[];
}) {
  return (
    <div className="segmented" role="group" aria-label="Date range">
      <Calendar size={14} className="muted" />
      {options.map((k) => (
        <button
          key={k}
          className={clsx("segmented__item", value === k && "segmented__item--on")}
          onClick={() => onChange(k)}
          title={RANGES[k].label}
        >
          {k.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

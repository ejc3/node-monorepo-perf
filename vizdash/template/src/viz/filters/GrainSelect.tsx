"use client";

import clsx from "clsx";
import type { Grain } from "@/data/types";

const GRAINS: Grain[] = ["day", "week", "month"];

export function GrainSelect({
  value,
  onChange,
}: {
  value: Grain | null;
  onChange: (g: Grain | null) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label="Time grain">
      {GRAINS.map((g) => (
        <button
          key={g}
          className={clsx("segmented__item", value === g && "segmented__item--on")}
          onClick={() => onChange(value === g ? null : g)}
        >
          {g[0].toUpperCase() + g.slice(1)}
        </button>
      ))}
    </div>
  );
}

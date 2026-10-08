"use client";

import { ListFilter, LoaderCircle } from "lucide-react";
import type { Grain, RangeKey } from "@/data/types";
import { CompareToggle } from "./CompareToggle";
import { DimensionSelect } from "./DimensionSelect";
import { GrainSelect } from "./GrainSelect";
import { RangeSelect } from "./RangeSelect";
import { useFilterParams } from "./useFilterParams";

export interface FilterDimension {
  /** the search param it writes: segment or region */
  param: "segment" | "region";
  label: string;
  values: readonly string[];
}

/** Date range, grain, up to two dimension filters and compare, all kept in the URL. */
export function FilterBar({
  dimensions = [],
  ranges,
  defaultRange = "30d",
  compare = true,
  grain = true,
}: {
  dimensions?: readonly FilterDimension[];
  ranges?: readonly RangeKey[];
  defaultRange?: RangeKey;
  compare?: boolean;
  grain?: boolean;
}) {
  const { get, set, pending } = useFilterParams();
  const range = (get("range") as RangeKey | null) ?? defaultRange;
  return (
    <div className="filter-bar">
      <ListFilter size={15} className="muted" />
      <RangeSelect
        value={range}
        options={ranges}
        onChange={(v) => set({ range: v === defaultRange ? null : v })}
      />
      {grain ? (
        <GrainSelect value={get("grain") as Grain | null} onChange={(g) => set({ grain: g })} />
      ) : null}
      {dimensions.map((d) => (
        <DimensionSelect
          key={d.param}
          label={d.label}
          values={d.values}
          value={get(d.param)}
          onChange={(v) => set({ [d.param]: v })}
        />
      ))}
      {compare ? (
        <CompareToggle
          value={get("compare") === "1"}
          onChange={(v) => set({ compare: v ? "1" : null })}
        />
      ) : null}
      {pending ? <LoaderCircle size={15} className="spin muted" /> : null}
    </div>
  );
}

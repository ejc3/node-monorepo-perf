"use client";

import { ListFilter, LoaderCircle } from "lucide-react";
import { RANGES } from "@/data/calendar";
import { effectiveGrain } from "@/data/filters";
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
  // what the server rendered: an unknown range falls back to the default there too
  const asked = get("range");
  const range = asked && Object.hasOwn(RANGES, asked) ? (asked as RangeKey) : defaultRange;
  // a grain the server overrode (daily over a year) is not shown as selected
  const askedGrain = get("grain");
  const valid = askedGrain === "day" || askedGrain === "week" || askedGrain === "month";
  const shownGrain =
    valid && effectiveGrain(range, askedGrain as Grain) === askedGrain
      ? (askedGrain as Grain)
      : null;
  return (
    <div className="filter-bar">
      <ListFilter size={15} className="muted" />
      <RangeSelect
        value={range}
        options={ranges}
        onChange={(v) => set({ range: v === defaultRange ? null : v })}
      />
      {grain ? <GrainSelect value={shownGrain} onChange={(g) => set({ grain: g })} /> : null}
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

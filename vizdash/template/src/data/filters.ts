import { z } from "zod";
import { RANGES } from "./calendar";
import type { Filters, Grain, RangeKey } from "./types";

export type SearchParams = Record<string, string | string[] | undefined>;

const rangeKeys = Object.keys(RANGES) as [RangeKey, ...RangeKey[]];

// Every field falls back instead of failing: a hand-edited URL renders the default
// view, it never errors the page.
const FilterSchema = z.object({
  range: z.enum(rangeKeys).optional().catch(undefined),
  grain: z.enum(["day", "week", "month"]).optional().catch(undefined),
  segment: z.string().trim().min(1).max(48).optional().catch(undefined),
  region: z.string().trim().min(1).max(48).optional().catch(undefined),
  compare: z
    .enum(["1", "0"])
    .optional()
    .transform((v) => v === "1")
    .catch(false),
});

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseFilters(sp: SearchParams, defaults: Partial<Filters> = {}): Filters {
  const raw = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, first(v)]));
  const p = FilterSchema.parse(raw);
  // a missing or unknown range is the dashboard's default
  const range = p.range ?? defaults.range ?? "30d";
  return {
    range,
    grain: effectiveGrain(range, p.grain ?? null),
    segment: p.segment ?? defaults.segment ?? null,
    region: p.region ?? defaults.region ?? null,
    compare: p.compare,
  };
}

/**
 * The grain a range is drawn at: the one asked for, except daily points over a year or
 * more (365 points) which fall back to the range's own grain. The filter bar shows the
 * same value the server used.
 */
export function effectiveGrain(range: RangeKey, asked: Grain | null): Grain {
  return asked && !(asked === "day" && (range === "12m" || range === "ytd"))
    ? asked
    : RANGES[range].grain;
}

/** Stable string of the filters that change data. */
export function filtersKey(f: Filters): string {
  return [f.range, f.grain, f.segment ?? "*", f.region ?? "*", f.compare ? "cmp" : ""].join("|");
}

export const DEFAULT_FILTERS: Filters = parseFilters({});

import { z } from "zod";
import { RANGES } from "./calendar";
import type { Filters, Grain, RangeKey } from "./types";

export type SearchParams = Record<string, string | string[] | undefined>;

const rangeKeys = Object.keys(RANGES) as [RangeKey, ...RangeKey[]];

// Every field falls back instead of failing: a hand-edited URL renders the default
// view, it never errors the page.
const FilterSchema = z.object({
  range: z.enum(rangeKeys).catch("30d"),
  grain: z.enum(["day", "week", "month"]).optional().catch(undefined),
  segment: z.string().trim().min(1).max(48).optional().catch(undefined),
  region: z.string().trim().min(1).max(48).optional().catch(undefined),
  compare: z
    .enum(["1", "0"])
    .optional()
    .transform((v) => v === "1")
    .catch(false),
  q: z.string().trim().max(80).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  sort: z
    .string()
    .regex(/^-?[a-z0-9_]{1,40}$/)
    .optional()
    .catch(undefined),
});

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function parseFilters(sp: SearchParams, defaults: Partial<Filters> = {}): Filters {
  const raw = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, first(v)]));
  const p = FilterSchema.parse({ range: defaults.range, ...raw, page: raw.page ?? 1 });
  // a grain finer than a day per bucket over a year would draw 365 points: cap it
  const grain: Grain =
    p.grain && !(p.grain === "day" && (p.range === "12m" || p.range === "ytd"))
      ? p.grain
      : RANGES[p.range].grain;
  return {
    range: p.range,
    grain,
    segment: p.segment ?? defaults.segment ?? null,
    region: p.region ?? defaults.region ?? null,
    compare: p.compare,
    q: p.q ?? "",
    page: p.page,
    sort: p.sort ?? null,
  };
}

/** Stable string of the filters that change data (not paging or sorting). */
export function filtersKey(f: Filters): string {
  return [f.range, f.grain, f.segment ?? "*", f.region ?? "*", f.compare ? "cmp" : ""].join("|");
}

export const DEFAULT_FILTERS: Filters = parseFilters({});

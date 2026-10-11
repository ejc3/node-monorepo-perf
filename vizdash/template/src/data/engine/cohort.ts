import { format, subMonths, subWeeks } from "date-fns";
import { ANCHOR } from "../calendar";
import { rng } from "../rng";
import type { CohortRow, FunnelStep, QueryContext } from "../types";
import { sliceLevel, streamKey } from "./model";

/**
 * Retention by signup cohort: row i is the cohort that started i periods before the
 * newest one; values[k] is the share still active k periods later (values[0] = 1).
 */
export function cohorts(
  ctx: QueryContext,
  opts: { periods?: number; grain?: "week" | "month"; baseSize?: number; floor?: number } = {},
): CohortRow[] {
  const periods = opts.periods ?? 10;
  const grain = opts.grain ?? "month";
  const r = rng(...streamKey(ctx, "cohort", periods, grain));
  const floor = opts.floor ?? r.range(0.18, 0.34);
  const tau = r.range(1.4, 3.2);
  return Array.from({ length: periods }, (_, i) => {
    const age = periods - 1 - i; // how many periods this cohort has been observed
    const start = grain === "month" ? subMonths(ANCHOR, age) : subWeeks(ANCHOR, age);
    const quality = 1 + r.normal(0, 0.06) + i * 0.006; // newer cohorts retain slightly better
    const values = Array.from({ length: age + 1 }, (_, k) =>
      k === 0 ? 1 : Math.min(1, (floor + (1 - floor) * Math.exp(-k / tau)) * quality),
    );
    return {
      label: format(start, grain === "month" ? "MMM yyyy" : "'Wk of' MMM d"),
      size: Math.round((opts.baseSize ?? 4200) * sliceLevel(ctx) * (0.85 + r.next() * 0.3)),
      values,
    };
  });
}

/** A conversion funnel through `steps`, starting from `top` entrants. */
export function funnel(ctx: QueryContext, steps: readonly string[], top: number): FunnelStep[] {
  const r = rng(...streamKey(ctx, "funnel", ...steps));
  let value = top * sliceLevel(ctx);
  const first = value;
  return steps.map((step, i) => {
    const rate = i === 0 ? 1 : r.range(0.32, 0.82);
    value = i === 0 ? value : value * rate;
    return { step, value: Math.round(value), rate, overall: value / first };
  });
}

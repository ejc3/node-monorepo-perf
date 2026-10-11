import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  eachMonthOfInterval,
  eachWeekOfInterval,
  endOfMonth,
  endOfWeek,
  formatISO,
  getDayOfYear,
  isWeekend,
  min,
  parseISO,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";
import type { Grain, RangeKey } from "./types";

/** "Today" for every dashboard: fixed, so pages render the same data on any date. */
export const ANCHOR = new Date(2026, 5, 30);

export const RANGES: Record<RangeKey, { label: string; grain: Grain }> = {
  "7d": { label: "Last 7 days", grain: "day" },
  "30d": { label: "Last 30 days", grain: "day" },
  "90d": { label: "Last 90 days", grain: "week" },
  "6m": { label: "Last 6 months", grain: "week" },
  "12m": { label: "Last 12 months", grain: "month" },
  ytd: { label: "Year to date", grain: "month" },
};

export interface Interval {
  start: Date;
  end: Date;
}

export function rangeInterval(range: RangeKey, end: Date = ANCHOR): Interval {
  switch (range) {
    case "7d":
      return { start: subDays(end, 6), end };
    case "30d":
      return { start: subDays(end, 29), end };
    case "90d":
      return { start: subDays(end, 89), end };
    case "6m":
      return { start: addDays(subMonths(end, 6), 1), end };
    case "12m":
      return { start: addDays(subMonths(end, 12), 1), end };
    case "ytd":
      return { start: startOfYear(end), end };
  }
}

/** The interval of equal length just before `iv`, for period-over-period deltas. */
export function previousInterval(iv: Interval): Interval {
  const days = differenceInCalendarDays(iv.end, iv.start) + 1;
  return { start: subDays(iv.start, days), end: subDays(iv.end, days) };
}

export interface Bucket {
  key: string;
  start: Date;
  end: Date;
  days: number;
}

export function buckets(iv: Interval, grain: Grain): Bucket[] {
  const starts =
    grain === "day"
      ? eachDayOfInterval(iv)
      : grain === "week"
        ? eachWeekOfInterval(iv, { weekStartsOn: 1 })
        : eachMonthOfInterval(iv);
  return starts.map((s) => {
    const start = s < iv.start ? iv.start : s;
    const end =
      grain === "day"
        ? s
        : grain === "week"
          ? min([endOfWeek(s, { weekStartsOn: 1 }), iv.end])
          : min([endOfMonth(s), iv.end]);
    return {
      key: formatISO(start, { representation: "date" }),
      start,
      end,
      days: differenceInCalendarDays(end, start) + 1,
    };
  });
}

export function daysOf(iv: Interval): Date[] {
  return eachDayOfInterval(iv);
}

/** Position of a day in the yearly cycle, in [0, 1). */
export function yearPhase(d: Date): number {
  return (getDayOfYear(d) - 1) / 365;
}

/** Years since the anchor (negative in the past); drives each metric's trend. */
export function yearsFromAnchor(d: Date): number {
  return differenceInCalendarDays(d, ANCHOR) / 365;
}

export function weekdayFactor(d: Date): number {
  return isWeekend(d) ? 0.62 : 1.08;
}

export const isoDay = (d: Date) => formatISO(d, { representation: "date" });
export const fromIso = (s: string) => parseISO(s);

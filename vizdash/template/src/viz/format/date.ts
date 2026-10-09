import { format, parseISO } from "date-fns";
import { timeFormat } from "d3-time-format";
import type { Grain } from "@/data/types";

const axisDay = timeFormat("%b %-d");
const axisMonth = timeFormat("%b %y");

/** A bucket key (ISO date) as an axis tick. */
export function formatBucket(iso: string, grain: Grain): string {
  const d = parseISO(iso);
  return grain === "month" ? axisMonth(d) : axisDay(d);
}

/** A bucket key as a tooltip heading. */
export function formatBucketLong(iso: string, grain: Grain): string {
  const d = parseISO(iso);
  if (grain === "month") return format(d, "MMMM yyyy");
  if (grain === "week") return `Week of ${format(d, "MMM d, yyyy")}`;
  return format(d, "EEE, MMM d, yyyy");
}

export function formatDate(iso: string): string {
  return format(parseISO(iso), "MMM d, yyyy");
}

import { formatDuration as fnsDuration, intervalToDuration } from "date-fns";

/** Durations are stored in milliseconds. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const d = intervalToDuration({ start: 0, end: Math.round(ms) });
  const short = fnsDuration(d, {
    format: ["days", "hours", "minutes"],
    zero: false,
    delimiter: " ",
  });
  return short
    .replace(/ days?/, "d")
    .replace(/ hours?/, "h")
    .replace(/ minutes?/, "m");
}

export function formatDays(days: number): string {
  if (!Number.isFinite(days)) return "–";
  return days < 10 ? `${days.toFixed(1)} days` : `${Math.round(days)} days`;
}

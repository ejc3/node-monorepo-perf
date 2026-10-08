import { deviation, greatest, least, mean } from "d3-array";
import { maxBy, minBy } from "lodash-es";
import { Lightbulb, TrendingDown, TrendingUp } from "lucide-react";
import type { BreakdownResult, Direction, Kpi, TimeseriesResult } from "@/data/types";
import { formatBucketLong, formatDelta, formatMetric, formatPercent } from "../format";

export interface Insight {
  tone: "good" | "bad" | "neutral";
  text: string;
}

const tone = (change: number, good: Direction): Insight["tone"] =>
  Math.abs(change) < 0.01 ? "neutral" : change > 0 === (good === "up") ? "good" : "bad";

// Bucket values comparable across buckets: totals per day (a range's first and last
// week or month can be partial), averages as they are.
function rate(ts: TimeseriesResult, row: TimeseriesResult["rows"][number], key: string): number {
  const v = Number(row[key]);
  return ts.agg === "sum" ? v / (Number(row.__days) || 1) : v;
}

/** First vs last bucket of the first series. */
export function trendInsight(
  label: string,
  ts: TimeseriesResult,
  good: Direction = "up",
): Insight | null {
  const key = ts.series[0]?.key;
  if (!key || ts.rows.length < 2) return null;
  const first = rate(ts, ts.rows[0], key);
  const last = rate(ts, ts.rows[ts.rows.length - 1], key);
  if (!first) return null;
  const change = last / first - 1;
  return {
    tone: tone(change, good),
    text: `${label} ${change >= 0 ? "rose" : "fell"} ${formatDelta(change)} from the first to the last ${ts.grain} of the range.`,
  };
}

/** The bucket furthest from the mean, if it is more than two standard deviations out. */
export function spikeInsight(label: string, ts: TimeseriesResult): Insight | null {
  const key = ts.series[0]?.key;
  if (!key) return null;
  const at = (r: TimeseriesResult["rows"][number]) => rate(ts, r, key);
  const vals = ts.rows.map(at);
  const m = mean(vals) ?? 0;
  const sd = deviation(vals) ?? 0;
  if (!sd) return null;
  const hi = greatest(ts.rows, (a, b) => at(a) - at(b))!;
  const lo = least(ts.rows, (a, b) => at(a) - at(b))!;
  const pick = Math.abs(at(hi) - m) >= Math.abs(at(lo) - m) ? hi : lo;
  const z = (at(pick) - m) / sd;
  if (Math.abs(z) < 2) return null;
  return {
    tone: "neutral",
    text: `${label} was unusually ${z > 0 ? "high" : "low"} in ${formatBucketLong(pick.date, ts.grain)} (${formatMetric(Number(pick[key]), ts.unit)}, ${Math.abs(z).toFixed(1)}σ).`,
  };
}

const named = (b: BreakdownResult) => b.rows.filter((r) => r.key !== "other");

export function leaderInsight(label: string, b: BreakdownResult): Insight | null {
  const top = maxBy(named(b), "value");
  if (!top) return null;
  // a share of the total only means something for totals, not for averages or rates
  const share = b.agg === "sum" ? ` (${formatPercent(top.share)} of total)` : "";
  return {
    tone: "neutral",
    text: `${top.label} leads ${label} with ${formatMetric(top.value, b.unit, { compact: true })}${share}.`,
  };
}

export function moverInsight(
  label: string,
  b: BreakdownResult,
  good: Direction = "up",
): Insight | null {
  const up = maxBy(named(b), "delta");
  const down = minBy(named(b), "delta");
  if (!up || !down) return null;
  const big = Math.abs(up.delta) >= Math.abs(down.delta) ? up : down;
  return {
    tone: tone(big.delta, good),
    text: `Biggest mover in ${label}: ${big.label} (${formatDelta(big.delta)} vs previous period).`,
  };
}

export function kpiInsight(k: Kpi): Insight {
  return {
    tone: tone(k.delta, k.good),
    text: `${k.label} is ${formatMetric(k.value, k.unit, { compact: true })}, ${formatDelta(k.delta)} vs the previous period.`,
  };
}

/** Drops nulls and keeps at most `max` insights, bad news first. */
export function rankInsights(list: readonly (Insight | null)[], max = 4): Insight[] {
  const order = { bad: 0, good: 1, neutral: 2 };
  return list
    .filter((i): i is Insight => i !== null)
    .sort((a, b) => order[a.tone] - order[b.tone])
    .slice(0, max);
}

export function InsightList({ insights }: { insights: readonly Insight[] }) {
  if (!insights.length) return null;
  return (
    <ul className="insights">
      {insights.map((i, n) => {
        const Icon = i.tone === "good" ? TrendingUp : i.tone === "bad" ? TrendingDown : Lightbulb;
        return (
          <li key={n} className={`insight insight--${i.tone}`}>
            <Icon size={14} />
            <span>{i.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

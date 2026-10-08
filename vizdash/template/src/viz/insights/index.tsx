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

/** First vs last bucket of the first series. */
export function trendInsight(
  label: string,
  ts: TimeseriesResult,
  good: Direction = "up",
): Insight | null {
  const key = ts.series[0]?.key;
  if (!key || ts.rows.length < 2) return null;
  const first = Number(ts.rows[0][key]);
  const last = Number(ts.rows[ts.rows.length - 1][key]);
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
  const vals = ts.rows.map((r) => Number(r[key]));
  const m = mean(vals) ?? 0;
  const sd = deviation(vals) ?? 0;
  if (!sd) return null;
  const hi = greatest(ts.rows, (a, b) => Number(a[key]) - Number(b[key]))!;
  const lo = least(ts.rows, (a, b) => Number(a[key]) - Number(b[key]))!;
  const pick = Math.abs(Number(hi[key]) - m) >= Math.abs(Number(lo[key]) - m) ? hi : lo;
  const z = (Number(pick[key]) - m) / sd;
  if (Math.abs(z) < 2) return null;
  return {
    tone: "neutral",
    text: `${label} was unusually ${z > 0 ? "high" : "low"} in ${formatBucketLong(pick.date, ts.grain)} (${formatMetric(Number(pick[key]), ts.unit)}, ${Math.abs(z).toFixed(1)}σ).`,
  };
}

export function leaderInsight(label: string, b: BreakdownResult): Insight | null {
  const top = maxBy(b.rows, "value");
  if (!top) return null;
  return {
    tone: "neutral",
    text: `${top.label} leads ${label} with ${formatMetric(top.value, b.unit, { compact: true })} (${formatPercent(top.share)} of total).`,
  };
}

export function moverInsight(
  label: string,
  b: BreakdownResult,
  good: Direction = "up",
): Insight | null {
  const up = maxBy(b.rows, "delta");
  const down = minBy(b.rows, "delta");
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

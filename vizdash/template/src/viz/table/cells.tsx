"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import clsx from "clsx";
import type { Direction, Unit } from "@/data/types";
import { Sparkline } from "../charts/Sparkline";
import { formatDelta, formatMetric } from "../format";
import { BAD, GOOD, seriesColor } from "../theme";

export function MetricCell({ value, unit }: { value: number; unit: Unit }) {
  return (
    <span className="tabular">
      {formatMetric(value, unit, { compact: unit === "currency" || unit === "count" })}
    </span>
  );
}

export function DeltaCell({ value, good = "up" }: { value: number; good?: Direction }) {
  const positive = good === "up" ? value >= 0 : value <= 0;
  return (
    <span className={clsx("delta", positive ? "delta--good" : "delta--bad")}>
      {formatDelta(value)}
    </span>
  );
}

const STATUS_TONE: Record<string, string> = {
  won: "good",
  active: "good",
  healthy: "good",
  paid: "good",
  delivered: "good",
  resolved: "good",
  live: "good",
  shipped: "good",
  hired: "good",
  approved: "good",
  operational: "good",
  "on track": "good",
  lost: "bad",
  churned: "bad",
  failed: "bad",
  overdue: "bad",
  breached: "bad",
  critical: "bad",
  outage: "bad",
  "at risk": "warn",
  degraded: "warn",
  pending: "warn",
  delayed: "warn",
  open: "warn",
  escalated: "warn",
};

export function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status.toLowerCase()] ?? "neutral";
  return <span className={`pill pill--${tone}`}>{status}</span>;
}

export function TrendCell({
  values,
  good = "up",
}: {
  values: readonly number[];
  good?: Direction;
}) {
  const up = values[values.length - 1] >= values[0];
  const color = (good === "up") === up ? GOOD : BAD;
  return (
    <Sparkline
      values={values}
      width={84}
      height={22}
      color={values.length ? color : seriesColor(0)}
      fill={false}
    />
  );
}

// the dashboard filters a drill-down page reads; the link carries the current ones
const KEPT = ["range", "grain", "segment", "region", "compare"];

export function LinkCell({ href, label, sub }: { href: string; label: string; sub?: string }) {
  const params = useSearchParams();
  const kept = new URLSearchParams();
  for (const k of KEPT) {
    const v = params.get(k);
    if (v !== null) kept.set(k, v);
  }
  const qs = kept.toString();
  return (
    <span className="link-cell">
      <Link href={qs ? `${href}?${qs}` : href} prefetch={false}>
        {label}
      </Link>
      {sub ? <span className="muted">{sub}</span> : null}
    </span>
  );
}

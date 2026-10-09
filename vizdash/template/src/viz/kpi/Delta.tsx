import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import clsx from "clsx";
import type { Direction } from "@/data/types";
import { formatDelta } from "../format";

/** Period-over-period change, green when it moves in the metric's good direction. */
export function Delta({ value, good, label }: { value: number; good: Direction; label?: string }) {
  const flat = Math.abs(value) < 0.0005;
  const positive = good === "up" ? value > 0 : value < 0;
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={clsx("delta", flat ? "delta--flat" : positive ? "delta--good" : "delta--bad")}>
      <Icon size={13} strokeWidth={2.4} />
      {formatDelta(value)}
      {label ? <span className="delta__label">{label}</span> : null}
    </span>
  );
}

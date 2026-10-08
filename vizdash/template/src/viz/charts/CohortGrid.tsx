import type { CohortRow } from "@/data/types";
import { formatNumber, formatPercent } from "../format";
import { sequential } from "../theme/scales";

/** Retention triangle: one row per cohort, one column per period since start. */
export function CohortGrid({
  rows,
  periodLabel = "M",
}: {
  rows: readonly CohortRow[];
  periodLabel?: string;
}) {
  const periods = Math.max(...rows.map((r) => r.values.length));
  const color = sequential(0.1, 1, "purples");
  return (
    <div className="cohort">
      <table>
        <thead>
          <tr>
            <th>Cohort</th>
            <th className="num">Size</th>
            {Array.from({ length: periods }, (_, k) => (
              <th key={k} className="num">{`${periodLabel}${k}`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th>{r.label}</th>
              <td className="num">{formatNumber(r.size)}</td>
              {Array.from({ length: periods }, (_, k) =>
                k < r.values.length ? (
                  <td
                    key={k}
                    className="num cohort__cell"
                    style={{
                      background: color(r.values[k]),
                      color: r.values[k] > 0.55 ? "white" : undefined,
                    }}
                  >
                    {formatPercent(r.values[k])}
                  </td>
                ) : (
                  <td key={k} />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

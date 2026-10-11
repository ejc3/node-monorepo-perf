import { isNumber } from "lodash-es";
import type { RecordRow } from "./types";

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = isNumber(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** RFC 4180 CSV of plain objects; columns default to the first row's keys. */
export function toCsv(
  rows: readonly Record<string, unknown>[],
  columns?: readonly string[],
): string {
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const lines = [cols.map(cell).join(",")];
  for (const row of rows) lines.push(cols.map((c) => cell(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Entity rows flattened for export: one column per metric. */
export function flattenRecords(rows: readonly RecordRow[]): Record<string, unknown>[] {
  return rows.map(({ values, trend: _trend, ...rest }) => ({ ...rest, ...values }));
}

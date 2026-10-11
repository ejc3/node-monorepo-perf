"use client";

import { createColumnHelper, type ColumnDef } from "@tanstack/react-table";
import type { Direction, RecordRow, Unit } from "@/data/types";
import { DeltaCell, LinkCell, MetricCell, StatusPill, TrendCell } from "./cells";

const col = createColumnHelper<RecordRow>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RecordColumn = ColumnDef<RecordRow, any>;

/** The entity name, linking to its drill-down page when `href` is given. */
export function nameColumn(header: string, href?: (row: RecordRow) => string): RecordColumn {
  return col.accessor("name", {
    header,
    cell: (c) =>
      href ? (
        <LinkCell href={href(c.row.original)} label={c.getValue()} sub={c.row.original.id} />
      ) : (
        c.getValue()
      ),
  });
}

export function ownerColumn(header = "Owner"): RecordColumn {
  return col.accessor("owner", { header });
}

export function statusColumn(header = "Status"): RecordColumn {
  return col.accessor("status", { header, cell: (c) => <StatusPill status={c.getValue()} /> });
}

export function metricColumn(key: string, header: string, unit: Unit): RecordColumn {
  return col.accessor((r) => r.values[key] ?? 0, {
    id: key,
    header,
    cell: (c) => <MetricCell value={c.getValue()} unit={unit} />,
    meta: { numeric: true },
  });
}

export function deltaColumn(header = "Change", good: Direction = "up"): RecordColumn {
  return col.accessor("delta", {
    header,
    cell: (c) => <DeltaCell value={c.getValue()} good={good} />,
    meta: { numeric: true },
  });
}

export function trendColumn(header = "12-week trend", good: Direction = "up"): RecordColumn {
  return col.accessor("trend", {
    header,
    enableSorting: false,
    cell: (c) => <TrendCell values={c.getValue()} good={good} />,
  });
}

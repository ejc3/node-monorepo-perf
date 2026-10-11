"use client";

import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Pagination } from "./Pagination";
import { TableToolbar } from "./TableToolbar";

export interface DataTableProps<T> {
  data: T[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[];
  pageSize?: number;
  initialSort?: SortingState;
  searchPlaceholder?: string;
  /** file name for the toolbar's CSV download; no download button when absent */
  csvName?: string;
  toCsvRow?: (row: T) => Record<string, unknown>;
  dense?: boolean;
}

/** Sortable, searchable, paginated table over rows already in the browser. */
export function DataTable<T>({
  data,
  columns,
  pageSize = 10,
  initialSort = [],
  searchPlaceholder = "Search",
  csvName,
  toCsvRow,
  dense,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSort);
  const [globalFilter, setGlobalFilter] = useState("");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize });
  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, pagination },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: "includesString",
  });
  const filteredRows = table.getFilteredRowModel().rows;
  const csvRows = useMemo(
    () => (toCsvRow ? filteredRows.map((r) => toCsvRow(r.original)) : []),
    [filteredRows, toCsvRow],
  );
  return (
    <div className={dense ? "data-table data-table--dense" : "data-table"}>
      <TableToolbar
        value={globalFilter}
        onChange={(v) => {
          setGlobalFilter(v);
          setPagination((p) => ({ ...p, pageIndex: 0 }));
        }}
        placeholder={searchPlaceholder}
        count={filteredRows.length}
        csvName={toCsvRow ? csvName : undefined}
        csvRows={csvRows}
      />
      <div className="data-table__scroll">
        <table>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  const meta = h.column.columnDef.meta as { numeric?: boolean } | undefined;
                  return (
                    <th key={h.id} className={meta?.numeric ? "num" : undefined}>
                      {h.isPlaceholder ? null : h.column.getCanSort() ? (
                        <button
                          className="sort-button"
                          onClick={h.column.getToggleSortingHandler()}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === "asc" ? (
                            <ArrowUp size={12} />
                          ) : sorted === "desc" ? (
                            <ArrowDown size={12} />
                          ) : (
                            <ArrowUpDown size={12} className="muted" />
                          )}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as { numeric?: boolean } | undefined;
                  return (
                    <td key={cell.id} className={meta?.numeric ? "num" : undefined}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="data-table__empty">
                  No rows match “{globalFilter}”.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pagination
        page={table.getState().pagination.pageIndex}
        pageCount={table.getPageCount()}
        canPrev={table.getCanPreviousPage()}
        canNext={table.getCanNextPage()}
        onPage={(p) => table.setPageIndex(p)}
      />
    </div>
  );
}

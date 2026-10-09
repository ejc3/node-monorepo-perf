"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

export function Pagination({
  page,
  pageCount,
  canPrev,
  canNext,
  onPage,
}: {
  page: number;
  pageCount: number;
  canPrev: boolean;
  canNext: boolean;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav className="pagination" aria-label="Table pages">
      <button
        className="icon-button"
        disabled={!canPrev}
        onClick={() => onPage(0)}
        aria-label="First page"
      >
        <ChevronsLeft size={14} />
      </button>
      <button
        className="icon-button"
        disabled={!canPrev}
        onClick={() => onPage(page - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft size={14} />
      </button>
      <span className="pagination__label">
        Page {page + 1} of {pageCount}
      </span>
      <button
        className="icon-button"
        disabled={!canNext}
        onClick={() => onPage(page + 1)}
        aria-label="Next page"
      >
        <ChevronRight size={14} />
      </button>
      <button
        className="icon-button"
        disabled={!canNext}
        onClick={() => onPage(pageCount - 1)}
        aria-label="Last page"
      >
        <ChevronsRight size={14} />
      </button>
    </nav>
  );
}

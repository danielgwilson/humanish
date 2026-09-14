import { useState, type ReactNode } from "react";
import type { ObserverData } from "@/lib/observer-data";
import { Popover } from "./ui/popover";
import { ReviewIcon } from "./review-icon";

export interface GridFilters {
  status: string;
  kind: string;
  query: string;
}

export function GridOptions({ data, filters, onFilters, gridControl, onMonitor }: {
  data: ObserverData;
  filters: GridFilters;
  onFilters: (next: GridFilters) => void;
  gridControl?: ReactNode;
  onMonitor?: () => void;
}) {
  const [viewOpen, setViewOpen] = useState(false);
  const statuses = [...new Set(data.streams.map((s) => s.statusLabel))];
  const kinds = [...new Set(data.streams.map((s) => s.kindLabel))];
  const activeFilters = (filters.status === "" ? 0 : 1) + (filters.kind === "" ? 0 : 1) + (filters.query === "" ? 0 : 1);
  return (
    <Popover
      triggerClassName="filter-btn"
      label="View and filter participants" title="View options"
      open={viewOpen} onOpenChange={setViewOpen}
      trigger={
        <>
          <ReviewIcon name="options" />
          {activeFilters > 0 ? <span className="filter-count">{activeFilters}</span> : null}
        </>
      }
    >
      <label className="tool">
        <span className="o-label">Status</span>
        <select value={filters.status} onChange={(e) => onFilters({ ...filters, status: e.target.value })}>
          <option value="">All</option>
          <option value="__active">Running / preparing</option>
          {statuses.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </label>
      <label className="tool">
        <span className="o-label">Kind</span>
        <select value={filters.kind} onChange={(e) => onFilters({ ...filters, kind: e.target.value })}>
          <option value="">All</option>
          {kinds.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </label>
      <span className="searchbox">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input
          type="search"
          placeholder="Find a participant…"
          aria-label="Search participants"
          onKeyDown={(event) => {
            // Chrome otherwise clears a search input on Escape before the
            // popover closes, silently discarding the persisted filter.
            if (event.key === "Escape") { event.preventDefault(); setViewOpen(false); }
          }}
          value={filters.query}
          onChange={(e) => onFilters({ ...filters, query: e.target.value })}
        />
      </span>
      {gridControl}
      {onMonitor ? <button type="button" className="review-tool" onClick={() => { setViewOpen(false); onMonitor(); }}>Monitor</button> : null}
      {activeFilters > 0 ? (
        <button type="button" className="filter-clear" onClick={() => onFilters({ status: "", kind: "", query: "" })}>
          Clear filters
        </button>
      ) : null}
    </Popover>
  );
}

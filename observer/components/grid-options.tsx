import { useState, type ReactNode } from "react";
import type { ObserverData } from "@/lib/observer-data";
import { Select } from "./ui/select";
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
        <Select label="Participant status" value={filters.status} onValueChange={(status) => onFilters({ ...filters, status })}
          options={[{ value: "", label: "All" }, { value: "__active", label: "Running / preparing" }, ...statuses.map((status) => ({ value: status, label: status }))]} />
      </label>
      <label className="tool">
        <span className="o-label">Kind</span>
        <Select label="Participant kind" value={filters.kind} onValueChange={(kind) => onFilters({ ...filters, kind })}
          options={[{ value: "", label: "All" }, ...kinds.map((kind) => ({ value: kind, label: kind }))]} />
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

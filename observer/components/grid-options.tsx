import { useState } from "react";
import { activeFilterCount, NO_FILTERS, statusCounts, type GridFilters } from "@/lib/grid-filters";
import type { ObserverData } from "@/lib/observer-data";
import { isDensity, type GridDensity } from "@/lib/preferences";
import { Select } from "./ui/select";
import { Popover } from "./ui/popover";
import { ReviewIcon } from "./review-icon";

export function GridOptions({
  data,
  filters,
  onFilters,
  density,
  onDensity,
  onMonitor,
}: {
  data: ObserverData;
  filters: GridFilters;
  onFilters: (next: GridFilters) => void;
  density: GridDensity;
  onDensity: (next: GridDensity) => void;
  onMonitor?: () => void;
}) {
  const [viewOpen, setViewOpen] = useState(false);
  const statuses = [...new Set(data.streams.map((s) => s.statusLabel))];
  const kinds = [...new Set(data.streams.map((s) => s.kindLabel))];
  const personas = [...new Set(data.streams.map((s) => s.sim.personaId))];
  const activeFilters = activeFilterCount(filters);
  return (
    <Popover
      triggerClassName="filter-btn"
      label="View and filter participants"
      title="View options"
      open={viewOpen}
      onOpenChange={setViewOpen}
      trigger={
        <>
          <ReviewIcon name="options" />
          {activeFilters > 0 ? <span className="filter-count">{activeFilters}</span> : null}
        </>
      }
    >
      <label className="tool">
        <span className="o-label">Status</span>
        <Select
          label="Participant status"
          value={filters.status}
          onValueChange={(status) => onFilters({ ...filters, status })}
          options={[
            { value: "", label: "All" },
            { value: "__active", label: "Running / preparing" },
            ...statuses.map((status) => ({ value: status, label: status })),
          ]}
        />
      </label>
      <label className="tool">
        <span className="o-label">Kind</span>
        <Select
          label="Participant kind"
          value={filters.kind}
          onValueChange={(kind) => onFilters({ ...filters, kind })}
          options={[
            { value: "", label: "All" },
            ...kinds.map((kind) => ({ value: kind, label: kind })),
          ]}
        />
      </label>
      {personas.length > 1 ? (
        <label className="tool">
          <span className="o-label">Persona</span>
          <Select
            label="Participant persona"
            value={filters.persona ?? ""}
            onValueChange={(persona) => onFilters({ ...filters, persona })}
            options={[
              { value: "", label: "All" },
              ...personas.map((persona) => ({ value: persona, label: persona })),
            ]}
          />
        </label>
      ) : null}
      <span className="searchbox">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          placeholder="Find a participant…"
          aria-label="Search participants"
          onKeyDown={(event) => {
            // Chrome otherwise clears a search input on Escape before the
            // popover closes, silently discarding the persisted filter.
            if (event.key === "Escape") {
              event.preventDefault();
              setViewOpen(false);
            }
          }}
          value={filters.query}
          onChange={(e) => onFilters({ ...filters, query: e.target.value })}
        />
      </span>
      <label className="tool">
        <span className="o-label">Preview size</span>
        <Select
          label="Preview size"
          value={density}
          onValueChange={(value) => {
            if (isDensity(value)) onDensity(value);
          }}
          options={[
            { value: "compact", label: "Compact" },
            { value: "comfortable", label: "Comfortable" },
            { value: "large", label: "Large" },
          ]}
        />
      </label>
      {onMonitor ? (
        <button
          type="button"
          className="review-tool"
          onClick={() => {
            setViewOpen(false);
            onMonitor();
          }}
        >
          Monitor
        </button>
      ) : null}
      {activeFilters > 0 ? (
        <button type="button" className="filter-clear" onClick={() => onFilters(NO_FILTERS)}>
          Clear filters
        </button>
      ) : null}
    </Popover>
  );
}

/**
 * One button per status with its participant count, for a run whose participants end more than
 * one way. A button filters the grid to that status, and pressing it again shows everyone.
 */
export function GridStatusSummary({
  data,
  filters,
  onFilters,
}: {
  data: ObserverData;
  filters: GridFilters;
  onFilters: (next: GridFilters) => void;
}) {
  const counts = statusCounts(data.streams);
  if (counts.length < 2) return null;
  return (
    <fieldset className="grid-status">
      <legend className="sr-only">Participants by status</legend>
      {counts.map(([status, count]) => (
        <button
          key={status}
          type="button"
          className="review-tool"
          aria-pressed={filters.status === status}
          onClick={() => onFilters({ ...filters, status: filters.status === status ? "" : status })}
        >
          {status} <span className="grid-status-count">{count}</span>
        </button>
      ))}
    </fieldset>
  );
}

import type { ObserverData, ObserverStream } from "@/lib/observer-data";

import { Popover } from "./ui/popover";
import { Wordmark } from "./wordmark";

export interface GridFilters {
  status: string;
  kind: string;
  query: string;
}

export interface TopbarProps {
  data: ObserverData;
  selected: ObserverStream | null;
  filters: GridFilters;
  onFilters: (next: GridFilters) => void;
  onRuns: () => void;
  onStep: (delta: number) => void;
  onLibrary: () => void;
  sideOpen: boolean;
}

// Frame.io-style chrome: wordmark first, then breadcrumbs with a caret on the leaf.
// Grid view carries the working filters; the participant view swaps them for a pager.
export function Topbar({ data, selected, filters, onFilters, onRuns, onStep, onLibrary, sideOpen }: TopbarProps) {
  const statuses = [...new Set(data.streams.map((s) => s.statusLabel))];
  const kinds = [...new Set(data.streams.map((s) => s.kindLabel))];
  const activeFilters = (filters.status === "" ? 0 : 1) + (filters.kind === "" ? 0 : 1) + (filters.query === "" ? 0 : 1);
  const index = selected ? data.streams.findIndex((s) => s.id === selected.id) : -1;

  return (
    <div className="topbar">
      <button
        type="button"
        className="side-toggle"
        aria-label="Toggle run library"
        aria-expanded={sideOpen}
        onClick={onLibrary}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <rect x="1" y="1.5" width="12" height="11" rx="2" stroke="currentColor" />
          <line x1="5.2" y1="1.5" x2="5.2" y2="12.5" stroke="currentColor" />
        </svg>
      </button>
      <Wordmark label="humanish Observer" />
      <nav className="crumbs" aria-label="Breadcrumbs">
        {selected ? (
          <button type="button" className="crumb-back" aria-label="Back to participants" onClick={onRuns}>
            ‹
          </button>
        ) : null}
        <button type="button" className="crumb-link" onClick={onRuns}>runs</button>
        <span className="sep">/</span>
        <span className="trunc">{data.run.runId}</span>
        <span className="sep">/</span>
        {selected ? (
          <span className="here">{selected.laneId ?? selected.label} ⌄</span>
        ) : (
          <span className="here">participants ⌄</span>
        )}
      </nav>
      <div className="right">
        {selected ? (
          <span className="pager">
            <button type="button" aria-label="Previous participant" onClick={() => onStep(-1)}>‹</button>
            participant {index + 1} / {data.streams.length}
            <button type="button" aria-label="Next participant" onClick={() => onStep(1)}>›</button>
          </span>
        ) : (
          <Popover
            triggerClassName="filter-btn"
            label="Filter participants"
            trigger={
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 5h18l-7 8v5l-4 2v-7L3 5Z" />
                </svg>
                {activeFilters > 0 ? <span className="filter-count">{activeFilters}</span> : null}
              </>
            }
          >
            <label className="tool">
              <span className="o-label">Status</span>
              <select value={filters.status} onChange={(e) => onFilters({ ...filters, status: e.target.value })}>
                <option value="">All</option>
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
                placeholder="Filter participants…"
                aria-label="Filter participants"
                value={filters.query}
                onChange={(e) => onFilters({ ...filters, query: e.target.value })}
              />
            </span>
            {activeFilters > 0 ? (
              <button type="button" className="filter-clear" onClick={() => onFilters({ status: "", kind: "", query: "" })}>
                Clear filters
              </button>
            ) : null}
          </Popover>
        )}
        {data.publicSafety.publishable === false ? (
          <span className="chip chip-dot chip-mute" title={data.publicSafety.note}>local_only</span>
        ) : null}
      </div>
    </div>
  );
}

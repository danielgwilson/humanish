import type { ObserverData, ObserverStream } from "@/lib/observer-data";

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
}

// Frame.io-style chrome: wordmark first, then breadcrumbs with a caret on the leaf.
// Grid view carries the working filters; the participant view swaps them for a pager.
export function Topbar({ data, selected, filters, onFilters, onRuns, onStep }: TopbarProps) {
  const statuses = [...new Set(data.streams.map((s) => s.statusLabel))];
  const kinds = [...new Set(data.streams.map((s) => s.kindLabel))];
  const index = selected ? data.streams.findIndex((s) => s.id === selected.id) : -1;

  return (
    <div className="topbar">
      <Wordmark label="humanish Observer" />
      <nav className="crumbs" aria-label="Breadcrumbs">
        <button type="button" className="crumb-link" onClick={onRuns}>runs</button>
        <span className="sep">/</span>
        <span className="trunc">{data.run.runId}</span>
        <span className="sep">/</span>
        {selected ? (
          <span className="here">{selected.label} ⌄</span>
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
          <>
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
          </>
        )}
        {data.publicSafety.publishable === false ? (
          <span className="chip chip-dot chip-mute" title={data.publicSafety.note}>local_only</span>
        ) : null}
      </div>
    </div>
  );
}

import { useState, type ReactNode } from "react";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";

import { IconButton } from "./ui/icon-button";
import { ReviewIcon } from "./review-icon";
import { participantLabels } from "@/lib/participant-label";
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
  comparison?: boolean;
  filters: GridFilters;
  onFilters: (next: GridFilters) => void;
  onRuns: () => void;
  onStep: (delta: number) => void;
  onLibrary: () => void;
  sideOpen: boolean;
  reviewControl?: ReactNode;
  gridControl?: ReactNode;
  onMonitor?: () => void;
}

// Frame.io-style chrome: wordmark first, then breadcrumbs with a caret on the leaf.
// Grid view carries the working filters; the participant view swaps them for a pager.
export function Topbar({ data, selected, comparison = false, filters, onFilters, onRuns, onStep, onLibrary, sideOpen, reviewControl, gridControl, onMonitor }: TopbarProps) {
  const [viewOpen, setViewOpen] = useState(false);
  const selectedName = selected ? participantLabels(data.streams).get(selected.id) ?? selected.label : null;
  const statuses = [...new Set(data.streams.map((s) => s.statusLabel))];
  const kinds = [...new Set(data.streams.map((s) => s.kindLabel))];
  const activeFilters = (filters.status === "" ? 0 : 1) + (filters.kind === "" ? 0 : 1) + (filters.query === "" ? 0 : 1);
  const index = selected ? data.streams.findIndex((s) => s.id === selected.id) : -1;

  return (
    <div className="topbar">
      <IconButton className="side-toggle" label="Toggle run library" hint="Run library" aria-expanded={sideOpen} onClick={onLibrary}><ReviewIcon name="library" /></IconButton>
      <Wordmark label="humanish Observer" />
      <nav className="crumbs" aria-label="Breadcrumbs">
        {selected ? (
          <IconButton className="crumb-back" label="Back to participants" onClick={onRuns}><ReviewIcon name="previous" /></IconButton>
        ) : null}
        <button type="button" className="crumb-link" onClick={onRuns}>study</button>
        <span className="sep">/</span>
        <span className="trunc" title={`${data.run.scenario.title} · ${data.run.runId}`}>{data.run.scenario.title}</span>
        <span className="sep">/</span>
        {selected ? (
          <span className="here" title={selectedName ?? ""}>{selectedName}</span>
        ) : (
          <span className="here">{comparison ? "comparison" : "participants"}</span>
        )}
      </nav>
      <div className="right">
        {reviewControl}
        {selected ? (
          <span className="pager">
            <IconButton label="Previous participant" onClick={() => onStep(-1)}><ReviewIcon name="previous" /></IconButton>
            <span className="pager-word">participant </span>{index + 1} / {data.streams.length}
            <IconButton label="Next participant" onClick={() => onStep(1)}><ReviewIcon name="next" /></IconButton>
          </span>
        ) : !comparison ? (
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
        ) : null}
        {data.publicSafety.share ? (
          // An exported file carries what verify said at export time (#584); the chip says that.
          <span
            className={`chip chip-dot ${data.publicSafety.share.status === "share_ready" ? "" : "chip-mute"}`}
            title={`verified ${data.publicSafety.share.verifiedAt}${data.publicSafety.share.reasons.length > 0 ? `: ${data.publicSafety.share.reasons.join(", ")}` : ""}`}
          >
            {{ share_ready: "Share-ready", local_only: "Local only", blocked: "Sharing blocked" }[data.publicSafety.share.status]}
          </span>
        ) : data.publicSafety.publishable === false ? (
          <span className="chip chip-dot chip-mute" title={data.publicSafety.note}>Local only</span>
        ) : null}
      </div>
    </div>
  );
}

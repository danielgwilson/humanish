import { useEffect, useRef, useState, type ReactNode } from "react";
import { isServedOrigin, liveEmbedUrl } from "@/lib/live";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import type { GridDensity } from "@/lib/preferences";
import { participantLabels } from "@/lib/participant-label";
import { ParticipantCard } from "./participant-card";
import { gridMoment, type GridRecording } from "@/lib/grid-recording";
import { usePinReorder } from "@/lib/use-pin-reorder";

export function buildTally(data: ObserverData): string {
  const parts = [data.run.participantsLine ?? `${data.summary.streams} participant${data.summary.streams === 1 ? "" : "s"}`];
  if (data.run.tasksLine) parts.push(data.run.tasksLine);
  if (data.summary.blocked > 0) parts.push(`${data.summary.blocked} need attention`);
  if (data.run.mode === "dry-run") parts.push("dry run");
  if (data.cost && typeof data.cost.estimatedTotalUsd === "number") {
    const estimate = `est. ~$${data.cost.estimatedTotalUsd.toFixed(2)}`;
    parts.push(`Participants + desktops: ${data.cost.fullyEstimated === false ? `known cost ${estimate}; total unknown` : estimate} (rates as of ${data.cost.ratesAsOf}${data.cost.placeholder ? ", placeholder" : ""})`);
  }
  else if (data.cost) parts.push("Participants + desktops: cost not estimated");
  return parts.join(" · ");
}

const PAGE_SIZE = 36;
export function StudyGrid({ data, streams, onOpen, density = "comfortable", pinnedIds = [], compareIds = [], onPin, onCompare, now, updating = true, reviewOutcomes, tools, recording, atMs, reviewing, page, onPageChange }: {
  tools?: ReactNode;
  reviewOutcomes?: { streamId: string; label: string }[] | undefined;
  data: ObserverData; streams: ObserverStream[]; onOpen: (id: string) => void;
  recording: GridRecording; atMs: number | null; reviewing: boolean;
  page: number; onPageChange: (page: number) => void;
  density?: GridDensity; pinnedIds?: string[]; compareIds?: string[];
  onPin?: (id: string) => void; onCompare?: (id: string) => void; now?: number; updating?: boolean;
}) {
  const labels = participantLabels(data.streams);
  const [priorityId, setPriorityId] = useState<string | null>(null);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const grid = useRef<HTMLDivElement>(null);
  const pageCount = Math.max(1, Math.ceil(streams.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  // Pinning changes order only after a deliberate user action, never on status updates.
  const ordered = [...streams].sort((a, b) => Number(pinnedIds.includes(b.id)) - Number(pinnedIds.includes(a.id)));
  const shown = ordered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const shownKey = JSON.stringify(shown.map((s) => s.id));
  const pinWithMotion = usePinReorder(grid, JSON.stringify([shownKey, pinnedIds]), onPin);
  useEffect(() => {
    const cards = grid.current?.querySelectorAll<HTMLElement>("[data-stream-id] .thumb");
    if (!cards) return;
    if (typeof IntersectionObserver === "undefined") { setVisibleIds(shown.map((s) => s.id)); return; }
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.closest<HTMLElement>("[data-stream-id]")?.dataset.streamId;
        if (id) { if (entry.isIntersecting) visible.set(id, entry.intersectionRatio); else visible.delete(id); }
      }
      setVisibleIds([...visible].sort((a, b) => b[1] - a[1]).map(([id]) => id));
    }, { root: grid.current?.closest(".content") ?? null, rootMargin: "0px", threshold: [0, .1, .25, .5, .75, 1] });
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
    // The ids are the structural dependency; poll snapshots do not reconnect streams.
  }, [shownKey]);
  const liveThumbIds = new Set(!reviewing && updating && isServedOrigin(window.location.protocol)
    ? [...visibleIds].sort((a, b) => Number(b === priorityId) - Number(a === priorityId)).filter((id) => shown.some((s) => s.id === id && liveEmbedUrl(s) !== null)).slice(0, 4) : []);
  return <section aria-label="Study grid"><h2 className="sr-only">Study participants</h2>
    <div className="grid-summary"><p className="countline">{reviewOutcomes ? `Analyzed outcomes: ${[...new Set(reviewOutcomes.map((outcome) => outcome.label))].map((label) => `${reviewOutcomes.filter((outcome) => outcome.label === label).length}/${data.streams.length} ${label}`).join(" · ")}` : buildTally(data)}</p>{tools}</div>
    {streams.length === 0 ? <p className="countline">No participants match the current filters.</p>
      : <div className={`gallery density-${density}`} ref={grid}
        onPointerOver={(event) => { const id = (event.target as Element).closest<HTMLElement>("[data-stream-id]")?.dataset.streamId; if (id) setPriorityId(id); }}
        onFocusCapture={(event) => { const id = event.target.closest<HTMLElement>("[data-stream-id]")?.dataset.streamId; if (id) setPriorityId(id); }}
      >{shown.map((stream) => <ParticipantCard key={stream.id} stream={stream} name={labels.get(stream.id) ?? stream.label} onOpen={onOpen}
        replay={reviewing ? gridMoment(recording, stream.id, atMs ?? Number.NaN) : undefined}
        reviewOutcome={reviewOutcomes?.find((outcome) => outcome.streamId === stream.id)?.label} updating={updating} liveThumb={liveThumbIds.has(stream.id)} pinned={pinnedIds.includes(stream.id)} compared={compareIds.includes(stream.id)} comparisonFull={compareIds.length >= 3} onPin={pinWithMotion} onCompare={onCompare} now={now} />)}</div>}
    {pageCount > 1 ? <nav className="grid-pages" aria-label="Participant pages"><button type="button" disabled={currentPage === 0} onClick={() => onPageChange(currentPage - 1)}>Previous page</button>
      <span>Showing {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, streams.length)} of {streams.length} participants</span>
      <button type="button" disabled={currentPage === pageCount - 1} onClick={() => onPageChange(currentPage + 1)}>Next page</button></nav> : null}
  </section>;
}

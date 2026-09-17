import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isActiveStream, isServedOrigin, liveEmbedUrl } from "@/lib/live";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import type { GridDensity } from "@/lib/preferences";
import { participantLabels } from "@/lib/participant-label";
import { ParticipantCard } from "./participant-card";
import { buildGridRecording, clampGridTime, gridMoment } from "@/lib/grid-recording";
import { StudyPlayback, type GridReviewState } from "./study-playback";
import "@/styles/study-playback.css";

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
export function StudyGrid({ data, streams, onOpen, density = "comfortable", pinnedIds = [], compareIds = [], onPin, onCompare, now, updating = true, reviewOutcomes, tools, initialReview, onReviewChange }: {
  tools?: ReactNode;
  reviewOutcomes?: { streamId: string; label: string }[] | undefined;
  data: ObserverData; streams: ObserverStream[]; onOpen: (id: string, frame?: number | null, mode?: "replay") => void;
  initialReview?: GridReviewState | undefined; onReviewChange?: ((state: GridReviewState) => void) | undefined;
  density?: GridDensity; pinnedIds?: string[]; compareIds?: string[];
  onPin?: (id: string) => void; onCompare?: (id: string) => void; now?: number; updating?: boolean;
}) {
  const labels = participantLabels(data.streams);
  const [review, setReview] = useState<GridReviewState>(() => initialReview ?? { atMs: null, reviewing: false, speed: 1, page: 0 });
  const [playing, setPlaying] = useState(false);
  const recording = useMemo(() => buildGridRecording(data.streams), [data.streams]);
  const recordingRef = useRef(recording); recordingRef.current = recording;
  // A refreshed bundle can remove captures. Preserve an explicitly reviewed
  // instant rather than silently moving it to a later available image.
  const atMs = review.reviewing && review.atMs !== null && Number.isFinite(review.atMs)
    ? review.atMs : clampGridTime(recording, review.atMs ?? recording.endMs ?? 0);
  const cursorUnavailable = review.reviewing && atMs !== null && (recording.startMs === null || recording.endMs === null || atMs < recording.startMs || atMs > recording.endMs);
  const page = review.page;
  const setPage = (page: number) => setReview((previous) => ({ ...previous, page }));
  const canFollow = updating && isServedOrigin(window.location.protocol) && data.streams.some(isActiveStream);
  useEffect(() => { onReviewChange?.(review); }, [review, onReviewChange]);
  useEffect(() => {
    if (!playing) return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const current = performance.now(); const delta = (current - previous) * review.speed; previous = current;
      setReview((value) => {
        const currentRecording = recordingRef.current;
        if (value.atMs !== null && (currentRecording.startMs === null || currentRecording.endMs === null || value.atMs < currentRecording.startMs || value.atMs > currentRecording.endMs)) return value;
        return { ...value, atMs: clampGridTime(currentRecording, (value.atMs ?? currentRecording.startMs ?? 0) + delta) };
      });
    }, 100);
    const hide = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", hide);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", hide); };
  }, [playing, review.speed]);
  useEffect(() => { if (playing && (cursorUnavailable || atMs === null || atMs >= (recording.endMs ?? 0))) setPlaying(false); }, [playing, atMs, recording.endMs, cursorUnavailable]);
  const seek = (at: number) => { setPlaying(false); setReview((value) => ({ ...value, reviewing: true, atMs: clampGridTime(recording, at) })); };
  const togglePlay = () => {
    if (playing) { setPlaying(false); return; }
    const { startMs, endMs } = recording;
    if (cursorUnavailable || startMs === null || endMs === null || startMs === endMs) return;
    setReview((value) => ({ ...value, reviewing: true, atMs: !value.reviewing || atMs === null || atMs >= endMs ? startMs : atMs }));
    setPlaying(true);
  };
  const open = (id: string) => {
    setPlaying(false); onReviewChange?.(review);
    const moment = review.reviewing && atMs !== null ? gridMoment(recording, id, atMs) : null;
    const frame = moment?.kind === "capture" ? moment.frame.index : review.reviewing && recording.lanes.get(id)?.model ? 0 : null;
    // An empty recorded lane still carries replay intent. A null frame alone
    // would make a running participant follow its live desktop instead.
    if (review.reviewing && frame === null) onOpen(id, null, "replay");
    else onOpen(id, frame);
  };
  const [priorityId, setPriorityId] = useState<string | null>(null);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const grid = useRef<HTMLDivElement>(null);
  const pageCount = Math.max(1, Math.ceil(streams.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  // Pinning changes order only after a deliberate user action, never on status updates.
  const ordered = [...streams].sort((a, b) => Number(pinnedIds.includes(b.id)) - Number(pinnedIds.includes(a.id)));
  const shown = ordered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const shownKey = JSON.stringify(shown.map((s) => s.id));
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
  const liveThumbIds = new Set(!review.reviewing && updating && isServedOrigin(window.location.protocol)
    ? [...visibleIds].sort((a, b) => Number(b === priorityId) - Number(a === priorityId)).filter((id) => shown.some((s) => s.id === id && liveEmbedUrl(s) !== null)).slice(0, 4) : []);
  return <section aria-label="Study grid"><h2 className="sr-only">Study participants</h2>
    <div className="grid-summary"><p className="countline">{reviewOutcomes ? `Analyzed outcomes: ${[...new Set(reviewOutcomes.map((outcome) => outcome.label))].map((label) => `${reviewOutcomes.filter((outcome) => outcome.label === label).length}/${data.streams.length} ${label}`).join(" · ")}` : buildTally(data)}</p>{tools}</div>
    <StudyPlayback recording={recording} atMs={atMs} reviewing={review.reviewing} playing={playing} speed={review.speed} canFollow={canFollow}
      onToggle={togglePlay} onSeek={seek} onSpeed={(speed) => setReview((value) => ({ ...value, speed }))}
      onLatest={() => { setPlaying(false); setReview((value) => ({ ...value, reviewing: false, atMs: null })); }} />
    {streams.length === 0 ? <p className="countline">No participants match the current filters.</p>
      : <div className={`gallery density-${density}`} ref={grid}
        onPointerOver={(event) => { const id = (event.target as Element).closest<HTMLElement>("[data-stream-id]")?.dataset.streamId; if (id) setPriorityId(id); }}
        onFocusCapture={(event) => { const id = event.target.closest<HTMLElement>("[data-stream-id]")?.dataset.streamId; if (id) setPriorityId(id); }}
      >{shown.map((stream) => <ParticipantCard key={stream.id} stream={stream} name={labels.get(stream.id) ?? stream.label} onOpen={open}
        replay={review.reviewing ? gridMoment(recording, stream.id, atMs ?? Number.NaN) : undefined}
        reviewOutcome={reviewOutcomes?.find((outcome) => outcome.streamId === stream.id)?.label} updating={updating} liveThumb={liveThumbIds.has(stream.id)} pinned={pinnedIds.includes(stream.id)} compared={compareIds.includes(stream.id)} comparisonFull={compareIds.length >= 3} onPin={onPin} onCompare={onCompare} now={now} />)}</div>}
    {pageCount > 1 ? <nav className="grid-pages" aria-label="Participant pages"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous page</button>
      <span>Showing {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, streams.length)} of {streams.length} participants</span>
      <button type="button" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next page</button></nav> : null}
  </section>;
}

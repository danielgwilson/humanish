import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import { Select } from "./ui/select";
import { Checkbox } from "./ui/checkbox";
import { PlayerRunNotices } from "./player-run-notices";
import type { ObserverStream } from "@/lib/observer-data";
import {
  boundedWindow,
  groupPlayerRows,
  isActionRow,
  isFindingRow,
  rowElapsedMs,
  type PlayerModel,
  type PlayerRow,
  type PlayerRowGroup,
} from "@/lib/player-model";
import type { PlayerPlayback } from "@/lib/use-player-playback";
import { formatRunTime } from "../../src/run/run-clock.js";

const FEED_LIMIT = 100;
type FeedFilter = "all" | "actions" | "thoughts" | "findings";
/** What the activity list shows: which entries, waits grouped or not, and reported thinking. */
export interface ActivitySettings {
  filter: FeedFilter;
  groupWaits: boolean;
  showThoughts: boolean;
}
export const DEFAULT_ACTIVITY: ActivitySettings = {
  filter: "all",
  groupWaits: true,
  showThoughts: true,
};
const FILTER_OPTIONS = [
  { value: "all", label: "All evidence" },
  { value: "actions", label: "Actions" },
  { value: "thoughts", label: "Reported thinking" },
  { value: "findings", label: "Warnings & findings" },
];

// Text-only rendering of the participant's reported narration, never HTML/markdown links.
function renderThoughtText(text: string): (string | { bold: string })[] {
  const parts: (string | { bold: string })[] = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ bold: match[1] ?? "" });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * The Actions panel: the recorded entries filtered and with consecutive waits grouped, at most
 * 100 at a time around the selection unless the reviewer pages away (`page`), and the run notices
 * under Warnings & findings. While it follows the selection, the selected row stays in view.
 */
export function PlayerActivity({
  model,
  stream,
  playback,
  settings,
  onSettings,
  page,
  onPage,
}: {
  model: PlayerModel;
  stream: ObserverStream;
  playback: PlayerPlayback;
  settings: ActivitySettings;
  onSettings: Dispatch<SetStateAction<ActivitySettings>>;
  page: number | null;
  onPage: (page: number | null) => void;
}) {
  const { filter, groupWaits, showThoughts } = settings;
  const { frame, selectedRow, eventId } = playback;
  const ref = useRef<HTMLDivElement>(null);
  const filteredRows = useMemo(
    () =>
      model.rows.filter((row) => {
        if (filter === "all" && !showThoughts && row.kind === "reasoning") return false;
        return (
          filter === "all" ||
          (filter === "thoughts" && row.kind === "reasoning") ||
          (filter === "actions" && isActionRow(row)) ||
          (filter === "findings" && isFindingRow(row))
        );
      }),
    [model.rows, filter, showThoughts],
  );
  const runNotices = useMemo(
    () => stream.timeline.filter((event) => event.level === "warn" || event.level === "error"),
    [stream.timeline],
  );
  const groups = useMemo(
    () => groupPlayerRows(filteredRows, groupWaits),
    [filteredRows, groupWaits],
  );
  const positions = playback.rows.positions;
  const selectedPosition = selectedRow ? positions.get(selectedRow.id) : undefined;
  const groupSelected = (first: PlayerRow, last: PlayerRow) =>
    selectedPosition !== undefined &&
    selectedPosition >= (positions.get(first.id) ?? -1) &&
    selectedPosition <= (positions.get(last.id) ?? -1);
  const activeGroup = Math.max(
    0,
    groups.findIndex((group) =>
      selectedRow
        ? groupSelected(group.first, group.last)
        : group.first.frameIndex <= frame && group.last.frameIndex >= frame,
    ),
  );
  const shown = boundedWindow(groups.length, page ?? activeGroup, FEED_LIMIT);
  const marker = selectedRow ? "[data-selected]" : "[data-on]";
  useEffect(() => {
    // Scroll only while following the selection, and only as far as it takes to show its row.
    const pane = ref.current;
    const row = pane?.querySelector(marker);
    if (page !== null || !pane || !(row instanceof HTMLElement)) return;
    const p = pane.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < p.top) pane.scrollTop += r.top - p.top;
    else if (r.bottom > p.bottom) pane.scrollTop += r.bottom - p.bottom;
  }, [frame, page, selectedRow?.id, marker]);
  const setGroupWaits = (value: boolean) =>
    onSettings((current) => ({ ...current, groupWaits: value }));
  const setShowThoughts = (value: boolean) =>
    onSettings((current) => ({ ...current, showThoughts: value }));
  const mark = (row: PlayerRow, last: PlayerRow) =>
    selectedRow
      ? groupSelected(row, last)
        ? ("selected" as const)
        : undefined
      : !eventId && row.frameIndex <= frame && last.frameIndex >= frame
        ? ("on" as const)
        : undefined;
  return (
    <>
      <div className="feed-controls">
        <label>
          Show{" "}
          <Select
            label="Filter activity"
            value={filter}
            onValueChange={(value) => {
              onSettings((current) => ({ ...current, filter: value as FeedFilter }));
              onPage(null);
            }}
            options={FILTER_OPTIONS}
          />
        </label>
        <label>
          <Checkbox checked={groupWaits} onCheckedChange={setGroupWaits} /> Group waits
        </label>
        {filter === "all" ? (
          <label>
            <Checkbox checked={showThoughts} onCheckedChange={setShowThoughts} /> Thinking
          </label>
        ) : null}
      </div>
      <div className="ipanel acts" ref={ref}>
        {groups.length === 0 && !(filter === "findings" && runNotices.length > 0) ? (
          <p className="feed-empty">No recorded entries match this filter.</p>
        ) : null}
        {shown.start > 0 ? (
          <button
            type="button"
            className="tbtn feed-page"
            onClick={() => onPage(Math.max(0, shown.start - Math.floor(FEED_LIMIT / 2)))}
          >
            Earlier entries
          </button>
        ) : null}
        {groups.slice(shown.start, shown.end).map((group) => (
          <ActivityRow
            key={group.first.id}
            model={model}
            group={group}
            mark={mark(group.first, group.last)}
            onSelect={playback.seekEntry}
          />
        ))}
        {shown.end < groups.length ? (
          <button
            type="button"
            className="tbtn feed-page"
            onClick={() => onPage(shown.end + Math.floor(FEED_LIMIT / 2))}
          >
            Later entries
          </button>
        ) : null}
        {groups.length > FEED_LIMIT ? (
          <p className="feed-window">
            Entries {shown.start + 1}–{shown.end} of {groups.length} · original events retained
          </p>
        ) : null}
        {filter === "findings" && runNotices.length > 0 ? (
          <PlayerRunNotices notices={runNotices} />
        ) : null}
      </div>
    </>
  );
}

/** One entry, or one group of consecutive waits. Reported thinking opens to its full text. */
function ActivityRow({
  model,
  group: { first: row, last, count },
  mark,
  onSelect,
}: {
  model: PlayerModel;
  group: PlayerRowGroup;
  /** `selected` for the selected entry's row; `on` for rows in the current capture interval. */
  mark: "selected" | "on" | undefined;
  onSelect: (row: PlayerRow) => void;
}) {
  const stamp = formatRunTime(rowElapsedMs(model, row));
  const text = row.text || row.title;
  const attrs = {
    "data-entry-id": row.id,
    ...(row.isFrame ? { "data-frame-row": row.frameIndex } : {}),
    ...(mark === "selected"
      ? { "data-on": "", "data-selected": "", "aria-current": "true" as const }
      : mark === "on"
        ? { "data-on": "" }
        : {}),
  };
  return row.kind === "reasoning" ? (
    <details className="thought-detail">
      <summary
        className="arow thought"
        {...attrs}
        title="Reported thinking: the participant's own narration, not ground truth"
        onClick={() => onSelect(row)}
      >
        <span className="tc">{stamp}</span>
        <span className="atext">
          {renderThoughtText(text).map((part, index) =>
            typeof part === "string" ? part : <strong key={index}>{part.bold}</strong>,
          )}
        </span>
      </summary>
      <p className="thought-full">{text}</p>
    </details>
  ) : (
    <button
      type="button"
      className={row.isFrame ? "arow shot" : "arow"}
      {...attrs}
      onClick={() => onSelect(row)}
    >
      <span className="tc">{stamp}</span>
      <span className="atext">
        {count > 1
          ? `${count} recorded waits · ${stamp}–${formatRunTime(rowElapsedMs(model, last))}`
          : `${row.title}${row.text ? `: ${row.text}` : ""}`}
        {row.zoomHref !== undefined ? (
          <img
            className="azoom"
            src={row.zoomHref}
            alt="The region the participant zoomed in on"
            loading="lazy"
            decoding="async"
          />
        ) : null}
      </span>
    </button>
  );
}

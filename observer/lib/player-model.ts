import { screenshotHref, traceItems } from "./artifact-href";
import type { ObserverStream } from "./observer-data";

// The player's view of a lane: the recorded screenshots as an ordered frame timeline,
// and every trace item as a feed row associated with the frame it happened on. Items
// arrive in recorded order; an action belongs to the most recent screenshot before it
// (frame 0 for anything before the first screenshot).
//
export interface PlayerFrame {
  /** Recording stamp in epoch ms, when the capture stamped this frame (#441). */
  atMs?: number;
  index: number;
  itemId: string;
  title: string;
  href: string;
  redaction?: string;
}

export interface PlayerRow {
  id: string;
  kind: string;
  title: string;
  text?: string;
  frameIndex: number;
  /** Set when this row IS a frame (clicking it seeks exactly; frames highlight). */
  isFrame: boolean;
  atMs?: number;
  coord?: { x: number; y: number };
}

export interface PlayerModel {
  frames: PlayerFrame[];
  rows: PlayerRow[];
  /** Average ms per frame at 1× — durationMs spread over the frame count. */
  avgFrameMs: number;
  /** "recorded" when every frame carries an `at` stamp (#441) so playback can run at the
   *  participant's real pace; "avg" for older bundles, and the transport says which. */
  paced: "recorded" | "avg";
}

const CLICK_COORD = /^(?:double[- ])?click \((\d+),\s*(\d+)\)/;

export function parseClickCoord(title: string): { x: number; y: number } | null {
  const match = CLICK_COORD.exec(title);
  if (!match || match[1] === undefined || match[2] === undefined) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

export function buildPlayerModel(stream: ObserverStream): PlayerModel | null {
  const items = traceItems(stream);
  const frames: PlayerFrame[] = [];
  const rows: PlayerRow[] = [];

  for (const item of items) {
    if (item.kind === "screenshot" && item.screenshotRef) {
      const href = screenshotHref(item.screenshotRef.path);
      if (href !== null) {
        const atMs = item.at === undefined ? Number.NaN : Date.parse(item.at);
        frames.push({
          index: frames.length,
          itemId: item.id,
          title: item.title,
          href,
          redaction: item.screenshotRef.redaction,
          ...(Number.isFinite(atMs) ? { atMs } : {})
        });
        rows.push({ id: item.id, kind: item.kind, title: item.title, frameIndex: frames.length - 1, isFrame: true, ...(Number.isFinite(atMs) ? { atMs } : {}) });
        continue;
      }
    }
    // Recorded structured coordinates (#441) are the source of truth; the title
    // re-parse stays as the fallback for bundles captured before they existed.
    const coord = item.coord ?? (item.kind === "ui_action" ? parseClickCoord(item.title) : null);
    rows.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      ...(item.text !== undefined ? { text: item.text } : {}),
      frameIndex: Math.max(0, frames.length - 1),
      isFrame: false,
      ...(item.at !== undefined && Number.isFinite(Date.parse(item.at)) ? { atMs: Date.parse(item.at) } : {}),
      ...(coord !== null ? { coord } : {})
    });
  }

  if (frames.length === 0) return null;
  const durationMs = stream.actor?.durationMs ?? 0;
  // Recorded pace needs every frame stamped and the stamps non-decreasing; anything
  // else (older bundle, mixed producers, clock skew) falls back to honest averaging.
  const recorded =
    frames.length > 1
    && frames.every((frame) => frame.atMs !== undefined)
    && frames.every((frame, index) => index === 0 || (frame.atMs ?? 0) >= (frames[index - 1]?.atMs ?? 0));
  return {
    frames,
    rows,
    avgFrameMs: durationMs > 0 ? durationMs / frames.length : 1500,
    paced: recorded ? "recorded" : "avg"
  };
}

/** Time this frame holds on screen at 1× under recorded pacing (until the next stamp). */
export function frameHoldMs(model: PlayerModel, index: number): number {
  if (model.paced !== "recorded") return model.avgFrameMs;
  const current = model.frames[index]?.atMs;
  const next = model.frames[index + 1]?.atMs;
  if (current === undefined || next === undefined) return model.avgFrameMs;
  return Math.max(0, next - current);
}

/** Original evidence time, never the speed-adjusted/compressed playback clock. */
export function frameElapsedMs(model: PlayerModel, index: number): number {
  const first = model.frames[0]?.atMs;
  const current = model.frames[index]?.atMs;
  return model.paced === "recorded" && first !== undefined && current !== undefined
    ? Math.max(0, current - first)
    : Math.max(0, index) * model.avgFrameMs;
}

/** Last captured frame at/before a moment. No interpolation of missing images. */
export function frameAtElapsedMs(model: PlayerModel, elapsedMs: number): number {
  let low = 0;
  let high = model.frames.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (frameElapsedMs(model, mid) <= elapsedMs) low = mid;
    else high = mid - 1;
  }
  return Math.max(0, low);
}

export function isWaitRow(row: PlayerRow): boolean {
  return row.kind === "ui_action" && /^wait(?:\s|$)/i.test(row.title);
}

export function isActionRow(row: PlayerRow): boolean {
  return !row.isFrame && row.kind !== "reasoning" && !isWaitRow(row)
    && row.kind !== "warning" && row.kind !== "error" && row.kind !== "finding";
}

/** Explicit evidence categories only; ordinary prose is never inferred to be a finding. */
export function isFindingRow(row: PlayerRow): boolean {
  return row.kind === "finding" || row.kind === "warning" || row.kind === "error";
}

export interface PlayerRowGroup {
  first: PlayerRow;
  last: PlayerRow;
  count: number;
}

/** Collapse consecutive waits in the projection while preserving every source row. */
export function groupPlayerRows(rows: readonly PlayerRow[], groupWaits = true): PlayerRowGroup[] {
  const groups: PlayerRowGroup[] = [];
  for (const row of rows) {
    const previous = groups.at(-1);
    if (groupWaits && isWaitRow(row) && previous && isWaitRow(previous.first)) {
      previous.last = row;
      previous.count += 1;
    } else groups.push({ first: row, last: row, count: 1 });
  }
  return groups;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

/** Index window for bounded interactive DOM; every item remains reachable. */
export function boundedWindow(length: number, center: number, limit: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(Math.max(0, length - limit), center - Math.floor(limit / 2)));
  return { start, end: Math.min(length, start + limit) };
}

/** A trace event can occur between screenshots; preserve its own recorded time. */
export function rowElapsedMs(model: PlayerModel, row: PlayerRow): number {
  const start = model.frames[0]?.atMs;
  return model.paced === "recorded" && start !== undefined && row.atMs !== undefined
    ? Math.max(0, row.atMs - start)
    : frameElapsedMs(model, row.frameIndex);
}

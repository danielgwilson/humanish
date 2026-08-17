import { runArtifactHref, traceItems } from "./artifact-href";
import type { ObserverStream } from "./observer-data";

// The player's view of a lane: the recorded screenshots as an ordered frame timeline,
// and every trace item as a feed row associated with the frame it happened on. Items
// arrive in recorded order; an action belongs to the most recent screenshot before it
// (frame 0 for anything before the first screenshot).
//
// Two honest degradations until the capture side records structured fields (#426
// follow-up): click coordinates are parsed from recorded action titles of the form
// "click (700, 420)" — presentation-only parsing of evidence text, never invented —
// and playback paces frames at the lane's AVERAGE rate (durationMs / frames) because
// per-item timestamps do not exist anywhere in the trace yet. The transport labels
// itself avg-paced so nobody mistakes it for real timing; pauses become data the day
// timestamps land.

export interface PlayerFrame {
  index: number;
  itemId: string;
  title: string;
  href: string;
}

export interface PlayerRow {
  id: string;
  kind: string;
  title: string;
  text?: string;
  frameIndex: number;
  /** Set when this row IS a frame (clicking it seeks exactly; frames highlight). */
  isFrame: boolean;
  coord?: { x: number; y: number };
}

export interface PlayerModel {
  frames: PlayerFrame[];
  rows: PlayerRow[];
  /** Average ms per frame at 1× — durationMs spread over the frame count. */
  avgFrameMs: number;
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
      const href = runArtifactHref(item.screenshotRef.path);
      if (href !== null) {
        frames.push({ index: frames.length, itemId: item.id, title: item.title, href });
        rows.push({ id: item.id, kind: item.kind, title: item.title, frameIndex: frames.length - 1, isFrame: true });
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
      ...(coord !== null ? { coord } : {})
    });
  }

  if (frames.length === 0) return null;
  const durationMs = stream.actor?.durationMs ?? 0;
  return {
    frames,
    rows,
    avgFrameMs: durationMs > 0 ? durationMs / frames.length : 1500
  };
}
